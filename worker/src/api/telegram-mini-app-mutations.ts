import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { nextIanaLocalHourDueAt } from "@shared/lib/iana-local-time";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  type TelegramAlertType,
  type TelegramMiniAppOperation,
  type TelegramMiniAppBulkWatchlistOperation,
  type TelegramMiniAppBulkWatchlistResponse,
  type TelegramMiniAppPortabilityOperation,
  type TelegramMiniAppPortabilityResponse,
} from "@shared/lib/telegram-mini-app-contract";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { executeAtomicBatch } from "../lib/db";
import { isSubscribableCoin } from "../lib/telegram-subscription-eligibility";
import {
  decodeWatchlistToken,
  encodeWatchlistTokenV3,
  packWatchlistDirectState,
  packWatchlistPresetState,
  WATCHLIST_TOKEN_REGISTRY_VERSION,
  type WatchlistTokenDirectState,
  type WatchlistTokenPresetState,
  type WatchlistTokenV2State,
} from "../lib/telegram-watchlist-token";
import type { TelegramMiniAppAuthContext } from "../lib/telegram-mini-app-auth";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../lib/telegram-presets";
import { PAUSE_SENTINEL_TS, SNOOZE_SECONDS } from "../lib/telegram-constants";
import { isValidIanaTimezone } from "../cron/telegram-quiet-hours";
import { DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR } from "./telegram-webhook-settings-shared";
import { prepareCoinSettingStatements } from "./telegram-webhook-settings-mutations";
import {
  clearAlertSnooze,
  forgetSubscriber,
  prepareRemoveSubscriptionStatements,
  prepareSubscriberAndPresetStatements,
  prepareSubscriberAndSubscriptionStatements,
  removePresetSubscriptions,
  setGlobalDepegWorseningStep,
  setSubscriberSnooze,
  setSubscriberTimezone,
  setSubscriptionSnooze,
  unsubscribeAll,
  upsertSubscriberRow,
  unixNow,
  type UpsertSubscriberInput,
} from "./telegram-webhook-store";
import {
  applyWatchlistImportV2,
  applyWatchlistDirectPatch,
  buildWatchlistImportPreview,
  loadWatchlistPortableState,
  type WatchlistImportPreview,
} from "./telegram-store/watchlist-import";
import { loadSubscriberByChat } from "./telegram-store/subscribers";
import { setTelegramRecapPreference } from "../cron/telegram-recap-store";

export type TelegramMiniAppMutationErrorCode =
  | "not-private"
  | "unknown-coin"
  | "unknown-preset"
  | "empty-alert-types"
  | "preset-unavailable"
  | "invalid-coin-patch"
  | "invalid-timezone"
  | "recap-timezone-required"
  | "recap-subscriber-required"
  | "stale-recap-preference"
  | "invalid-portable-token"
  | "empty-portable-state"
  | "stale-import-preview"
  | "stale-bulk-preview";

export class TelegramMiniAppMutationError extends Error {
  readonly code: TelegramMiniAppMutationErrorCode;
  readonly status: number;

  constructor(code: TelegramMiniAppMutationErrorCode, status = 400) {
    super(code);
    this.name = "TelegramMiniAppMutationError";
    this.code = code;
    this.status = status;
  }
}

const DEWS_BAND_TO_CODE = { ALERT: "A", WARNING: "W", DANGER: "D" } as const;
const SAFETY_MODE_TO_CODE = { all: "a", "downgrade-only": "d", "upgrade-only": "u" } as const;
const PORTABLE_DIRECT_ALERT_TYPES = ["dews", "depeg", "safety", "launch", "reserve", "freeze"] as const;
const PORTABLE_PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;

type PortableDirectAlertType = (typeof PORTABLE_DIRECT_ALERT_TYPES)[number];
type PortablePresetAlertType = (typeof PORTABLE_PRESET_ALERT_TYPES)[number];
type BulkUndoOperation = Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "undo-bulk-watchlist" }>;
type BulkUndoRow = BulkUndoOperation["restoreDirectRows"][number];

