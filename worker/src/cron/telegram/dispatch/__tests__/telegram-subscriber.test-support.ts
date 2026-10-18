import type { DatabaseSync } from "node:sqlite";
import type { SubscriberRow } from "../dispatch-telegram-routing";

export function makeSubscriberRow(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    chat_id: "123",
    last_active_at: 1_800_000_000,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    global_depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    isGlobal: false,
    ...overrides,
  };
}

type TelegramAlertFamily = "dews" | "depeg" | "safety" | "launch" | "reserve" | "freeze";
type TelegramAlertFlags = Partial<Record<TelegramAlertFamily, boolean>>;

export interface TelegramSubscriberSeed {
  chatId: string;
  createdAt?: number;
  lastActiveAt?: number;
  preferenceGeneration?: number;
  snoozeUntil?: number | null;
  quietHoursEnabled?: boolean;
  quietHoursStartUtc?: number | null;
  quietHoursEndUtc?: number | null;
  timezone?: string | null;
  global?: TelegramAlertFlags;
  direct?: TelegramAlertFlags;
  globalDepegWorseningBpsStep?: number | null;
  consecutiveBlockCount?: number;
  consecutiveBlockFirstAt?: number | null;
}

function alertFlag(flags: TelegramAlertFlags | undefined, family: TelegramAlertFamily): number {
  return flags?.[family] === true ? 1 : 0;
}

export function insertTelegramSubscriber(sqlite: DatabaseSync, input: TelegramSubscriberSeed): void {
  const current = Math.floor(Date.now() / 1000);
  sqlite.prepare(
    `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, preference_generation,
       alert_snooze_until_ts, quiet_hours_enabled, quiet_hours_start_utc,
       quiet_hours_end_utc, timezone, global_alert_dews, global_alert_depeg,
       global_alert_safety, global_alert_launch, global_alert_reserve,
       global_alert_freeze, global_depeg_worsening_bps_step, consecutive_block_count,
       consecutive_block_first_at, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve, alert_freeze
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chatId, input.createdAt ?? current - 1, input.lastActiveAt ?? current,
    input.preferenceGeneration ?? 0, input.snoozeUntil ?? null,
    input.quietHoursEnabled === true ? 1 : 0, input.quietHoursStartUtc ?? null,
    input.quietHoursEndUtc ?? null, input.timezone ?? null,
    alertFlag(input.global, "dews"), alertFlag(input.global, "depeg"),
    alertFlag(input.global, "safety"), alertFlag(input.global, "launch"),
    alertFlag(input.global, "reserve"), alertFlag(input.global, "freeze"),
    input.globalDepegWorseningBpsStep ?? null, input.consecutiveBlockCount ?? 0,
    input.consecutiveBlockFirstAt ?? null, alertFlag(input.direct, "dews"),
    alertFlag(input.direct, "depeg"), alertFlag(input.direct, "safety"),
    alertFlag(input.direct, "launch"), alertFlag(input.direct, "reserve"),
    alertFlag(input.direct, "freeze"),
  );
}
