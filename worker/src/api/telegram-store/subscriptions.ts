import {
  chunkArray,
  D1_MAX_BOUND_PARAMETERS,
  D1_SAFE_IN_CLAUSE_BIND_LIMIT,
  executeAtomicBatch,
} from "../../lib/db";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status";
import type { ResolvedCoin } from "../../lib/telegram/alerts";
import type {
  ParsedSetCommand,
  SubscriptionRow,
} from "../telegram-webhook-shared";
import {
  prepareUpsertSubscriberRow,
  preparePreferenceGenerationBump,
  unixNow,
  type UpsertSubscriberInput,
} from "./subscribers";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "../../lib/telegram/operation-batch";

export type DewsMinBandValue = "ALERT" | "WARNING" | "DANGER" | null;
export type SafetyModeValue = "all" | "downgrade-only" | "upgrade-only" | null;
export type DepegWorseningStepValue = 100 | 250 | 500 | null;

export interface BuiltSubscriptionUpsert {
  sql: string;
  binds: unknown[];
}

const SUBSCRIPTION_FOLLOW_BIND_COUNT = 15;
const SUBSCRIPTION_FOLLOWS_PER_STATEMENT = Math.floor(
  D1_MAX_BOUND_PARAMETERS / SUBSCRIPTION_FOLLOW_BIND_COUNT,
);
const SUBSCRIPTION_STATEMENT_COMPACTION_THRESHOLD = 50;

function bindSubscriptionUpsert(db: D1Database, upsert: BuiltSubscriptionUpsert): D1PreparedStatement {
  return db.prepare(upsert.sql).bind(...upsert.binds);
}

/**
 * Families whose per-coin state is a plain on/off flag — i.e. those with no
 * `settingsColumn` in the alert-type registry. `subscription-registry` test
 * asserts the two stay in step.
 */
export type PlainAlertType = Exclude<TelegramAlertType, "dews" | "depeg" | "safety">;

/** Base columns every per-coin upsert seeds, in canonical column order. */
const SEEDED_ALERT_TYPES = ["dews", "depeg", "safety"] as const;

type UpsertFlag =
  | { kind: "bound"; value: 0 | 1 }
  | { kind: "always-on" };

type UpsertSetting =
  | { kind: "none" }
  | { kind: "null" }
  | { kind: "bound"; value: unknown };

interface SubscriptionUpsertSpec {
  alertType: TelegramAlertType;
  chatId: string;
  stablecoinId: string;
  /** Value written into the family's enablement column. */
  enabled: UpsertFlag;
  /** Value written into the family's tuning column, when it participates. */
  setting: UpsertSetting;
  /**
   * Conflict rule for the tuning column. `clear-when-disabled` is depeg's:
   * turning the family off drops the stored step instead of keeping it.
   */
  settingUpdate?: "excluded" | "clear-when-disabled";
}

/**
 * The one per-coin subscription upsert. Column identities come from the
 * canonical alert-type registry, so adding a family to
 * `TELEGRAM_ALERT_PERSISTENCE` is all it takes for this builder to address it.
 */
