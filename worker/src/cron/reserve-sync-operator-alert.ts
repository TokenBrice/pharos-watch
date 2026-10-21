import type { ReserveSyncStateRecord } from "../lib/live-reserves/store";
import { getCache, setCache } from "../lib/db-cache";
import { escapeHtml, type TelegramCreds } from "../telegram/delivery/telegram";
import { deliverOperatorAlert } from "./cron-sentinel-rules";

const RESERVE_ALERT_STATE_KEY = "reserve-post-sync-watchdog:operator-state:v1";
const RESERVE_ALERT_SENT_KEY = "reserve-post-sync-watchdog:alert:direct:v1";
export const RESERVE_OPERATOR_ALERT_COOLDOWN_SEC = 30 * 60;
/** Telegram caps a message at 4096 characters; long cohorts are summarized. */
const TELEGRAM_TEXT_BUDGET = 3_900;
const SECTION_LINE_LIMITS = [25, 10, 3, 0] as const;

export type ReserveAlertSection = "coin" | "drift" | "rule";

/**
 * One watched reserve condition. `signature` identifies the failure shape
 * (status plus failure category or warning codes): a coin whose reason changes
 * is re-raised, while a coin that stays degraded for the same reason is quiet.
 */
export interface ReserveAlertCondition {
  section: ReserveAlertSection;
  id: string;
  signature: string;
  line: string;
}

const SECTION_TITLES: Record<ReserveAlertSection, { raised: string; recovered: string }> = {
  coin: { raised: "Reserve sync degraded", recovered: "Reserve sync recovered" },
  drift: { raised: "Collateral drift", recovered: "Collateral drift cleared" },
  rule: { raised: "Reserve watchdog", recovered: "Reserve watchdog cleared" },
};

function conditionKey(condition: Pick<ReserveAlertCondition, "section" | "id">): string {
  return `${condition.section}:${condition.id}`;
}

/** Configured coins whose latest reserve sync is `degraded` or `error`. */
export function buildReserveSyncConditions(
  syncById: ReadonlyMap<string, ReserveSyncStateRecord>,
  configuredIds: readonly string[],
): ReserveAlertCondition[] {
  return configuredIds.flatMap((id): ReserveAlertCondition[] => {
    const sync = syncById.get(id);
    if (!sync || (sync.lastStatus !== "degraded" && sync.lastStatus !== "error")) return [];
    const failureCategory = typeof sync.metadata.failureCategory === "string" ? sync.metadata.failureCategory : null;
    const codes = [...new Set(sync.warnings.map((warning) => warning.code))].sort();
    const reason = sync.lastStatus === "error"
      ? failureCategory ?? "unclassified"
      : codes.join(",") || failureCategory || "unspecified";
    const detail = sync.lastStatus === "error"
      ? sync.lastError
      : sync.warnings.find((warning) => warning.effect === "degraded")?.message ?? sync.warnings[0]?.message ?? null;
    return [{
      section: "coin",
      id,
      signature: `${sync.lastStatus}:${reason}`,
      line: `${id}: ${sync.lastStatus} — ${reason}${detail ? ` (${detail.slice(0, 160)})` : ""}`,
    }];
  });
}

function parseState(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function renderSection(title: string, lines: readonly string[], limit: number): string {
  const shown = lines.slice(0, limit).map((line) => `• ${escapeHtml(line)}`);
  const more = lines.length - shown.length;
  return [`<b>${title}</b>`, ...shown, ...(more > 0 ? [`• +${more} more`] : [])].join("\n");
}

export interface ReserveAlertTransitions {
  raised: string[];
  recovered: string[];
  sent: boolean;
  cooldown: boolean;
  deliveryFailed?: boolean;
}

/**
 * Transition-only operator alert for reserve conditions. State persists only
 * after a delivered message (or when nothing changed), so a transition held
 * by the cooldown, missing creds or a failed send is retried next run.
 */
export async function alertOnReserveTransitions(params: {
  db: D1Database;
  conditions: readonly ReserveAlertCondition[];
  /** Sections whose evidence could not be read this run keep their prior state. */
  unknownSections?: readonly ReserveAlertSection[];
  nowSec: number;
  operatorTelegramCreds: TelegramCreds | null;
  signal?: AbortSignal;
}): Promise<ReserveAlertTransitions> {
  const [stateCache, alertCache] = await Promise.all([
    getCache(params.db, RESERVE_ALERT_STATE_KEY, params.signal),
    getCache(params.db, RESERVE_ALERT_SENT_KEY, params.signal),
  ]);
  const previous = parseState(stateCache?.value);
  const next: Record<string, string> = {};
  const raised: string[] = [];
  const recovered: string[] = [];
  const raisedLines = new Map<ReserveAlertSection, string[]>();
  const recoveredLines = new Map<ReserveAlertSection, string[]>();
  const push = (lines: Map<ReserveAlertSection, string[]>, section: ReserveAlertSection, line: string) => {
    lines.set(section, [...(lines.get(section) ?? []), line]);
  };

  for (const condition of params.conditions) {
    const key = conditionKey(condition);
    next[key] = condition.signature;
    if (previous[key] === condition.signature) continue;
    raised.push(key);
    push(raisedLines, condition.section, condition.line);
  }
  const unknown = new Set(params.unknownSections ?? []);
  for (const [key, signature] of Object.entries(previous)) {
    if (key in next) continue;
    const section = key.slice(0, key.indexOf(":")) as ReserveAlertSection;
    if (unknown.has(section)) {
      next[key] = signature;
      continue;
    }
    recovered.push(key);
    push(recoveredLines, section, key.slice(section.length + 1));
  }

  if (raised.length === 0 && recovered.length === 0) {
    await setCache(params.db, RESERVE_ALERT_STATE_KEY, JSON.stringify(next), params.signal);
    return { raised, recovered, sent: false, cooldown: false };
  }
  const lastAlertAt = Number(alertCache?.value);
  const cooldown = Number.isFinite(lastAlertAt) && params.nowSec - lastAlertAt < RESERVE_OPERATOR_ALERT_COOLDOWN_SEC;
  if (cooldown || !params.operatorTelegramCreds) {
    return { raised, recovered, sent: false, cooldown };
  }

  const render = (limit: number) => `<b>Pharos reserve watchdog</b>\n\n${
    (Object.keys(SECTION_TITLES) as ReserveAlertSection[]).flatMap((section) => [
      raisedLines.has(section) ? renderSection(SECTION_TITLES[section].raised, raisedLines.get(section)!, limit) : null,
      recoveredLines.has(section) ? renderSection(SECTION_TITLES[section].recovered, recoveredLines.get(section)!, limit) : null,
    ]).filter((section): section is string => section != null).join("\n\n")}`;
  const text = SECTION_LINE_LIMITS.map(render).find((candidate) => candidate.length <= TELEGRAM_TEXT_BUDGET)
    ?? render(0);
  const delivery = await deliverOperatorAlert(params.operatorTelegramCreds, text, params.signal);
  if (!delivery.ok) {
    return { raised, recovered, sent: false, cooldown: false, deliveryFailed: true };
  }
  await setCache(params.db, RESERVE_ALERT_STATE_KEY, JSON.stringify(next), params.signal);
  await setCache(params.db, RESERVE_ALERT_SENT_KEY, String(params.nowSec), params.signal);
  return { raised, recovered, sent: true, cooldown: false };
}