interface PortablePreview {
  directAdds: string[];
  directRemoves: string[];
  directChanges: string[];
  presetAdds: string[];
  presetRemoves: string[];
  presetChanges: string[];
  directBroadenedCoverage: Array<{ id: string; alertTypes: TelegramAlertType[] }>;
  directRemovedCoverage: Array<{ id: string; alertTypes: TelegramAlertType[] }>;
  presetBroadenedCoverage: Array<{ id: string; alertTypes: PortablePresetAlertType[] }>;
  presetRemovedCoverage: Array<{ id: string; alertTypes: PortablePresetAlertType[] }>;
}

function privateChatId(auth: TelegramMiniAppAuthContext): string {
  if (!auth.canMutatePrivateChat) throw new TelegramMiniAppMutationError("not-private", 403);
  return auth.userId;
}

function assertCoin(stablecoinId: string): void {
  if (!TRACKED_META_BY_ID.has(stablecoinId)) throw new TelegramMiniAppMutationError("unknown-coin");
}

function assertCoinCanSubscribe(stablecoinId: string): void {
  if (!isSubscribableCoin(stablecoinId)) throw new TelegramMiniAppMutationError("unknown-coin");
}

function assertPreset(presetId: string): asserts presetId is TelegramPresetId {
  if (!TELEGRAM_PRESET_LABEL_BY_ID.has(presetId as TelegramPresetId)) {
    throw new TelegramMiniAppMutationError("unknown-preset");
  }
}

function alertTypeSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function alertTypesFromPatch(patch: { dews?: boolean; depeg?: boolean; safety?: boolean }): Set<string> {
  const out = new Set<string>();
  if (patch.dews) out.add("dews");
  if (patch.depeg) out.add("depeg");
  if (patch.safety) out.add("safety");
  if (out.size === 0) throw new TelegramMiniAppMutationError("empty-alert-types");
  return out;
}

function enabledDirectAlertTypes(row: WatchlistTokenDirectState): PortableDirectAlertType[] {
  return PORTABLE_DIRECT_ALERT_TYPES.filter((type) => {
    if (type === "dews") return row.alertDews;
    if (type === "depeg") return row.alertDepeg;
    if (type === "safety") return row.alertSafety;
    if (type === "launch") return row.alertLaunch;
    if (type === "reserve") return row.alertReserve;
    return Boolean(row.alertFreeze);
  });
}

function enabledPresetAlertTypes(row: WatchlistTokenPresetState): PortablePresetAlertType[] {
  return PORTABLE_PRESET_ALERT_TYPES.filter((type) => {
    if (type === "dews") return row.alertDews;
    if (type === "depeg") return row.alertDepeg;
    return row.alertSafety;
  });
}

function coverageDifference<T extends string>(
  current: readonly T[],
  desired: readonly T[],
): { broadened: T[]; removed: T[] } {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    broadened: desired.filter((type) => !currentSet.has(type)),
    removed: current.filter((type) => !desiredSet.has(type)),
  };
}

