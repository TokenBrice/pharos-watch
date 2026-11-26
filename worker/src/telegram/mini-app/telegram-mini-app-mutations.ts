import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { fnv1a32Hex } from "@shared/lib/fnv1a";
import { sha256Hex } from "@shared/lib/sha256";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  type TelegramMiniAppBulkApplyResult,
  type TelegramMiniAppOperation,
  type TelegramMiniAppBulkWatchlistOperation,
  type TelegramMiniAppBulkWatchlistResponse,
} from "@shared/lib/telegram-mini-app-contract";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { TELEGRAM_LIVE_ALERT_TYPES } from "@shared/types/status";
import { timingSafeCompare } from "../../lib/auth";
import { executeAtomicBatch } from "../../lib/db";
import { bytesToHex } from "../../lib/hash";
import type { StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import { isSubscribableCoin } from "../store/subscription-eligibility";
import {
  computeDirectStateFingerprint,
  emptyWatchlistDirectState,
  packWatchlistDirectState,
  WATCHLIST_REGISTRY_VERSION,
  type StoredDirectFingerprintRow,
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
import {
  prepareCompoundCoinEditStatements,
  removeSubscriptions,
  setGlobalDepegWorseningStep,
} from "../store/subscriptions";
import {
  prepareSubscriberAndPresetPatchStatements,
  prepareSubscriberAndPresetStatements,
  removePresetSubscriptions,
} from "../store/presets";
import { clearAlertSnooze, setSubscriberSnooze, setSubscriberTimezone, setSubscriptionSnooze } from "../store/snooze";
import { forgetSubscriber, unsubscribeAll } from "../store/subscriber-lifecycle";
import { loadSubscriberByChat, upsertSubscriberRow, unixNow, type UpsertSubscriberInput } from "../store/subscribers";
import {
  applyWatchlistDirectPatch,
  loadWatchlistPortableState,
} from "../store/watchlist-import";

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

const UNDO_TOKEN_TTL_SEC = 60;
const UNDO_FINGERPRINT_PATTERN = /^undo-v1-([0-9]+)-([0-9a-f]{64})$/;
const encoder = new TextEncoder();

function resolveUndoSigningKeys(options: Pick<ApplyTelegramMiniAppMutationOptions, "botToken" | "botTokenPrevious">): string[] {
  const primary = options.botToken?.trim();
  const previous = options.botTokenPrevious?.trim();
  if (!primary) return [];
  return previous && previous !== primary ? [primary, previous] : [primary];
}

async function hmacSha256Hex(secretKey: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(digest));
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

function buildBulkUndoPayload(input: {
  userId: string;
  chatId: string;
  expectedPreferenceGeneration: number;
  expiresAt: number;
  direct: readonly WatchlistDirectState[];
  restoreRows: readonly BulkUndoRow[];
  removeStablecoinIds: readonly string[];
}): string {
  const directHash = sha256Hex(JSON.stringify(input.direct.map(packWatchlistDirectState).sort()));
  const canonicalRestoreRows = input.restoreRows
    .map((row) => [packWatchlistDirectState(fromBulkDirectRow(row)), row.snoozeUntilTs ?? null] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const sortedRemoveIds = [...input.removeStablecoinIds].sort();
  return JSON.stringify([
    "telegram-mini-app-undo-v1",
    input.userId,
    input.chatId,
    TELEGRAM_MINI_APP_CONTRACT_VERSION,
    input.expectedPreferenceGeneration,
    input.expiresAt,
    directHash,
    canonicalRestoreRows,
    sortedRemoveIds,
  ]);
}

async function signBulkUndoFingerprint(input: {
  userId: string;
  chatId: string;
  expectedPreferenceGeneration: number;
  direct: readonly WatchlistDirectState[];
  restoreRows: readonly BulkUndoRow[];
  removeStablecoinIds: readonly string[];
  nowSec: number;
  options: Pick<ApplyTelegramMiniAppMutationOptions, "botToken" | "botTokenPrevious">;
}): Promise<string> {
  const expiresAt = input.nowSec + UNDO_TOKEN_TTL_SEC;
  const payload = buildBulkUndoPayload({ ...input, expiresAt });
  const [signingKey] = resolveUndoSigningKeys(input.options);
  if (!signingKey) {
    throw new Error("Telegram Mini App undo token signing requires a configured bot token");
  }
  const mac = await hmacSha256Hex(signingKey, payload);
  return `undo-v1-${expiresAt}-${mac}`;
}

async function verifyBulkUndoFingerprint(input: {
  token: string;
  userId: string;
  chatId: string;
  expectedPreferenceGeneration: number;
  direct: readonly WatchlistDirectState[];
  restoreRows: readonly BulkUndoRow[];
  removeStablecoinIds: readonly string[];
  nowSec: number;
  options: Pick<ApplyTelegramMiniAppMutationOptions, "botToken" | "botTokenPrevious">;
}): Promise<boolean> {
  const match = UNDO_FINGERPRINT_PATTERN.exec(input.token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const providedMac = match[2]!;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < input.nowSec) return false;
  const candidateKeys = resolveUndoSigningKeys(input.options);
  if (candidateKeys.length === 0) return false;
  const payload = buildBulkUndoPayload({ ...input, expiresAt });
  for (const candidateKey of candidateKeys) {
    const expectedMac = await hmacSha256Hex(candidateKey, payload);
    if (await timingSafeCompare(expectedMac, providedMac)) {
      return true;
    }
  }
  return false;
}

function isValidUndoSnoozeUntilTs(value: number | null | undefined): boolean {
  return value == null
    || value === PAUSE_SENTINEL_TS
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/**
 * Mirrors AddCoinsScreen's `hasOwnEnabledFamily`: a direct row is directly
 * followed for bulk add/remove iff at least one live alert family is enabled
 * on its own row. Snooze-only, explicit-off override-only, and retired
 * launch-only rows are replaced on add (preserving any existing coin snooze)
 * and restored verbatim on undo.
 */
function hasOwnEnabledDirectFamily(row: WatchlistDirectState): boolean {
  return row.alertDews || row.alertDepeg || row.alertSafety || row.alertReserve || Boolean(row.alertFreeze);
}

function ownEnabledDirectIds(current: { state: WatchlistState }): Set<string> {
  return new Set(current.state.direct
    .filter(hasOwnEnabledDirectFamily)
    .map((row) => row.stablecoinId));
}

function fromBulkDirectRow(row: BulkUndoRow): WatchlistDirectState {
  return {
    ...row,
    alertFreeze: row.alertFreeze ?? false,
    overrideFreeze: row.overrideFreeze ?? false,
  };
}

function allStoredDirectRowsFromPortable(current: {
  state: WatchlistState;
  directSnoozes: Map<string, number | null>;
}): StoredDirectFingerprintRow[] {
  const byId = new Map<string, StoredDirectFingerprintRow>();
  for (const row of current.state.direct) {
    byId.set(row.stablecoinId, {
      ...row,
      snoozeUntilTs: current.directSnoozes.get(row.stablecoinId) ?? null,
    });
  }
  for (const [stablecoinId, snoozeUntilTs] of current.directSnoozes) {
    if (!byId.has(stablecoinId)) {
      byId.set(stablecoinId, {
        ...emptyWatchlistDirectState(stablecoinId),
        snoozeUntilTs,
      });
    }
  }
  return [...byId.values()];
}

async function sourceImpactAfter(
  db: D1Database,
  chatId: string,
  stablecoinIds: readonly string[],
  followedPresetIds: readonly TelegramPresetId[],
  options: {
    getStablecoinsCacheResult?: () => Promise<StablecoinsCacheLoadResult>;
    toleratePresetUnavailable?: boolean;
  } = {},
): Promise<Map<string, Array<"preset" | "global">>> {
  const uniqueIds = [...new Set(stablecoinIds)];
  const result = new Map(uniqueIds.map((stablecoinId) => [stablecoinId, [] as Array<"preset" | "global">]));
  if (uniqueIds.length === 0) return result;
  const presetOptions = options.getStablecoinsCacheResult
    ? { getStablecoinsCacheResult: options.getStablecoinsCacheResult }
    : {};
  const [subscriber, resolved] = followedPresetIds.length === 0
    ? [await loadSubscriberByChat(db, chatId), null]
    : await Promise.all([
        loadSubscriberByChat(db, chatId),
        resolveTelegramPresetTargets(db, followedPresetIds, presetOptions),
      ]);
  const hasGlobal = TELEGRAM_LIVE_ALERT_TYPES.some((type) =>
    subscriber?.[TELEGRAM_ALERT_PERSISTENCE[type].globalColumn]);
  if (hasGlobal) {
    for (const stablecoinId of uniqueIds) result.get(stablecoinId)?.push("global");
  }
  if (resolved == null) return result;
  if (resolved.kind !== "ok") {
    if (options.toleratePresetUnavailable) return result;
    throw new TelegramMiniAppMutationError("preset-unavailable", 503);
  }
  const presetCoinIds = new Set(resolved.presets.flatMap((preset) => preset.stablecoinIds));
  for (const stablecoinId of uniqueIds) {
    if (presetCoinIds.has(stablecoinId)) result.get(stablecoinId)?.push("preset");
  }
  return result;
}

async function presetCoins(
  db: D1Database,
  presetId: TelegramPresetId,
  getStablecoinsCacheResult?: () => Promise<StablecoinsCacheLoadResult>,
): Promise<string[]> {
  const resolved = await resolveTelegramPresetTargets(
    db,
    [presetId],
    getStablecoinsCacheResult ? { getStablecoinsCacheResult } : {},
  );
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
  const statements = prepareCompoundCoinEditStatements(
    db,
    chatId,
    username,
    operation.stablecoinId,
    operation.patch,
  );
  if (statements == null) throw new TelegramMiniAppMutationError("invalid-coin-patch");
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
  options: ApplyTelegramMiniAppMutationOptions = {},
): Promise<TelegramMiniAppBulkWatchlistResponse> {
  const chatId = privateChatId(auth);
  for (const stablecoinId of operation.addStablecoinIds) assertCoinCanSubscribe(stablecoinId);
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);

  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const allDirectById = new Map(allStoredDirectRowsFromPortable(current).map((row) => [row.stablecoinId, row]));
  const ownEnabledIds = ownEnabledDirectIds(current);
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !ownEnabledIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => ownEnabledIds.has(stablecoinId)).sort();
  const unchanged = [
    ...operation.addStablecoinIds.filter((stablecoinId) => ownEnabledIds.has(stablecoinId)),
    ...operation.removeStablecoinIds.filter((stablecoinId) => !ownEnabledIds.has(stablecoinId)),
  ].sort();
  // Adding over an existing snooze-only, override-only, dormant, or inert row replaces it; undo restores its exact pre-image.
  const overwrittenAdds = adds.filter((stablecoinId) => allDirectById.has(stablecoinId));
  if (adds.length + removes.length === 0) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }
  const desiredDirect = [
    ...current.state.direct.filter((row) => !removes.includes(row.stablecoinId) && !adds.includes(row.stablecoinId)),
    ...adds.map(directDefault),
  ];
  const followedPresetIds = current.state.presets.map((preset) => preset.presetId as TelegramPresetId);
  const inheritedSources = await sourceImpactAfter(db, chatId, [...adds, ...removes], followedPresetIds, {
    getStablecoinsCacheResult: options.getStablecoinsCacheResult,
  });
  const restoreDirectRows: BulkUndoRow[] = [...removes, ...overwrittenAdds].map((stablecoinId) => ({
    ...allDirectById.get(stablecoinId)!,
  }));
  const removeStablecoinIds = adds.filter((stablecoinId) => !allDirectById.has(stablecoinId));
  const nowSec = options.nowSec ?? unixNow();
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
        expectedFingerprint: await signBulkUndoFingerprint({
          userId: auth.userId,
          chatId,
          expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
          direct: desiredDirect,
          restoreRows: restoreDirectRows,
          removeStablecoinIds,
          nowSec,
          options,
        }),
        restoreDirectRows,
        removeStablecoinIds,
      },
    },
  };
}

