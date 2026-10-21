import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { isValidIanaTimezone, localDateInIanaTimezone } from "@shared/lib/iana-local-time";
import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { escapeHtml } from "../../../telegram/common/html";
import { isQuietHoursActive } from "../../../telegram/common/quiet-hours";
import type { StoredTelegramChange } from "./change-log";

const ROLLUP_POLICY = TELEGRAM_ALERT_POLICY.rollup;

export interface RollupChatSchedule {
  timezone: string | null;
  quietHoursEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  lastRollupLocalDate: string | null;
}

function localHour(nowSec: number, timezone: string): number {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(nowSec * 1000))
    .find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) ? hour : Math.floor((nowSec % 86_400) / 3600);
}

/**
 * A chat's roll-up is due once per local date, from the policy hour onward
 * (chat timezone, UTC when unset or unrecognized), and never inside quiet
 * hours: a quiet morning defers the roll-up to the end of the quiet window.
 */
export function rollupDueLocalDate(schedule: RollupChatSchedule, nowSec: number): string | null {
  const timezone = schedule.timezone && isValidIanaTimezone(schedule.timezone) ? schedule.timezone : "UTC";
  const localDate = localDateInIanaTimezone(nowSec * 1000, timezone);
  if (localDate == null || localDate === schedule.lastRollupLocalDate) return null;
  if (localHour(nowSec, timezone) < ROLLUP_POLICY.localHour) return null;
  if (isQuietHoursActive(nowSec, schedule.quietHoursEnabled, schedule.quietHoursStart, schedule.quietHoursEnd, timezone)) {
    return null;
  }
  return localDate;
}

export type NetRollupChange =
  | { kind: "safety"; stablecoinId: string; symbol: string; from: string; to: string; fromScore: number | null; toScore: number | null }
  | { kind: "dews"; stablecoinId: string; symbol: string; from: string; to: string; score: number }
  | { kind: "freeze"; stablecoinId: string; symbol: string; count: number; knownUsd: number; unpriced: number }
  | { kind: "reserve"; stablecoinId: string; symbol: string };

/**
 * Net change per coin and family over the window: a grade or band that ends
 * where it started is dropped, so flaps cancel. Freezes are counted per coin;
 * reserve drift is listed once per coin. Overflow rows are not coin changes.
 */
export function computeNetRollupChanges(changes: readonly StoredTelegramChange[]): NetRollupChange[] {
  const net = new Map<string, NetRollupChange>();
  for (const change of changes) {
    if (change.kind === "overflow") continue;
    const key = `${change.kind}:${change.stablecoinId}`;
    const existing = net.get(key);
    switch (change.kind) {
      case "safety":
      case "dews": {
        const from = existing && (existing.kind === "safety" || existing.kind === "dews") ? existing.from : change.payload.from;
        net.set(key, change.kind === "safety"
          ? {
              kind: "safety", stablecoinId: change.stablecoinId, symbol: change.payload.symbol, from, to: change.payload.to,
              fromScore: existing?.kind === "safety" ? existing.fromScore : change.payload.fromScore,
              toScore: change.payload.toScore,
            }
          : { kind: "dews", stablecoinId: change.stablecoinId, symbol: change.payload.symbol, from, to: change.payload.to, score: change.payload.score });
        break;
      }
      case "freeze": {
        const prior = existing?.kind === "freeze" ? existing : { kind: "freeze" as const, stablecoinId: change.stablecoinId, symbol: change.payload.symbol, count: 0, knownUsd: 0, unpriced: 0 };
        const amount = change.payload.amountUsdAtEvent;
        net.set(key, {
          ...prior,
          count: prior.count + 1,
          knownUsd: prior.knownUsd + (amount ?? 0),
          unpriced: prior.unpriced + (amount == null ? 1 : 0),
        });
        break;
      }
      case "reserve":
        net.set(key, { kind: "reserve", stablecoinId: change.stablecoinId, symbol: change.payload.symbol });
        break;
    }
  }
  return [...net.values()].filter((change) =>
    (change.kind !== "safety" && change.kind !== "dews") || change.from !== change.to);
}

/**
 * Coins a chat gets only through the global "all stablecoins" safety opt-in
 * are listed only when the grade change moved the score materially; a grade
 * flip on a tiny score move is noise at market scale. Unscored moves stay.
 */
