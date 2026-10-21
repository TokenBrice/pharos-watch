import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { fnv1a32Hex } from "@shared/lib/fnv1a";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  type TelegramAlertType,
  type TelegramMiniAppOperation,
  type TelegramMiniAppBulkWatchlistOperation,
  type TelegramMiniAppBulkWatchlistResponse,
} from "@shared/lib/telegram-mini-app-contract";
import {
  TELEGRAM_ALERT_PERSISTENCE,
  type TelegramAlertSettingCode,
} from "@shared/lib/telegram-alert-families";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { isTelegramAlertType, isTelegramRetiredAlertType } from "@shared/types/status";
import { executeAtomicBatch } from "../../lib/db";
import { isSubscribableCoin } from "../store/subscription-eligibility";
import {
  packWatchlistDirectState,
  WATCHLIST_REGISTRY_VERSION,
  type WatchlistDirectState,
  type WatchlistState,
} from "./watchlist-state";
import type { TelegramMiniAppAuthContext } from "./mini-app-auth";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../common/presets";
import { SNOOZE_SECONDS } from "../common/constants";
import { isValidIanaTimezone } from "../common/quiet-hours";
import { DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR } from "../webhook/telegram-webhook-settings-shared";
import { prepareCoinSettingStatements } from "../webhook/telegram-webhook-settings-mutations";
import { buildDepegStepUpsert, buildDewsUpsert, buildSafetyUpsert, removeSubscriptions, type BuiltSubscriptionUpsert } from "../store/subscriptions";
import { prepareSubscriberAndPresetPatchStatements } from "../store/presets";
import { prepareUpsertSubscriberRow, prepareTelegramFirstFollowStatements } from "../store/subscribers";
import { clearAlertSnooze, setSubscriberSnooze, setSubscriberTimezone, setSubscriptionSnooze } from "../store/snooze";
import { forgetSubscriber, unsubscribeAll } from "../store/subscriber-lifecycle";
import { prepareSubscriberAndPresetStatements, removePresetSubscriptions } from "../store/presets";
import { prepareSubscriberAndSubscriptionStatements, setGlobalDepegWorseningStep } from "../store/subscriptions";
import { upsertSubscriberRow, unixNow, type UpsertSubscriberInput } from "../store/subscribers";
import {
  applyWatchlistDirectPatch,
  loadWatchlistPortableState,
} from "../store/watchlist-import";
import { loadSubscriberByChat } from "../store/subscribers";

export type TelegramMiniAppMutationErrorCode =
  | "not-private"
  | "unknown-coin"
  | "unknown-preset"
  | "empty-alert-types"
  | "preset-unavailable"
  | "invalid-coin-patch"
  | "invalid-timezone"
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

type BulkUndoOperation = Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "undo-bulk-watchlist" }>;
type BulkUndoRow = BulkUndoOperation["restoreDirectRows"][number];

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

function previewFingerprint(value: unknown): string {
  // Consistency fence only, not an authorization token.
  const input = JSON.stringify(value);
  return `preview-v1-${input.length}-${fnv1a32Hex(input)}`;
}

function importGenerationLease(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return 4_000_000_000_000_000 + value;
}

