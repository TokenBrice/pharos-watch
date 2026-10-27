import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { buildInClause, chunkArray } from "../../../lib/db";
import {
  resolveTelegramPresetTargets,
  type TelegramPresetId,
  type TelegramPresetResolveOptions,
} from "../../../telegram/common/presets";

/** Families the roll-up reports. Presets carry only safety and DEWS. */
const ROLLUP_FAMILIES = ["safety", "dews", "freeze", "reserve"] as const;
export type RollupFamily = (typeof ROLLUP_FAMILIES)[number];
const PRESET_FAMILIES = new Set<RollupFamily>(["safety", "dews"]);

/** What a chat follows per family: explicit coins, or every coin (global opt-in). */
export interface ChatRollupCoverage {
  coins: Record<RollupFamily, Set<string>>;
  global: Record<RollupFamily, boolean>;
  /** Coins disabled (explicit per-coin off) or snoozed; excluded even under a global opt-in. */
  excluded: Record<RollupFamily, Set<string>>;
}

interface SubscriberGlobalsRow {
  chat_id: string;
  global_alert_safety: number;
  global_alert_dews: number;
  global_alert_freeze: number;
  global_alert_reserve: number;
}

type SubscriptionRow = { chat_id: string; stablecoin_id: string; alert_snooze_until_ts: number | null } &
  Record<string, number | string | null>;

interface PresetRow {
  chat_id: string;
  preset_id: string;
  alert_safety: number;
  alert_dews: number;
}

function emptyCoverage(): ChatRollupCoverage {
  const sets = () => ({ safety: new Set<string>(), dews: new Set<string>(), freeze: new Set<string>(), reserve: new Set<string>() });
  return { coins: sets(), excluded: sets(), global: { safety: false, dews: false, freeze: false, reserve: false } };
}

export function coversCoin(coverage: ChatRollupCoverage, family: RollupFamily, stablecoinId: string): boolean {
  if (coverage.excluded[family].has(stablecoinId)) return false;
  return coverage.global[family] || coverage.coins[family].has(stablecoinId);
}

/**
 * Follow coverage for the given chats, mirroring live routing: a direct row
 * that enables a family covers the coin; an explicit per-coin off or an active
 * per-coin snooze excludes it even under a preset or global opt-in; presets
 * (safety, DEWS) cover their current members. Preset resolution fails closed:
 * `null` means the roll-up must wait for the next run, never an empty audience.
 */
export async function loadRollupCoverage(
  db: D1Database,
  chatIds: readonly string[],
  nowSec: number,
  options: TelegramPresetResolveOptions = {},
): Promise<Map<string, ChatRollupCoverage> | null> {
  const coverage = new Map<string, ChatRollupCoverage>(chatIds.map((chatId) => [chatId, emptyCoverage()]));
  const presetRows: PresetRow[] = [];
  const familyColumns = ROLLUP_FAMILIES.map((family) => TELEGRAM_ALERT_PERSISTENCE[family]);
  for (const chunk of chunkArray([...coverage.keys()], 90)) {
    const clause = buildInClause(chunk);
    const [subscribers, subscriptions, presets] = await Promise.all([
      db.prepare(
        `SELECT chat_id, global_alert_safety, global_alert_dews, global_alert_freeze, global_alert_reserve
           FROM telegram_subscribers WHERE chat_id IN (${clause.sql})`,
      ).bind(...clause.binds).all<SubscriberGlobalsRow>(),
      db.prepare(
        `SELECT chat_id, stablecoin_id, alert_snooze_until_ts,
                ${familyColumns.map((spec) => `${spec.subscriptionColumn}, ${spec.overrideColumn}`).join(", ")}
           FROM telegram_subscriptions WHERE chat_id IN (${clause.sql})`,
      ).bind(...clause.binds).all<SubscriptionRow>(),
      db.prepare(
        `SELECT chat_id, preset_id, alert_safety, alert_dews
           FROM telegram_preset_subscriptions
          WHERE chat_id IN (${clause.sql}) AND (alert_safety = 1 OR alert_dews = 1)`,
      ).bind(...clause.binds).all<PresetRow>(),
    ]);
    for (const row of subscribers.results ?? []) {
      const chat = coverage.get(row.chat_id);
      if (!chat) continue;
      chat.global.safety = row.global_alert_safety === 1;
      chat.global.dews = row.global_alert_dews === 1;
      chat.global.freeze = row.global_alert_freeze === 1;
      chat.global.reserve = row.global_alert_reserve === 1;
    }
    for (const row of subscriptions.results ?? []) {
      const chat = coverage.get(row.chat_id);
      if (!chat) continue;
      const snoozed = row.alert_snooze_until_ts != null && Number(row.alert_snooze_until_ts) > nowSec;
      for (const family of ROLLUP_FAMILIES) {
        const spec = TELEGRAM_ALERT_PERSISTENCE[family];
        const enabled = Number(row[spec.subscriptionColumn]) === 1;
        const explicitOff = !enabled && Number(row[spec.overrideColumn]) === 1;
        if (snoozed || explicitOff) chat.excluded[family].add(row.stablecoin_id);
        else if (enabled) chat.coins[family].add(row.stablecoin_id);
      }
    }
    presetRows.push(...(presets.results ?? []));
  }

  if (presetRows.length > 0) {
    const presetIds = [...new Set(presetRows.map((row) => row.preset_id as TelegramPresetId))];
    const resolved = await resolveTelegramPresetTargets(db, presetIds, options);
    if (resolved.kind !== "ok") return null;
    const membersByPreset = new Map(resolved.presets.map((preset) => [preset.definition.id as string, preset.stablecoinIds]));
    for (const row of presetRows) {
      const chat = coverage.get(row.chat_id);
      const members = membersByPreset.get(row.preset_id) ?? [];
      if (!chat) continue;
      for (const family of PRESET_FAMILIES) {
        if (Number(row[family === "safety" ? "alert_safety" : "alert_dews"]) !== 1) continue;
        for (const coinId of members) chat.coins[family].add(coinId);
      }
    }
  }
  return coverage;
}