function buildSubscriptionAlertUpsert(spec: SubscriptionUpsertSpec): BuiltSubscriptionUpsert {
  const persistence = TELEGRAM_ALERT_PERSISTENCE[spec.alertType];
  const columns = ["chat_id", "stablecoin_id"];
  const values = ["?", "?"];
  const binds: unknown[] = [spec.chatId, spec.stablecoinId];
  const enabledSql = spec.enabled.kind === "bound" ? "?" : "1";

  const pushTargetColumns = (): void => {
    columns.push(persistence.subscriptionColumn, persistence.overrideColumn);
    values.push(enabledSql, "1");
    if (spec.enabled.kind === "bound") binds.push(spec.enabled.value);
  };

  for (const seeded of SEEDED_ALERT_TYPES) {
    if (seeded === spec.alertType) {
      pushTargetColumns();
      continue;
    }
    columns.push(TELEGRAM_ALERT_PERSISTENCE[seeded].subscriptionColumn);
    values.push("0");
  }
  if (!(SEEDED_ALERT_TYPES as readonly TelegramAlertType[]).includes(spec.alertType)) {
    pushTargetColumns();
  }

  const settingsColumn = persistence.settingsColumn;
  if (spec.setting.kind !== "none" && settingsColumn) {
    columns.push(settingsColumn);
    values.push(spec.setting.kind === "null" ? "NULL" : "?");
    if (spec.setting.kind === "bound") binds.push(spec.setting.value);
  }

  const assignments = [
    `${persistence.subscriptionColumn} = ${
      spec.enabled.kind === "bound" ? `excluded.${persistence.subscriptionColumn}` : "1"
    }`,
    `${persistence.overrideColumn} = 1`,
  ];
  if (spec.settingUpdate && settingsColumn) {
    assignments.push(
      spec.settingUpdate === "clear-when-disabled"
        ? `${settingsColumn} = CASE WHEN excluded.${persistence.subscriptionColumn} = 0 THEN NULL ELSE telegram_subscriptions.${settingsColumn} END`
        : `${settingsColumn} = excluded.${settingsColumn}`,
    );
  }

  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        ${columns.join(", ")}
      )
      VALUES (${values.join(", ")})
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        ${assignments.join(",\n        ")}
    `,
    binds,
  };
}

export function buildDewsUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
  minBand: DewsMinBandValue,
): BuiltSubscriptionUpsert {
  return buildSubscriptionAlertUpsert({
    alertType: "dews",
    chatId,
    stablecoinId,
    enabled: { kind: "bound", value: enabled ? 1 : 0 },
    setting: { kind: "bound", value: minBand },
    settingUpdate: "excluded",
  });
}

export function buildSafetyUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
  mode: SafetyModeValue,
): BuiltSubscriptionUpsert {
  return buildSubscriptionAlertUpsert({
    alertType: "safety",
    chatId,
    stablecoinId,
    enabled: { kind: "bound", value: enabled ? 1 : 0 },
    setting: { kind: "bound", value: mode },
    settingUpdate: "excluded",
  });
}

export function buildDepegUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
): BuiltSubscriptionUpsert {
  return buildSubscriptionAlertUpsert({
    alertType: "depeg",
    chatId,
    stablecoinId,
    enabled: { kind: "bound", value: enabled ? 1 : 0 },
    setting: { kind: "null" },
    settingUpdate: "clear-when-disabled",
  });
}

export function buildDepegStepUpsert(
  chatId: string,
  stablecoinId: string,
  step: DepegWorseningStepValue,
): BuiltSubscriptionUpsert {
  return buildSubscriptionAlertUpsert({
    alertType: "depeg",
    chatId,
    stablecoinId,
    enabled: { kind: "always-on" },
    setting: { kind: "bound", value: step },
    settingUpdate: "excluded",
  });
}

/** Replaces the byte-identical launch/reserve/freeze builders. */
export function buildPlainAlertUpsert(
  alertType: PlainAlertType,
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
): BuiltSubscriptionUpsert {
  return buildSubscriptionAlertUpsert({
    alertType,
    chatId,
    stablecoinId,
    enabled: { kind: "bound", value: enabled ? 1 : 0 },
    setting: { kind: "none" },
  });
}

/** The single `/set`-command → per-coin upsert dispatch. */
function buildSetCommandSubscriptionUpsert(
  chatId: string,
  stablecoinId: string,
  command: ParsedSetCommand,
): BuiltSubscriptionUpsert {
  switch (command.setting) {
    case "dews":
      return buildDewsUpsert(chatId, stablecoinId, command.enabled, command.minBand);
    case "safety":
      return buildSafetyUpsert(chatId, stablecoinId, command.enabled, command.mode);
    case "depeg":
      return buildDepegUpsert(chatId, stablecoinId, command.enabled);
    case "depeg-step":
      return buildDepegStepUpsert(chatId, stablecoinId, command.step);
    default:
      return buildPlainAlertUpsert(command.setting, chatId, stablecoinId, command.enabled);
  }
}

export async function loadSubscriptionRowsByChat(
  db: D1Database,
  chatId: string,
): Promise<SubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze, dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
         FROM telegram_subscriptions
        WHERE chat_id = ?
        ORDER BY stablecoin_id`,
    )
    .bind(chatId)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

export function prepareSubscriberAndSubscriptionStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  const now = unixNow();
  // A pending depeg-step write implies the depeg family regardless of whether
  // the caller listed it in `alertTypes`.
  const alertFlags = Object.fromEntries(
    TELEGRAM_ALERT_TYPES.map((alertType) => [alertType, alertTypes.has(alertType) ? 1 : 0]),
  ) as Record<TelegramAlertType, 0 | 1>;
  if (options?.depegWorseningBpsStep !== undefined) alertFlags.depeg = 1;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  const statements: D1PreparedStatement[] = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: { ...alertFlags },
    }),
  ];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  const depegStepColumn = TELEGRAM_ALERT_PERSISTENCE.depeg.settingsColumn;
  const depegStepUpdate =
    options?.depegWorseningBpsStep === undefined
      ? `${depegStepColumn} = telegram_subscriptions.${depegStepColumn}`
      : `${depegStepColumn} = excluded.${depegStepColumn}`;
  const followColumns = [
    "chat_id",
    "stablecoin_id",
    ...TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
    ...TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].overrideColumn),
    depegStepColumn,
  ];
  const followMerges = [
    ...TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
    ...TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].overrideColumn),
  ].map((column) => `${column} = MAX(telegram_subscriptions.${column}, excluded.${column})`);
  const followPlaceholders = `(${followColumns.map(() => "?").join(", ")})`;
  // Compact only large bulk-confirm payloads so every tracked-coin intent fits
  // inside one 100-statement atomic D1 batch.
  const stablecoinIdChunks = uniqueStablecoinIds.length > SUBSCRIPTION_STATEMENT_COMPACTION_THRESHOLD
    ? chunkArray(uniqueStablecoinIds, SUBSCRIPTION_FOLLOWS_PER_STATEMENT)
    : uniqueStablecoinIds.map((stablecoinId) => [stablecoinId]);
  for (const stablecoinIdChunk of stablecoinIdChunks) {
    const binds = stablecoinIdChunk.flatMap((stablecoinId) => [
      chatId,
      stablecoinId,
      ...TELEGRAM_ALERT_TYPES.map((alertType) => alertFlags[alertType]),
      ...TELEGRAM_ALERT_TYPES.map((alertType) => alertFlags[alertType]),
      options?.depegWorseningBpsStep ?? null,
    ]);
    const values = stablecoinIdChunk.map(() => followPlaceholders).join(", ");
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          ${followColumns.join(",\n          ")}
        )
        VALUES ${values}
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          ${followMerges.join(",\n          ")},
          ${depegStepUpdate}
      `).bind(...binds),
    );
  }
  return statements;
}

export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: {
    clearPending?: boolean;
    depegWorseningBpsStep?: 100 | 250 | 500 | null;
    operationStatements?: D1PreparedStatement[];
  },
): Promise<void> {
  const statements = prepareSubscriberAndSubscriptionStatements(
    db,
    chatId,
    username,
    alertTypes,
    stablecoinIds,
    options,
  );
  const atomicStatements = appendTelegramOperationStatements(statements, options);
  if (atomicStatements.length > 0) await executeAtomicBatch(db, atomicStatements);
}

export async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
  options: TelegramOperationBatchOptions & { clearPending?: boolean } = {},
): Promise<void> {
  const now = unixNow();
  // `depeg-step` always implies the depeg family; every other setting bumps its
  // own family only when it is being turned on.
  const perCoinAlertBumps: UpsertSubscriberInput["perCoinAlertBumps"] =
    command.setting === "depeg-step"
      ? { depeg: 1 }
      : command.enabled
        ? { [command.setting]: 1 }
        : {};

  const statements: D1PreparedStatement[] = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps,
    }),
  ];
  if (options.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }

  for (const coin of coins) {
    statements.push(bindSubscriptionUpsert(
      db,
      buildSetCommandSubscriptionUpsert(chatId, coin.id, command),
    ));
  }

  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}

export function validateGlobalSetCommand(command: ParsedSetCommand): string | null {
  if (command.setting === "dews" && command.enabled && command.minBand != null) {
    return "Global DEWS alerts only support the default ALERT threshold. Use /subscribe dews all or /set all dews off; WARNING/DANGER remain per-coin.";
  }
  if (command.setting === "safety" && command.enabled && command.mode != null) {
    return "Global safety alerts support all/off only. Upgrade-only and downgrade-only remain per-coin settings.";
  }
  return null;
}

export async function setGlobalDepegWorseningStep(
  db: D1Database,
  chatId: string,
  username: string | null,
  step: 100 | 250 | 500 | null,
  options: TelegramOperationBatchOptions & { clearPending?: boolean } = {},
): Promise<void> {
  const now = unixNow();
  const statements: D1PreparedStatement[] = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      globalAlertBumps: { depeg: 1 },
    }),
    db.prepare(
      `UPDATE telegram_subscribers
          SET global_depeg_worsening_bps_step = ?,
              last_active_at = ?
        WHERE chat_id = ?`,
    )
      .bind(step, now, chatId),
  ];
  if (options.clearPending) {
    statements.push(db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId));
  }
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}

export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
  options: TelegramOperationBatchOptions & { clearPending?: boolean } = {},
): Promise<void> {
  if (command.setting === "depeg-step") {
    await setGlobalDepegWorseningStep(db, chatId, username, command.step, options);
    return;
  }
  const override: 0 | 1 = command.enabled ? 1 : 0;

  const statements = [prepareUpsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [command.setting]: override },
  })];
  if (options.clearPending) {
    statements.push(db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId));
  }
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}

export function prepareRemoveSubscriptionStatements(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
  options: { touchSubscriber?: boolean } = {},
): D1PreparedStatement[] {
  const deletes = prepareRemoveSubscriptionRowStatements(db, chatId, stablecoinIds);
  if (deletes.length === 0) return [];
  if (options.touchSubscriber === false) return deletes;
  return [
    ...deletes,
    prepareTouchSubscriberStatement(db, chatId),
  ];
}

function prepareRemoveSubscriptionRowStatements(
  db: D1Database,
  chatId: string,
  stablecoinIds: readonly string[],
): D1PreparedStatement[] {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];

  return chunkArray(uniqueIds, D1_SAFE_IN_CLAUSE_BIND_LIMIT - 1).map((idChunk) => {
    const placeholders = idChunk.map(() => "?").join(", ");
    return db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...idChunk);
  });
}

function prepareTouchSubscriberStatement(
  db: D1Database,
  chatId: string,
): D1PreparedStatement {
  return preparePreferenceGenerationBump(db, chatId);
}

export async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const statements = prepareRemoveSubscriptionStatements(db, chatId, stablecoinIds);
  const atomicStatements = appendTelegramOperationStatements(statements, options);
  if (atomicStatements.length === 0) return;
  await executeAtomicBatch(db, atomicStatements);
}

export async function loadSubscriptionsByIds(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<SubscriptionRow[]> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}