function directDefault(stablecoinId: string): WatchlistDirectState {
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
  current: WatchlistState,
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
  direct: readonly WatchlistDirectState[],
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

/**
 * Mirrors the Mini App state projection: a direct row is followed only when a
 * live family is on or explicitly overridden, or a coin snooze is set. Rows
 * left with only retired (launch) flags are dormant: adding the coin replaces
 * them and undo restores them.
 */
function isLiveDirectRow(row: WatchlistDirectState, snoozeUntilTs: number | null | undefined): boolean {
  return row.alertDews || row.alertDepeg || row.alertSafety || row.alertReserve || Boolean(row.alertFreeze)
    || row.overrideDews || row.overrideDepeg || row.overrideSafety || row.overrideReserve || Boolean(row.overrideFreeze)
    || snoozeUntilTs != null;
}

function liveDirectIds(current: { state: WatchlistState; directSnoozes: Map<string, number | null> }): Set<string> {
  return new Set(current.state.direct
    .filter((row) => isLiveDirectRow(row, current.directSnoozes.get(row.stablecoinId)))
    .map((row) => row.stablecoinId));
}

function fromBulkDirectRow(row: BulkUndoRow): WatchlistDirectState {
  return {
    ...row,
    alertFreeze: row.alertFreeze ?? false,
    overrideFreeze: row.overrideFreeze ?? false,
  };
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
    || subscriber?.global_alert_reserve || subscriber?.global_alert_freeze,
  );
  if (hasGlobal) {
    for (const stablecoinId of uniqueIds) result.get(stablecoinId)?.push("global");
  }
  const followedPresetIds = (await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION))
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
      ? {
          enabled: true,
          startHourUtc: operation.startHourUtc ?? DEFAULT_QUIET_START_HOUR,
          endHourUtc: operation.endHourUtc ?? DEFAULT_QUIET_END_HOUR,
          preserveSavedWindow: operation.startHourUtc == null && operation.endHourUtc == null,
        }
      : { enabled: false },
  });
}

async function setCoin(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>): Promise<void> {
  assertCoinCanSubscribe(operation.stablecoinId);
  const patch = operation.patch;
  let appliedCount = 0;
  let enablesFollow = false;
  const statements: D1PreparedStatement[] = [];

  const apply = (setting: TelegramAlertSettingCode, value: string): void => {
    const prepared = prepareCoinSettingStatements(db, chatId, username, operation.stablecoinId, setting, value);
    if (prepared.description == null) throw new TelegramMiniAppMutationError("invalid-coin-patch");
    if (value !== "0") enablesFollow = true;
    statements.push(...prepared.statements);
    appliedCount += 1;
  };
  const applyTuning = (alertType: TelegramAlertType, upsert: BuiltSubscriptionUpsert): void => {
    statements.push(
      prepareUpsertSubscriberRow(db, { chatId, username, nowSec: unixNow(), perCoinAlertBumps: { [alertType]: 1 } }),
      db.prepare(upsert.sql).bind(...upsert.binds),
    );
    appliedCount += 1;
    enablesFollow = true;
  };

  if (patch.alertTypes) {
    const enabled = new Set<string>();
    for (const [alertType, on] of Object.entries(patch.alertTypes)) {
      // Retired families (launch) are neither enabled nor disabled any more.
      if (isTelegramRetiredAlertType(alertType)) continue;
      if (on) {
        enabled.add(alertType);
        continue;
      }
      if (!isTelegramAlertType(alertType)) continue;
      apply(TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode, "0");
    }
    if (enabled.size > 0) {
      statements.push(
        ...prepareSubscriberAndSubscriptionStatements(db, chatId, username, enabled, [operation.stablecoinId]),
      );
      appliedCount += 1;
      enablesFollow = true;
    }
  }
  const explicitlyDisabled = (alertType: TelegramAlertType): boolean =>
    patch.alertTypes?.[alertType] === false;
  if (Object.prototype.hasOwnProperty.call(patch, "dewsMinBand") && !explicitlyDisabled("dews")) {
    applyTuning("dews", buildDewsUpsert(chatId, operation.stablecoinId, true, patch.dewsMinBand ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "depegStepBps") && !explicitlyDisabled("depeg")) {
    applyTuning("depeg", buildDepegStepUpsert(chatId, operation.stablecoinId, patch.depegStepBps ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "safetyMode") && !explicitlyDisabled("safety")) {
    applyTuning("safety", buildSafetyUpsert(chatId, operation.stablecoinId, true, patch.safetyMode ?? null));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reserve") && !explicitlyDisabled("reserve")) {
    apply(TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode, patch.reserve ? "1" : "0");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "freeze") && !explicitlyDisabled("freeze")) {
    apply(TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode, patch.freeze ? "1" : "0");
  }
  if (appliedCount === 0) throw new TelegramMiniAppMutationError("invalid-coin-patch");
  if (enablesFollow) {
    statements.unshift(...prepareTelegramFirstFollowStatements(db, {
      chatId, username, nowSec: unixNow(), feature: "direct",
    }));
  }
  await executeAtomicBatch(db, statements);
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

  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const directById = new Map(current.state.direct.map((row) => [row.stablecoinId, row]));
  const liveIds = liveDirectIds(current);
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !liveIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => liveIds.has(stablecoinId)).sort();
  const unchanged = [
    ...operation.addStablecoinIds.filter((stablecoinId) => liveIds.has(stablecoinId)),
    ...operation.removeStablecoinIds.filter((stablecoinId) => !liveIds.has(stablecoinId)),
  ].sort();
  // Adding over a dormant row replaces it; undo restores it instead of deleting.
  const dormantAdds = adds.filter((stablecoinId) => directById.has(stablecoinId));
  if (adds.length + removes.length === 0) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }
  const desiredDirect = [
    ...current.state.direct.filter((row) => !removes.includes(row.stablecoinId) && !adds.includes(row.stablecoinId)),
    ...adds.map(directDefault),
  ];
  const inheritedSources = await sourceImpactAfter(db, chatId, [...adds, ...removes]);
  const restoreDirectRows: BulkUndoRow[] = [...removes, ...dormantAdds].map((stablecoinId) => ({
    ...directById.get(stablecoinId)!,
    snoozeUntilTs: current.directSnoozes.get(stablecoinId) ?? null,
  }));
  const removeStablecoinIds = adds.filter((stablecoinId) => !directById.has(stablecoinId));
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
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const liveIds = liveDirectIds(current);
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !liveIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => liveIds.has(stablecoinId)).sort();
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
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
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