export function isMaterialGlobalSafetyChange(change: NetRollupChange): boolean {
  if (change.kind !== "safety" || change.fromScore == null || change.toScore == null) return true;
  return Math.abs(change.toScore - change.fromScore) >= TELEGRAM_ALERT_POLICY.safety.globalMinScoreDrop;
}

function isSafetyUpgrade(from: string, to: string): boolean {
  const oldRank = getReportCardGradeRank(from);
  const newRank = getReportCardGradeRank(to);
  return oldRank != null && newRank != null && oldRank >= 0 && newRank >= 0 && newRank > oldRank;
}

function isDewsEasing(from: string, to: string): boolean {
  return isThreatBand(from) && isThreatBand(to) && THREAT_BAND_ORDER[to] < THREAT_BAND_ORDER[from];
}

const FAMILY_ORDER = { safety: 0, dews: 1, freeze: 2, reserve: 3 } as const;

const FAMILY_LABEL = {
  safety: "Safety grades",
  dews: "Early-warning stress",
  freeze: "Freezes",
  reserve: "Reserves",
} as const;

function isImprovement(change: NetRollupChange): boolean {
  if (change.kind === "safety") return isSafetyUpgrade(change.from, change.to);
  if (change.kind === "dews") return isDewsEasing(change.from, change.to);
  return false;
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatNetChangeLine(change: NetRollupChange): string {
  const symbol = `<b>${escapeHtml(change.symbol)}</b>`;
  switch (change.kind) {
    case "safety":
      return `${symbol} Safety grade ${isSafetyUpgrade(change.from, change.to) ? "raised" : "downgraded"} ${escapeHtml(change.from)} → ${escapeHtml(change.to)}`;
    case "dews":
      return `${symbol} stress ${isDewsEasing(change.from, change.to) || !isThreatBand(change.to) ? "eased" : "rose"} to ${escapeHtml(change.to)} (${change.score}/100, was ${escapeHtml(change.from)})`;
    case "freeze": {
      const events = `${change.count} freeze event${change.count === 1 ? "" : "s"}`;
      const known = change.knownUsd > 0 ? `, ${formatUsd(change.knownUsd)} known` : "";
      const unpriced = change.unpriced > 0 ? `, ${change.unpriced} without a USD amount` : "";
      return `${symbol} ${events}${known}${unpriced}`;
    }
    case "reserve":
      return `${symbol} reserves no longer match their reviewed profile`;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The daily "Changes" message, or null when there is nothing to say. The
 * first line is the push preview; adverse moves come first, then
 * improvements; the policy line cap folds the rest into "N more changes".
 */
export function formatRollupMessage(input: {
  changes: readonly NetRollupChange[];
  /** Live messages held back by the per-chat cap since the last roll-up. */
  overflowCount: number;
}): string | null {
  const { overflowCount } = input;
  if (input.changes.length === 0 && overflowCount === 0) return null;
  const ordered = [...input.changes].sort((a, b) =>
    Number(isImprovement(a)) - Number(isImprovement(b)) ||
    FAMILY_ORDER[a.kind] - FAMILY_ORDER[b.kind] ||
    a.symbol.localeCompare(b.symbol));
  const listed = ordered.slice(0, ROLLUP_POLICY.maxListedChanges);
  const unlisted = ordered.length - listed.length;

  const headline = listed.length > 0
    ? `<b>Daily changes</b>: ${plural(ordered.length, "change")} on your coins, led by ${formatNetChangeLine(listed[0]!).replace(/<\/?b>/g, "")}`
    : `<b>Daily changes</b>: ${plural(overflowCount, "alert")} held back`;
  const sections: string[] = [headline];
  for (const kind of ["safety", "dews", "freeze", "reserve"] as const) {
    const lines = listed.filter((change) => change.kind === kind).map(formatNetChangeLine);
    if (lines.length > 0) sections.push(`<b>${FAMILY_LABEL[kind]}</b>\n${lines.join("\n")}`);
  }
  const more: string[] = [];
  if (unlisted > 0) more.push(`${plural(unlisted, "more change")} on pharos.watch`);
  if (overflowCount > 0) {
    more.push(`${plural(overflowCount, "more alert")} held back by the limit of ${TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages} live messages a day`);
  }
  if (more.length > 0) sections.push(more.map((line) => `+ ${line}`).join("\n"));
  sections.push("<i>Changes not sent live, once a day · /settings</i>");
  return `${sections.join("\n\n")}\n\n<a href="https://pharos.watch">View on Pharos</a>`;
}