export interface BulkWatchlistApplyExecution {
  bulkResult: TelegramMiniAppBulkApplyResult;
  undo: TelegramMiniAppBulkWatchlistResponse["result"]["undo"];
}

/**
 * Contract v10 single-RTT bulk watchlist apply: verifies both the expected
 * preference generation and the canonical direct-state fingerprint (over ALL
 * stored direct rows, including dormant/inert rows), derives exact adds,
 * removes, unchanged items, pre-images, and commits under the SQL generation
 * lease in one atomic batch.
 */
export async function executeTelegramMiniAppBulkWatchlistApply(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "apply-bulk-watchlist" }>,
  options: ApplyTelegramMiniAppMutationOptions = {},
): Promise<BulkWatchlistApplyExecution> {
  const chatId = privateChatId(auth);
  for (const stablecoinId of operation.addStablecoinIds) assertCoinCanSubscribe(stablecoinId);
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);

  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
  const subscriberExists = current.preferenceGeneration != null;
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const allRows = allStoredDirectRowsFromPortable(current);
  const currentFingerprint = computeDirectStateFingerprint({ subscriberExists, rows: allRows });
  if (
    operation.expectedPreferenceGeneration !== expectedPreferenceGeneration
    || operation.expectedDirectFingerprint !== currentFingerprint
  ) {
    throw new TelegramMiniAppMutationError("stale-bulk-preview", 409);
  }

  const allDirectById = new Map(allRows.map((row) => [row.stablecoinId, row]));
  const ownEnabledIds = ownEnabledDirectIds(current);
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !ownEnabledIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => ownEnabledIds.has(stablecoinId)).sort();
  const unchanged = [
    ...operation.addStablecoinIds.filter((stablecoinId) => ownEnabledIds.has(stablecoinId)),
    ...operation.removeStablecoinIds.filter((stablecoinId) => !ownEnabledIds.has(stablecoinId)),
  ].sort();
  if (adds.length + removes.length === 0) {
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

  // Adding over a snooze-only, override-only, dormant, or inert stored row replaces it; undo restores its exact pre-image.
  const overwrittenAdds = adds.filter((stablecoinId) => allDirectById.has(stablecoinId));
  const restoreDirectRows: BulkUndoRow[] = [...removes, ...overwrittenAdds].map((stablecoinId) => ({
    ...allDirectById.get(stablecoinId)!,
  }));
  const removeStablecoinIds = adds.filter((stablecoinId) => !allDirectById.has(stablecoinId));
  const desiredDirect = [
    ...current.state.direct.filter((row) => !removes.includes(row.stablecoinId) && !adds.includes(row.stablecoinId)),
    ...adds.map(directDefault),
  ];

  const followedPresetIds = current.state.presets.map((preset) => preset.presetId as TelegramPresetId);
  let inheritedSources: Map<string, Array<"preset" | "global">> | null = null;
  try {
    inheritedSources = await sourceImpactAfter(db, chatId, [...adds, ...removes], followedPresetIds, {
      getStablecoinsCacheResult: options.getStablecoinsCacheResult,
      toleratePresetUnavailable: true,
    });
  } catch {
    // Direct patch already committed; omit impact entries rather than claiming zero inherited sources.
    inheritedSources = null;
  }
  const nowSec = options.nowSec ?? unixNow();

  return {
    bulkResult: {
      adds,
      removes,
      unchanged,
      sourceImpact: inheritedSources == null
        ? []
        : [
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
    },
    undo: {
      expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
      expectedFingerprint: await signBulkUndoFingerprint({
        userId: auth.userId,
        chatId,
        expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
        direct: desiredDirect,
        restoreRows: restoreDirectRows,
        removeStablecoinIds,
        nowSec,
        options,
      }),
      restoreDirectRows,
      removeStablecoinIds,
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
  const ownEnabledIds = ownEnabledDirectIds(current);
  const adds = operation.addStablecoinIds.filter((stablecoinId) => !ownEnabledIds.has(stablecoinId)).sort();
  const removes = operation.removeStablecoinIds.filter((stablecoinId) => ownEnabledIds.has(stablecoinId)).sort();
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
  options: ApplyTelegramMiniAppMutationOptions = {},
): Promise<void> {
  const chatId = privateChatId(auth);
  const restoreRows = operation.restoreDirectRows.map(fromBulkDirectRow);
  for (const row of operation.restoreDirectRows) {
    assertCoin(row.stablecoinId);
    if (!isValidUndoSnoozeUntilTs(row.snoozeUntilTs)) {
      throw new TelegramMiniAppMutationError("invalid-coin-patch", 400);
    }
  }
  for (const stablecoinId of operation.removeStablecoinIds) assertCoin(stablecoinId);
  const current = await loadWatchlistPortableState(db, chatId, WATCHLIST_REGISTRY_VERSION, true);
  const expectedPreferenceGeneration = current.preferenceGeneration ?? 0;
  const nowSec = options.nowSec ?? unixNow();
  if (
    operation.expectedPreferenceGeneration !== expectedPreferenceGeneration
    || !(await verifyBulkUndoFingerprint({
      token: operation.expectedFingerprint,
      userId: auth.userId,
      chatId,
      expectedPreferenceGeneration,
      direct: current.state.direct,
      restoreRows: operation.restoreDirectRows,
      removeStablecoinIds: operation.removeStablecoinIds,
      nowSec,
      options,
    }))
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

export interface ApplyTelegramMiniAppMutationOptions {
  getStablecoinsCacheResult?: () => Promise<StablecoinsCacheLoadResult>;
  botToken?: string;
  botTokenPrevious?: string;
  nowSec?: number;
}

export async function applyTelegramMiniAppMutation(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  operation: TelegramMiniAppOperation,
  options: ApplyTelegramMiniAppMutationOptions = {},
): Promise<TelegramMiniAppBulkWatchlistResponse["result"]["undo"] | void> {
  const chatId = privateChatId(auth);
  const username = auth.username;
  switch (operation.kind) {
    case "preview-bulk-watchlist":
      throw new TelegramMiniAppMutationError("invalid-coin-patch");
    case "confirm-bulk-watchlist":
      await confirmBulkWatchlist(db, auth, operation);
      return;
    case "apply-bulk-watchlist":
      return (await executeTelegramMiniAppBulkWatchlistApply(db, auth, operation, options)).undo;
    case "undo-bulk-watchlist":
      await undoBulkWatchlist(db, auth, operation, options);
      return;
    case "recommended-setup": {
      await presetCoins(db, operation.presetId, options.getStablecoinsCacheResult);
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
      const nowSec = options.nowSec ?? unixNow();
      return {
        expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
        expectedFingerprint: await signBulkUndoFingerprint({
          userId: auth.userId,
          chatId,
          expectedPreferenceGeneration: expectedPreferenceGeneration + 1,
          direct: current.state.direct.filter((row) => row.stablecoinId !== operation.stablecoinId),
          restoreRows: restoreDirectRows,
          removeStablecoinIds: [],
          nowSec,
          options,
        }),
        restoreDirectRows,
        removeStablecoinIds: [],
      };
    }
    case "follow-preset": {
      assertPreset(operation.presetId);
      await presetCoins(db, operation.presetId, options.getStablecoinsCacheResult);
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
  if (operation.kind === "apply-bulk-watchlist") return "bulk_watchlist_apply";
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