export async function applyTelegramMiniAppMutation(db: D1Database, auth: TelegramMiniAppAuthContext, operation: TelegramMiniAppOperation): Promise<TelegramMiniAppBulkWatchlistResponse["result"]["undo"] | void> {
  const chatId = privateChatId(auth);
  const username = auth.username;
  switch (operation.kind) {
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
    case "unsubscribe-all":
      await unsubscribeAll(db, chatId);
      return;
    case "forget-me":
      await forgetSubscriber(db, chatId);
      return;
    case "set-coin":
      await setCoin(db, chatId, username, operation);
      return;
    case "remove-coin": {
      const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
      if (!TRACKED_META_BY_ID.has(operation.stablecoinId)) {
        // A coin removed from the registry can still have a stored row; delete
        // it without an undo, since it can never be followed again.
        if (!current.directSnoozes.has(operation.stablecoinId)) throw new TelegramMiniAppMutationError("unknown-coin");
        await removeSubscriptions(db, chatId, [operation.stablecoinId]);
        return;
      }
      const removed = current.state.direct.find((row) => row.stablecoinId === operation.stablecoinId);
      if (!removed) return;
      const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
      const restoreDirectRows = [{ ...removed, snoozeUntilTs: current.directSnoozes.get(operation.stablecoinId) ?? null }];
      const outcome = await applyWatchlistDirectPatch(db, {
        chatId,
        expectedPreferenceGeneration,
        generationLease: importGenerationLease(),
        directEntriesToUpsert: [],
        directRemoveIds: [operation.stablecoinId],
      });
      if (outcome !== "applied") throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
      return {
        expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
        expectedFingerprint: bulkUndoFingerprint(
          expectedPreferenceGeneration + 1,
          current.state.direct.filter((row) => row.stablecoinId !== operation.stablecoinId),
          restoreDirectRows,
          [],
        ),
        restoreDirectRows,
        removeStablecoinIds: [],
      };
    }
    case "follow-preset": {
      assertPreset(operation.presetId);
      await presetCoins(db, operation.presetId);
      const results = await executeAtomicBatch(
        db,
        prepareSubscriberAndPresetPatchStatements(
          db, chatId, username, operation.presetId, operation.alertTypes, operation.depegStepBps,
        ),
        { returnResults: true },
      );
      if (Number(results[results.length - 1]?.meta?.changes ?? 0) === 0) {
        throw new TelegramMiniAppMutationError("empty-alert-types");
      }
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
  if (operation.kind === "unsubscribe-all") return "all";
  return operation.kind;
}