function buildPortablePreview(current: WatchlistTokenV2State, desired: WatchlistTokenV2State): {
  preview: PortablePreview;
  exactPreview: WatchlistImportPreview;
} {
  const exactPreview = buildWatchlistImportPreview(current, desired);
  const directCurrent = new Map(current.direct.map((row) => [row.stablecoinId, row]));
  const presetCurrent = new Map(current.presets.map((row) => [row.presetId, row]));
  const directBroadenedCoverage: PortablePreview["directBroadenedCoverage"] = [];
  const directRemovedCoverage: PortablePreview["directRemovedCoverage"] = [];
  const presetBroadenedCoverage: PortablePreview["presetBroadenedCoverage"] = [];
  const presetRemovedCoverage: PortablePreview["presetRemovedCoverage"] = [];

  for (const row of desired.direct) {
    const difference = coverageDifference(
      directCurrent.get(row.stablecoinId) ? enabledDirectAlertTypes(directCurrent.get(row.stablecoinId)!) : [],
      enabledDirectAlertTypes(row),
    );
    if (difference.broadened.length > 0) directBroadenedCoverage.push({ id: row.stablecoinId, alertTypes: difference.broadened });
    if (difference.removed.length > 0) directRemovedCoverage.push({ id: row.stablecoinId, alertTypes: difference.removed });
  }
  for (const row of current.direct) {
    if (!desired.direct.some((candidate) => candidate.stablecoinId === row.stablecoinId)) {
      const alertTypes = enabledDirectAlertTypes(row);
      if (alertTypes.length > 0) directRemovedCoverage.push({ id: row.stablecoinId, alertTypes });
    }
  }
  for (const row of desired.presets) {
    const difference = coverageDifference(
      presetCurrent.get(row.presetId) ? enabledPresetAlertTypes(presetCurrent.get(row.presetId)!) : [],
      enabledPresetAlertTypes(row),
    );
    if (difference.broadened.length > 0) presetBroadenedCoverage.push({ id: row.presetId, alertTypes: difference.broadened });
    if (difference.removed.length > 0) presetRemovedCoverage.push({ id: row.presetId, alertTypes: difference.removed });
  }
  for (const row of current.presets) {
    if (!desired.presets.some((candidate) => candidate.presetId === row.presetId)) {
      const alertTypes = enabledPresetAlertTypes(row);
      if (alertTypes.length > 0) presetRemovedCoverage.push({ id: row.presetId, alertTypes });
    }
  }

  return {
    exactPreview,
    preview: {
      directAdds: exactPreview.directAdds,
      directRemoves: exactPreview.directRemoves,
      directChanges: exactPreview.directChanges,
      presetAdds: exactPreview.presetAdds,
      presetRemoves: exactPreview.presetRemoves,
      presetChanges: exactPreview.presetChanges,
      directBroadenedCoverage,
      directRemovedCoverage,
      presetBroadenedCoverage,
      presetRemovedCoverage,
    },
  };
}

function previewFingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `preview-v1-${input.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function importGenerationLease(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return 4_000_000_000_000_000 + value;
}

async function decodedPortableState(token: string): Promise<WatchlistTokenV2State> {
  const decoded = await decodeWatchlistToken(token);
  if (!decoded.ok || (decoded.version !== 2 && decoded.version !== 3)) throw new TelegramMiniAppMutationError("invalid-portable-token");
  const unknownDirect = decoded.state.direct.some((row) => !isSubscribableCoin(row.stablecoinId));
  const unknownPreset = decoded.state.presets.some((row) => !TELEGRAM_PRESET_IDS.includes(row.presetId as never));
  if (unknownDirect || unknownPreset) throw new TelegramMiniAppMutationError("invalid-portable-token");
  return decoded.state;
}

function importFingerprint(
  expectedPreferenceGeneration: number,
  desired: WatchlistTokenV2State,
  exactPreview: WatchlistImportPreview,
): string {
  return previewFingerprint({
    expectedPreferenceGeneration,
    direct: desired.direct.map(packWatchlistDirectState).sort(),
    presets: desired.presets.map(packWatchlistPresetState).sort(),
    exactPreview,
  });
}

function directDefault(stablecoinId: string): WatchlistTokenDirectState {
  return {
    stablecoinId,
    alertDews: true,
    alertDepeg: true,
    alertSafety: false,
    alertLaunch: false,
    alertReserve: false,
    alertFreeze: false,
    overrideDews: true,
    overrideDepeg: true,
    overrideSafety: false,
    overrideLaunch: false,
    overrideReserve: false,
    overrideFreeze: false,
    dewsMinBand: null,
    safetyMode: null,
    depegWorseningBpsStep: null,
  };
}

function bulkPreviewFingerprint(
  expectedPreferenceGeneration: number,
  current: WatchlistTokenV2State,
  adds: readonly string[],
  removes: readonly string[],
): string {
  return previewFingerprint({
    expectedPreferenceGeneration,
    direct: current.direct.map(packWatchlistDirectState).sort(),
    adds: [...adds].sort(),
    removes: [...removes].sort(),
  });
}

function bulkUndoFingerprint(
  expectedPreferenceGeneration: number,
  direct: readonly WatchlistTokenDirectState[],
  restoreRows: readonly BulkUndoRow[],
  removeStablecoinIds: readonly string[],
): string {
  return previewFingerprint({
    expectedPreferenceGeneration,
    direct: direct.map(packWatchlistDirectState).sort(),
    restore: restoreRows.map((row) => ({
      direct: packWatchlistDirectState(fromBulkDirectRow(row)),
      snoozeUntilTs: row.snoozeUntilTs ?? null,
    })).sort((left, right) => left.direct.localeCompare(right.direct)),
    removeStablecoinIds: [...removeStablecoinIds].sort(),
  });
}

function fromBulkDirectRow(row: BulkUndoRow): WatchlistTokenDirectState {
  return {
    ...row,
    alertFreeze: row.alertFreeze ?? false,
    overrideFreeze: row.overrideFreeze ?? false,
  };
}

async function directSnoozesById(
  db: D1Database,
  chatId: string,
  stablecoinIds: readonly string[],
): Promise<Map<string, number | null>> {
  if (stablecoinIds.length === 0) return new Map();
  const result = await db.prepare(`
    SELECT stablecoin_id, alert_snooze_until_ts
      FROM telegram_subscriptions
     WHERE chat_id = ? AND stablecoin_id IN (${stablecoinIds.map(() => "?").join(", ")})
  `).bind(chatId, ...stablecoinIds).all<{ stablecoin_id: string; alert_snooze_until_ts: number | null }>();
  return new Map((result.results ?? []).map((row) => [row.stablecoin_id, row.alert_snooze_until_ts]));
}

async function sourceImpactAfter(
  db: D1Database,
  chatId: string,
  stablecoinIds: readonly string[],
): Promise<Map<string, Array<"preset" | "global">>> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const result = new Map(uniqueIds.map((stablecoinId) => [stablecoinId, [] as Array<"preset" | "global">]));
  if (uniqueIds.length === 0) return result;
  const subscriber = await loadSubscriberByChat(db, chatId);
  const hasGlobal = Boolean(
    subscriber?.global_alert_dews || subscriber?.global_alert_depeg || subscriber?.global_alert_safety
    || subscriber?.global_alert_launch || subscriber?.global_alert_reserve || subscriber?.global_alert_freeze,
  );
  if (hasGlobal) {
    for (const stablecoinId of uniqueIds) result.get(stablecoinId)?.push("global");
  }
  const followedPresetIds = (await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION))
    .state.presets.map((preset) => preset.presetId as TelegramPresetId);
  if (followedPresetIds.length === 0) return result;
  const resolved = await resolveTelegramPresetTargets(db, followedPresetIds);
  if (resolved.kind !== "ok") throw new TelegramMiniAppMutationError("preset-unavailable", 503);
  const presetCoinIds = new Set(resolved.presets.flatMap((preset) => preset.stablecoinIds));
  for (const stablecoinId of uniqueIds) {
    if (presetCoinIds.has(stablecoinId)) result.get(stablecoinId)?.push("preset");
  }
  return result;
}

async function presetCoins(db: D1Database, presetId: TelegramPresetId): Promise<string[]> {
  const resolved = await resolveTelegramPresetTargets(db, [presetId]);
  if (resolved.kind !== "ok") throw new TelegramMiniAppMutationError("preset-unavailable", 503);
  const preset = resolved.presets.find((entry) => entry.definition.id === presetId);
  if (!preset) throw new TelegramMiniAppMutationError("unknown-preset");
  for (const stablecoinId of preset.stablecoinIds) {
    assertCoinCanSubscribe(stablecoinId);
  }
  return preset.stablecoinIds;
}

async function setGlobal(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-global" }>): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [operation.alertType]: operation.enabled ? 1 : 0 } as NonNullable<UpsertSubscriberInput["globalAlertOverrides"]>,
  });
}

async function setGlobalDepegStep(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-global-depeg-step" }>): Promise<void> {
  await setGlobalDepegWorseningStep(db, chatId, username, operation.depegStepBps);
}

async function setQuietHours(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-quiet-hours" }>): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: operation.enabled
      ? { enabled: true, startHourUtc: operation.startHourUtc ?? DEFAULT_QUIET_START_HOUR, endHourUtc: operation.endHourUtc ?? DEFAULT_QUIET_END_HOUR }
      : { enabled: false },
  });
}

async function setCoin(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>): Promise<void> {
  assertCoinCanSubscribe(operation.stablecoinId);
  const patch = operation.patch;
  let appliedCount = 0;
  const statements: D1PreparedStatement[] = [];

  const apply = (setting: "db" | "ds" | "sm" | "lc" | "rs" | "fz", value: string): void => {
    const prepared = prepareCoinSettingStatements(db, chatId, username, operation.stablecoinId, setting, value);
    if (prepared.description == null) throw new TelegramMiniAppMutationError("invalid-coin-patch");
    statements.push(...prepared.statements);
    appliedCount += 1;
  };

  if (patch.alertTypes) {
    const enabled = new Set<string>();
    for (const [alertType, on] of Object.entries(patch.alertTypes)) {
      if (on) {
        enabled.add(alertType);
      } else if (alertType === "dews") {
        apply("db", "0");
      } else if (alertType === "depeg") {
        apply("ds", "0");
      } else if (alertType === "safety") {
        apply("sm", "0");
      } else if (alertType === "launch") {
        apply("lc", "0");
      } else if (alertType === "reserve") {
        apply("rs", "0");
      } else if (alertType === "freeze") {
        apply("fz", "0");
      }
    }
    if (enabled.size > 0) {
      statements.push(
        ...prepareSubscriberAndSubscriptionStatements(db, chatId, username, enabled, [operation.stablecoinId]),
      );
      appliedCount += 1;
    }
  }
  const explicitlyDisabled = (alertType: "dews" | "depeg" | "safety" | "launch" | "reserve" | "freeze"): boolean =>
    patch.alertTypes?.[alertType] === false;
  if (Object.prototype.hasOwnProperty.call(patch, "dewsMinBand") && !explicitlyDisabled("dews")) {
    apply("db", patch.dewsMinBand == null ? "0" : DEWS_BAND_TO_CODE[patch.dewsMinBand]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "depegStepBps") && !explicitlyDisabled("depeg")) {
    apply("ds", patch.depegStepBps == null ? "0" : String(patch.depegStepBps));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "safetyMode") && !explicitlyDisabled("safety")) {
    apply("sm", patch.safetyMode == null ? "0" : SAFETY_MODE_TO_CODE[patch.safetyMode]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "launch") && !explicitlyDisabled("launch")) {
    apply("lc", patch.launch ? "1" : "0");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reserve") && !explicitlyDisabled("reserve")) {
    apply("rs", patch.reserve ? "1" : "0");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "freeze") && !explicitlyDisabled("freeze")) {
    apply("fz", patch.freeze ? "1" : "0");
  }
  if (appliedCount === 0) throw new TelegramMiniAppMutationError("invalid-coin-patch");
  await executeAtomicBatch(db, statements);
}

export function isTelegramMiniAppPortabilityOperation(
  operation: TelegramMiniAppOperation,
): operation is TelegramMiniAppPortabilityOperation {
  return operation.kind === "export-watchlist"
    || operation.kind === "preview-watchlist-import"
    || operation.kind === "confirm-watchlist-import";
}

export async function executeTelegramMiniAppPortabilityOperation(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: TelegramMiniAppPortabilityOperation,
): Promise<TelegramMiniAppPortabilityResponse | null> {
  const chatId = privateChatId(auth);
  if (operation.kind === "export-watchlist") {
    const { state } = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
    if (state.direct.length === 0 && state.presets.length === 0) {
      throw new TelegramMiniAppMutationError("empty-portable-state");
    }
    let token: string;
    try {
      token = await encodeWatchlistTokenV3(state);
    } catch {
      throw new TelegramMiniAppMutationError("empty-portable-state");
    }
    return {
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      result: {
        kind: "watchlist-export",
        token,
        directCount: state.direct.length,
        presetCount: state.presets.length,
      },
    };
  }

  const desired = await decodedPortableState(operation.token);
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const { preview, exactPreview } = buildPortablePreview(current.state, desired);
  const fingerprint = importFingerprint(expectedPreferenceGeneration, desired, exactPreview);

  if (operation.kind === "preview-watchlist-import") {
    return {
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      result: {
        kind: "watchlist-import-preview",
        expectedPreferenceGeneration,
        previewFingerprint: fingerprint,
        preview,
      },
    };
  }

  if (
    operation.expectedPreferenceGeneration !== expectedPreferenceGeneration
    || operation.previewFingerprint !== fingerprint
  ) {
    throw new TelegramMiniAppMutationError("stale-import-preview", 409);
  }
  const totalChanges = exactPreview.directAdds.length
    + exactPreview.directRemoves.length
    + exactPreview.directChanges.length
    + exactPreview.presetAdds.length
    + exactPreview.presetRemoves.length
    + exactPreview.presetChanges.length;
  if (totalChanges === 0) throw new TelegramMiniAppMutationError("stale-import-preview", 409);

  const outcome = await applyWatchlistImportV2(db, {
    chatId,
    ...(current.preferenceGeneration == null ? { ensureSubscriber: { username: auth.username } } : {}),
    expectedPreferenceGeneration,
    generationLease: importGenerationLease(),
    directEntries: desired.direct.map(packWatchlistDirectState).sort(),
    presetEntries: desired.presets.map(packWatchlistPresetState).sort(),
    directRemoveIds: exactPreview.directRemoves,
    presetRemoveIds: exactPreview.presetRemoves,
    pendingExpiresAt: 0,
    pendingActionPayload: "mini-app-portability-preview",
  });
  if (outcome !== "applied") throw new TelegramMiniAppMutationError("stale-import-preview", 409);
  return null;
}

export function isTelegramMiniAppBulkWatchlistPreviewOperation(
  operation: TelegramMiniAppOperation,
): operation is Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }> {
  return operation.kind === "preview-bulk-watchlist";
}

export async function executeTelegramMiniAppBulkWatchlistPreview(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>,
): Promise<TelegramMiniAppBulkWatchlistResponse> {
  const chatId = privateChatId(auth);
  for (const stablecoinId of operation.addStablecoinIds) assertCoinCanSubscribe(stablecoinId);
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);

  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const directById = new Map(current.state.direct.map((row) => [row.stablecoinId, row]));
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !directById.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => directById.has(stablecoinId)).sort();
  const unchanged = [
    ...operation.addStablecoinIds.filter((stablecoinId) => directById.has(stablecoinId)),
    ...operation.removeStablecoinIds.filter((stablecoinId) => !directById.has(stablecoinId)),
  ].sort();
  if (adds.length + removes.length === 0) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }
  const desiredDirect = [
    ...current.state.direct.filter((row) => !removes.includes(row.stablecoinId)),
    ...adds.map(directDefault),
  ];
  const removedSnoozes = await directSnoozesById(db, chatId, removes);
  const inheritedSources = await sourceImpactAfter(db, chatId, [...adds, ...removes]);
  const restoreDirectRows: BulkUndoRow[] = removes.map((stablecoinId) => ({
    ...directById.get(stablecoinId)!,
    snoozeUntilTs: removedSnoozes.get(stablecoinId) ?? null,
  }));
  const removeStablecoinIds = adds;
  return {
    contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    result: {
      kind: "bulk-watchlist-preview",
      expectedPreferenceGeneration,
      previewFingerprint: bulkPreviewFingerprint(expectedPreferenceGeneration, current.state, adds, removes),
      adds,
      removes,
      unchanged,
      sourceImpact: [
        ...adds.map((stablecoinId) => ({
          stablecoinId,
          action: "add" as const,
          inheritedSourcesAfter: inheritedSources.get(stablecoinId) ?? [],
        })),
        ...removes.map((stablecoinId) => ({
          stablecoinId,
          action: "remove" as const,
          inheritedSourcesAfter: inheritedSources.get(stablecoinId) ?? [],
        })),
      ],
      undo: {
        expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
        expectedFingerprint: bulkUndoFingerprint(
          expectedPreferenceGeneration + 1,
          desiredDirect,
          restoreDirectRows,
          removeStablecoinIds,
        ),
        restoreDirectRows,
        removeStablecoinIds,
      },
    },
  };
}

async function confirmBulkWatchlist(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "confirm-bulk-watchlist" }>,
): Promise<void> {
  const chatId = privateChatId(auth);
  for (const stablecoinId of operation.addStablecoinIds) assertCoinCanSubscribe(stablecoinId);
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const directIds = new Set(current.state.direct.map((row) => row.stablecoinId));
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !directIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => directIds.has(stablecoinId)).sort();
  if (
    adds.length + removes.length === 0
    || operation.expectedPreferenceGeneration !== expectedPreferenceGeneration
    || operation.previewFingerprint !== bulkPreviewFingerprint(expectedPreferenceGeneration, current.state, adds, removes)
  ) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }
  const outcome = await applyWatchlistDirectPatch(db, {
    chatId,
    ...(current.preferenceGeneration == null ? { ensureSubscriber: { username: auth.username } } : {}),
    expectedPreferenceGeneration,
    generationLease: importGenerationLease(),
    directEntriesToUpsert: adds.map(directDefault).map(packWatchlistDirectState),
    directRemoveIds: removes,
  });
  if (outcome !== "applied") throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
}

async function undoBulkWatchlist(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "undo-bulk-watchlist" }>,
): Promise<void> {
  const chatId = privateChatId(auth);
  const restoreRows = operation.restoreDirectRows.map(fromBulkDirectRow);
  for (const row of restoreRows) assertCoin(row.stablecoinId);
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  if (
    operation.expectedPreferenceGeneration !== expectedPreferenceGeneration
    || operation.expectedFingerprint !== bulkUndoFingerprint(
      expectedPreferenceGeneration,
      current.state.direct,
      operation.restoreDirectRows,
      operation.removeStablecoinIds,
    )
  ) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }
  const outcome = await applyWatchlistDirectPatch(db, {
    chatId,
    ...(current.preferenceGeneration == null ? { ensureSubscriber: { username: auth.username } } : {}),
    expectedPreferenceGeneration,
    generationLease: importGenerationLease(),
    directEntriesToUpsert: restoreRows.map(packWatchlistDirectState),
    directSnoozeValues: operation.restoreDirectRows.map((row) => ({
      stablecoinId: row.stablecoinId,
      snoozeUntilTs: row.snoozeUntilTs ?? null,
    })),
    directRemoveIds: operation.removeStablecoinIds,
  });
  if (outcome !== "applied") throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
}

export async function applyTelegramMiniAppMutation(db: D1Database, auth: TelegramMiniAppAuthContext, operation: TelegramMiniAppOperation): Promise<void> {
  const chatId = privateChatId(auth);
  const username = auth.username;
  switch (operation.kind) {
    case "export-watchlist":
    case "preview-watchlist-import":
    case "confirm-watchlist-import":
    case "preview-bulk-watchlist":
      throw new TelegramMiniAppMutationError("invalid-coin-patch");
    case "confirm-bulk-watchlist":
      await confirmBulkWatchlist(db, auth, operation);
      return;
    case "undo-bulk-watchlist":
      await undoBulkWatchlist(db, auth, operation);
      return;
    case "recommended-setup": {
      await presetCoins(db, operation.presetId);
      const alertTypes = alertTypeSet(operation.alertTypes);
      await executeAtomicBatch(
        db,
        prepareSubscriberAndPresetStatements(db, chatId, username, [operation.presetId], [], alertTypes),
      );
      return;
    }
    case "set-global":
      await setGlobal(db, chatId, username, operation);
      return;
    case "set-global-depeg-step":
      await setGlobalDepegStep(db, chatId, username, operation);
      return;
    case "set-quiet-hours":
      await setQuietHours(db, chatId, username, operation);
      return;
    case "clear-snooze":
      await clearAlertSnooze(db, chatId, username);
      return;
    case "set-snooze":
      await setSubscriberSnooze(db, chatId, username, unixNow() + SNOOZE_SECONDS[operation.durationToken]);
      return;
    case "pause":
      await setSubscriberSnooze(db, chatId, username, PAUSE_SENTINEL_TS);
      return;
    case "set-coin-snooze":
      if (operation.durationToken === "clear") {
        assertCoin(operation.stablecoinId);
      } else {
        assertCoinCanSubscribe(operation.stablecoinId);
      }
      await setSubscriptionSnooze(
        db,
        chatId,
        operation.stablecoinId,
        operation.durationToken === "clear" ? null : unixNow() + SNOOZE_SECONDS[operation.durationToken],
      );
      return;
    case "set-timezone":
      if (operation.timezone != null && !isValidIanaTimezone(operation.timezone)) {
        throw new TelegramMiniAppMutationError("invalid-timezone");
      }
      await setSubscriberTimezone(db, chatId, username, operation.timezone);
      return;
    case "set-recap": {
      const subscriber = await loadSubscriberByChat(db, chatId);
      if (subscriber == null) {
        throw new TelegramMiniAppMutationError("recap-subscriber-required", 409);
      }
      // The schedule is computed from this row, so use its generation as the
      // write fence and ask the client to retry after a concurrent mutation.
      const timezone = subscriber.timezone ?? null;
      const expectedPreferenceGeneration = Number(subscriber.preference_generation ?? 0);
      if (operation.enabled && timezone == null) {
        throw new TelegramMiniAppMutationError("recap-timezone-required", 409);
      }
      const nowSec = unixNow();
      const nextDueMs = operation.enabled && timezone != null
        ? nextIanaLocalHourDueAt(nowSec * 1000, timezone, operation.deliveryHourLocal)
        : null;
      if (operation.enabled && nextDueMs == null) {
        throw new TelegramMiniAppMutationError("recap-timezone-required", 409);
      }
      const applied = await setTelegramRecapPreference(db, {
        chatId,
        enabled: operation.enabled,
        deliveryHourLocal: operation.deliveryHourLocal,
        nextDueAt: nextDueMs == null ? null : Math.floor(nextDueMs / 1000),
        nowSec,
        expectedPreferenceGeneration,
      });
      if (!applied) throw new TelegramMiniAppMutationError("stale-recap-preference", 409);
      return;
    }
    case "unsubscribe-all":
      await unsubscribeAll(db, chatId);
      return;
    case "forget-me":
      await forgetSubscriber(db, chatId);
      return;
    case "set-coin":
      await setCoin(db, chatId, username, operation);
      return;
    case "remove-coin":
      assertCoin(operation.stablecoinId);
      await executeAtomicBatch(db, prepareRemoveSubscriptionStatements(db, chatId, [operation.stablecoinId]));
      return;
    case "follow-preset": {
      assertPreset(operation.presetId);
      await presetCoins(db, operation.presetId);
      const alertTypes = alertTypesFromPatch(operation.alertTypes);
      const options = operation.alertTypes.depeg && "depegStepBps" in operation ? { depegWorseningBpsStep: operation.depegStepBps ?? null } : undefined;
      await executeAtomicBatch(
        db,
        prepareSubscriberAndPresetStatements(db, chatId, username, [operation.presetId], [], alertTypes, options),
      );
      return;
    }
    case "unfollow-preset": {
      assertPreset(operation.presetId);
      await removePresetSubscriptions(db, chatId, [operation.presetId]);
      return;
    }
  }
}

export function mutationActionDetail(operation: TelegramMiniAppOperation): string {
  if (operation.kind === "export-watchlist") return "watchlist_export";
  if (operation.kind === "preview-watchlist-import") return "watchlist_import_preview";
  if (operation.kind === "confirm-watchlist-import") return "watchlist_import_confirm";
  if (operation.kind === "preview-bulk-watchlist") return "bulk_watchlist_preview";
  if (operation.kind === "confirm-bulk-watchlist") return "bulk_watchlist_confirm";
  if (operation.kind === "undo-bulk-watchlist") return "bulk_watchlist_undo";
  if (operation.kind === "set-global") return operation.alertType;
  if (operation.kind === "set-global-depeg-step") return "depeg_step";
  if (operation.kind === "set-coin" || operation.kind === "remove-coin") return "coin";
  if (operation.kind === "recommended-setup" || operation.kind === "follow-preset" || operation.kind === "unfollow-preset") return "preset";
  if (operation.kind === "set-quiet-hours") return "quiet_hours";
  if (operation.kind === "set-snooze") return "chat";
  if (operation.kind === "set-coin-snooze") return "coin";
  if (operation.kind === "set-timezone") return "timezone";
  if (operation.kind === "set-recap") return "recap";
  if (operation.kind === "unsubscribe-all") return "all";
  return operation.kind;
}
