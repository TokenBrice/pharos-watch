import { z } from "zod";
import {
  TELEGRAM_ALERT_TYPES,
  TelegramDewsBandSchema,
  TelegramDepegStepBpsSchema,
  TelegramSafetyModeSchema,
  type TelegramAlertType,
} from "../types/status/telegram";
import { fnv1a32Hex } from "./fnv1a";
import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "./telegram-mini-app-catalog";
import { TELEGRAM_PRESET_IDS } from "./telegram-presets";

export type { TelegramAlertType };

export const TELEGRAM_MINI_APP_CONTRACT_VERSION = "10";
export const TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM = "mini_app_contract";
export const TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM = "mini_app_catalog";
export { TELEGRAM_MINI_APP_CATALOG_VERSION };

/** Default UTC window when quiet hours are enabled without a supplied range. */
export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 7;

const TELEGRAM_MINI_APP_ERROR_CODES = [
  "stale-auth",
  "not-private",
  "rate-limited",
  "validation-error",
  "body-too-large",
  "internal",
  "not-configured",
  "preset-unavailable",
  "unknown-coin",
  "unknown-preset",
  "invalid-coin-patch",
  "invalid-alert-types",
  "invalid-timezone",
  "stale-bulk-preview",
  "contract-version-mismatch",
  "catalog-version-mismatch",
] as const;

export type TelegramMiniAppErrorCode = (typeof TELEGRAM_MINI_APP_ERROR_CODES)[number];

const MINI_APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(TELEGRAM_MINI_APP_ERROR_CODES);

export function isTelegramMiniAppErrorCode(value: unknown): value is TelegramMiniAppErrorCode {
  return typeof value === "string" && MINI_APP_ERROR_CODE_SET.has(value);
}

const TelegramAlertTypeSchema = z.enum(TELEGRAM_ALERT_TYPES);
const TelegramPresetIdSchema = z.enum(TELEGRAM_PRESET_IDS);

const NullableDepegStepSchema = TelegramDepegStepBpsSchema.nullable();
const AlertTypesSchema = z
  .object({
    dews: z.boolean(),
    depeg: z.boolean(),
    safety: z.boolean(),
    launch: z.boolean(),
    reserve: z.boolean(),
    // Default false keeps the new client able to hydrate a full-state response
    // from the previous Worker during the rolling deployment window.
    freeze: z.boolean().default(false),
  })
  .passthrough();
const PresetAlertTypesSchema = z
  .object({
    dews: z.boolean(),
    depeg: z.boolean(),
    safety: z.boolean(),
  })
  .passthrough();

const CoinPatchSchema = z
  .object({
    alertTypes: z
      .object({
        dews: z.boolean().optional(),
        depeg: z.boolean().optional(),
        safety: z.boolean().optional(),
        launch: z.boolean().optional(),
        reserve: z.boolean().optional(),
        freeze: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dewsMinBand: TelegramDewsBandSchema.nullable().optional(),
    depegStepBps: NullableDepegStepSchema.optional(),
    safetyMode: TelegramSafetyModeSchema.nullable().optional(),
    launch: z.boolean().optional(),
    reserve: z.boolean().optional(),
    freeze: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "set-coin patch must include at least one field",
  });

const SnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h"]);
const CoinSnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h", "clear"]);
const BulkStablecoinIdsSchema = z.array(z.string().min(1)).max(20);

function hasUniqueIds(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isBoundedBulkSelection(value: { addStablecoinIds: string[]; removeStablecoinIds: string[] }): boolean {
  return value.addStablecoinIds.length + value.removeStablecoinIds.length <= 20
    && hasUniqueIds(value.addStablecoinIds)
    && hasUniqueIds(value.removeStablecoinIds)
    && !value.addStablecoinIds.some((stablecoinId) => value.removeStablecoinIds.includes(stablecoinId));
}

const BulkWatchlistSelectionSchema = z.object({
  addStablecoinIds: BulkStablecoinIdsSchema,
  removeStablecoinIds: BulkStablecoinIdsSchema,
}).strict().refine(
  (selection) => selection.addStablecoinIds.length + selection.removeStablecoinIds.length > 0,
  { message: "bulk watchlist selection must not be empty" },
).refine(isBoundedBulkSelection, {
  message: "bulk watchlist selection must contain at most 20 unique coins",
});

const BulkDirectRowSchema = z.object({
  stablecoinId: z.string().min(1),
  alertDews: z.boolean(),
  alertDepeg: z.boolean(),
  alertSafety: z.boolean(),
  alertLaunch: z.boolean(),
  alertReserve: z.boolean(),
  alertFreeze: z.boolean().optional(),
  overrideDews: z.boolean(),
  overrideDepeg: z.boolean(),
  overrideSafety: z.boolean(),
  overrideLaunch: z.boolean(),
  overrideReserve: z.boolean(),
  overrideFreeze: z.boolean().optional(),
  dewsMinBand: TelegramDewsBandSchema.nullable(),
  safetyMode: TelegramSafetyModeSchema.nullable(),
  depegWorseningBpsStep: NullableDepegStepSchema,
  snoozeUntilTs: z.number().int().nullable().optional(),
}).strict();

const DirectFingerprintSchema = z.string().regex(/^direct-v1-[0-9]+-[0-9a-f]{8}$/);
const UndoFingerprintSchema = z.string().regex(/^(?:undo-v1-[0-9]+-[0-9a-f]{64}|preview-v1-[0-9]+-[0-9a-f]{8})$/);

const TelegramMiniAppDirectStateProofSchema = z.object({
  preferenceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  directFingerprint: DirectFingerprintSchema,
}).strict();

const BulkWatchlistUndoSchema = z.object({
  expectedPreferenceGeneration: z.number().int().nonnegative(),
  expectedFingerprint: UndoFingerprintSchema,
  restoreDirectRows: z.array(BulkDirectRowSchema),
  removeStablecoinIds: z.array(z.string()),
}).strict();

export const TelegramMiniAppOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview-bulk-watchlist") })
    .merge(BulkWatchlistSelectionSchema)
    .strict(),
  z.object({
    kind: z.literal("confirm-bulk-watchlist"),
    expectedPreferenceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    previewFingerprint: z.string().regex(/^preview-v1-[0-9]+-[0-9a-f]{8}$/),
  }).merge(BulkWatchlistSelectionSchema).strict(),
  z.object({
    kind: z.literal("apply-bulk-watchlist"),
    expectedPreferenceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedDirectFingerprint: DirectFingerprintSchema,
  }).merge(BulkWatchlistSelectionSchema).strict(),
  z.object({
    kind: z.literal("undo-bulk-watchlist"),
    restoreDirectRows: z.array(BulkDirectRowSchema).max(20).refine(
      (rows) => hasUniqueIds(rows.map((row) => row.stablecoinId)),
      { message: "bulk undo rows must be unique" },
    ),
    removeStablecoinIds: BulkStablecoinIdsSchema,
    expectedPreferenceGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedFingerprint: UndoFingerprintSchema,
  }).strict().refine(
    (operation) => operation.restoreDirectRows.length + operation.removeStablecoinIds.length > 0
      && operation.restoreDirectRows.length + operation.removeStablecoinIds.length <= 20
      && !operation.restoreDirectRows.some((row) => operation.removeStablecoinIds.includes(row.stablecoinId)),
    { message: "bulk undo must contain at most 20 disjoint direct rows" },
  ),
  z
    .object({
      kind: z.literal("recommended-setup"),
      presetId: z.literal("usd-top25"),
      alertTypes: z.tuple([z.literal("dews"), z.literal("depeg")]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-global"),
      alertType: TelegramAlertTypeSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-global-depeg-step"),
      depegStepBps: NullableDepegStepSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-quiet-hours"),
      enabled: z.boolean(),
      startHourUtc: z.number().int().min(0).max(23).optional(),
      endHourUtc: z.number().int().min(0).max(23).optional(),
    })
    .strict()
    .refine(
      (operation) => {
        if (!operation.enabled) return true;
        // Validate the effective pair after the defaults the Worker applies, so
        // an omitted counterpart cannot complete into an enabled start === end
        // window that never suppresses a delivery.
        const startHourUtc = operation.startHourUtc ?? DEFAULT_QUIET_START_HOUR;
        const endHourUtc = operation.endHourUtc ?? DEFAULT_QUIET_END_HOUR;
        return startHourUtc !== endHourUtc;
      },
      { message: "quiet-hours start and end must differ" },
    ),
  z.object({ kind: z.literal("clear-snooze") }).strict(),
  z
    .object({
      kind: z.literal("set-snooze"),
      durationToken: SnoozeDurationTokenSchema,
    })
    .strict(),
  z.object({ kind: z.literal("pause") }).strict(),
  z
    .object({
      kind: z.literal("set-coin-snooze"),
      stablecoinId: z.string().min(1),
      durationToken: CoinSnoozeDurationTokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-timezone"),
      timezone: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("unsubscribe-all") }).strict(),
  z.object({ kind: z.literal("forget-me") }).strict(),
  z
    .object({
      kind: z.literal("set-coin"),
      stablecoinId: z.string().min(1),
      patch: CoinPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-coin"),
      stablecoinId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("follow-preset"),
      presetId: TelegramPresetIdSchema,
      alertTypes: z
        .object({
          dews: z.boolean().optional(),
          depeg: z.boolean().optional(),
          safety: z.boolean().optional(),
        })
        .strict(),
      depegStepBps: NullableDepegStepSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unfollow-preset"),
      presetId: TelegramPresetIdSchema,
    })
    .strict(),
]);

export type TelegramMiniAppOperation = z.infer<typeof TelegramMiniAppOperationSchema>;
export type TelegramMiniAppBulkWatchlistOperation = Extract<
  TelegramMiniAppOperation,
  { kind: "preview-bulk-watchlist" | "confirm-bulk-watchlist" | "apply-bulk-watchlist" | "undo-bulk-watchlist" }
>;
export type TelegramDewsBand = z.infer<typeof TelegramDewsBandSchema>;
export type TelegramDepegStepBps = z.infer<typeof TelegramDepegStepBpsSchema>;
export type TelegramSafetyMode = z.infer<typeof TelegramSafetyModeSchema>;
export type TelegramSnoozeDurationToken = z.infer<typeof SnoozeDurationTokenSchema>;
const VersionCapabilitySchema = z.object({
  contractVersion: z.string().min(1).max(64).optional(),
  catalogVersion: z.string().min(1).max(64).optional(),
});

export const TelegramMiniAppContextRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coins"),
    stablecoinIds: z.array(z.string().min(1).max(128)).min(1).max(20).refine(
      (ids) => hasUniqueIds(ids),
      { message: "contextRequest stablecoinIds must be unique" },
    ),
  }).strict(),
  z.object({
    kind: z.literal("presets"),
  }).strict(),
]);

export type TelegramMiniAppContextRequest = z.infer<typeof TelegramMiniAppContextRequestSchema>;

export const TelegramMiniAppSessionRequestSchema = VersionCapabilitySchema.extend({
  initData: z
    .string()
    .min(1)
    .max(8 * 1024),
  contextRequest: TelegramMiniAppContextRequestSchema.optional(),
}).strict();

export const TelegramMiniAppMutationRequestSchema = VersionCapabilitySchema.extend({
  initData: z
    .string()
    .min(1)
    .max(8 * 1024),
  operation: TelegramMiniAppOperationSchema,
}).strict();

const TelegramMiniAppCatalogCoinSchema = z
  .object({
    stablecoinId: z.string(),
    symbol: z.string(),
    name: z.string(),
    peg: z.string().nullable().optional(),
    pegLabel: z.string().optional(),
    status: z.string().nullable().optional(),
    rank: z.number().int().positive().optional(),
    variant: z.boolean().optional(),
    yieldBearing: z.boolean().optional(),
    liveReserves: z.boolean().optional(),
    freezeTracked: z.boolean().optional(),
  })
  .passthrough();

export const TelegramMiniAppCatalogSchema = z
  .object({
    recommendedPresets: z.array(
      z
        .object({
          id: TelegramPresetIdSchema,
          label: z.string(),
          description: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
    searchableCoins: z.array(TelegramMiniAppCatalogCoinSchema),
  })
  .passthrough();

export const TelegramMiniAppMutableStateSchema = z
  .object({
    viewer: z
      .object({
        userId: z.string(),
        username: z.string().nullable(),
        firstName: z.string().nullable().optional(),
        chatId: z.string().nullable(),
        chatType: z.string().nullable(),
        startParam: z.string().nullable().optional(),
        canMutate: z.boolean(),
        mutationBlockReason: z.enum(["not-private", "stale-auth"]).nullable(),
        /** First invalid unix second for the 5-minute write window (`authDate + 301`), or `null` for groups. */
        mutationAuthExpiresAt: z.number().int().nonnegative().nullable().optional(),
      })
      .passthrough(),
    subscriber: z
      .object({
        exists: z.boolean(),
        globalAlerts: AlertTypesSchema.extend({
          depegStepBps: NullableDepegStepSchema,
        }).passthrough(),
        quietHours: z
          .object({
            enabled: z.boolean(),
            startHourUtc: z.number().nullable(),
            endHourUtc: z.number().nullable(),
            timezone: z.string().nullable(),
          })
          .passthrough(),
        snoozeUntilTs: z.number().nullable(),
      })
      .passthrough(),
    presets: z.array(
      z
        .object({
          id: TelegramPresetIdSchema,
          label: z.string(),
          description: z.string().optional(),
          alertTypes: PresetAlertTypesSchema,
          depegStepBps: NullableDepegStepSchema,
          // Current members resolved against the live market-cap cache. Null or
          // absent means membership could not be read; never treat it as empty.
          memberIds: z.array(z.string()).nullable().optional(),
        })
        .passthrough(),
    ),
    subscriptions: z.array(
      z
        .object({
          stablecoinId: z.string(),
          symbol: z.string(),
          name: z.string(),
          alertTypes: AlertTypesSchema,
          alertOverrides: AlertTypesSchema.optional(),
          dewsMinBand: TelegramDewsBandSchema.nullable(),
          depegStepBps: NullableDepegStepSchema,
          safetyMode: TelegramSafetyModeSchema.nullable(),
          snoozeUntilTs: z.number().nullable(),
        })
        .passthrough(),
    ),
    health: z
      .object({
        lastSuccessfulDeliveryAt: z.number().nullable(),
        lastSuccessfulReplyAt: z.number().nullable(),
        queuedAlerts: z.number(),
        recentFailureClass: z.string().nullable(),
        // Absent on older Workers; false means the diagnostics read failed.
        diagnosticsAvailable: z.boolean().optional(),
      })
      .passthrough(),
    /** Proof over ALL stored direct rows from the same transactional read as `subscriptions[]`; `null` for groups. */
    directStateProof: TelegramMiniAppDirectStateProofSchema.nullable().optional(),
  })
  .passthrough();

export const TelegramMiniAppStateSchema = TelegramMiniAppMutableStateSchema.extend({
  catalog: TelegramMiniAppCatalogSchema,
}).passthrough();

const TelegramMiniAppBulkSourceImpactSchema = z.object({
  stablecoinId: z.string(),
  action: z.enum(["add", "remove"]),
  inheritedSourcesAfter: z.array(z.enum(["preset", "global"])),
}).strict();

const TelegramMiniAppBulkApplyResultSchema = z.object({
  adds: z.array(z.string()),
  removes: z.array(z.string()),
  unchanged: z.array(z.string()),
  sourceImpact: z.array(TelegramMiniAppBulkSourceImpactSchema),
}).strict();

export const TelegramMiniAppSnapshotSchema = z
  .object({
    contractVersion: z.string(),
    catalogVersion: z.string(),
    serverNowSec: z.number().int().nonnegative(),
    stateRevision: z.string(),
    state: TelegramMiniAppMutableStateSchema,
    undo: BulkWatchlistUndoSchema.optional(),
    bulkResult: TelegramMiniAppBulkApplyResultSchema.optional(),
  })
  .strict();

export const TelegramMiniAppResponseSchema = z.union([TelegramMiniAppSnapshotSchema, TelegramMiniAppStateSchema]);

export const TelegramMiniAppBulkWatchlistResponseSchema = z.object({
  contractVersion: z.string(),
  catalogVersion: z.string(),
  result: z.object({
    kind: z.literal("bulk-watchlist-preview"),
    expectedPreferenceGeneration: z.number().int().nonnegative(),
    previewFingerprint: z.string().regex(/^preview-v1-[0-9]+-[0-9a-f]{8}$/),
    adds: z.array(z.string()),
    removes: z.array(z.string()),
    unchanged: z.array(z.string()),
    sourceImpact: z.array(TelegramMiniAppBulkSourceImpactSchema),
    undo: BulkWatchlistUndoSchema,
  }).strict(),
}).strict();

const ContextProvenanceBase = {
  source: z.string().min(1),
  assessedAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative().nullable(),
  generation: z.string().min(1).nullable(),
  budgetSec: z.number().int().positive(),
};

const TelegramMiniAppContextProvenanceSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...ContextProvenanceBase,
  }).strict(),
  z.object({
    status: z.literal("stale"),
    ...ContextProvenanceBase,
    reason: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    ...ContextProvenanceBase,
    reason: z.string().min(1),
  }).strict(),
]);

const TelegramMiniAppActiveDepegSchema = z.object({
  stablecoinId: z.string().min(1),
  direction: z.enum(["above", "below"]),
  peakDeviationBps: z.number().finite(),
  currentDeviationBps: z.number().finite().nullable(),
  currentDirection: z.enum(["above", "below"]).nullable().optional(),
  currentPeerRelative: z.literal(true).optional(),
  priceUsd: z.number().finite().positive().nullable(),
  pegReference: z.number().finite().positive().nullable(),
  startedAt: z.number().int().nonnegative(),
  peerRelative: z.literal(true).optional(),
  peerOpening: z.literal(true).optional(),
  peakBasisUnavailable: z.literal(true).optional(),
}).strict();

const TelegramMiniAppCoinPriceSignalSchema = z.object({
  provenance: TelegramMiniAppContextProvenanceSchema,
  priceUsd: z.number().finite().positive().nullable(),
}).strict();

const TelegramMiniAppCoinDewsSignalSchema = z.object({
  provenance: TelegramMiniAppContextProvenanceSchema,
  band: z.enum(["CALM", "WATCH", "ALERT", "WARNING", "DANGER"]).nullable(),
  score: z.number().finite().min(0).max(100).nullable(),
}).strict();

const TelegramMiniAppCoinSafetySignalSchema = z.object({
  provenance: TelegramMiniAppContextProvenanceSchema,
  ratingStatus: z.enum(["rated", "not-rated", "pipeline-gap"]).nullable(),
  grade: z.string().min(1).nullable(),
  score: z.number().finite().min(0).max(100).nullable(),
  held: z.boolean(),
  partialEvidence: z.boolean().optional(),
  methodologyVersion: z.string().min(1).nullable(),
  publicationId: z.string().min(1).nullable(),
}).strict();

const TelegramMiniAppCoinSignalSchema = z.object({
  price: TelegramMiniAppCoinPriceSignalSchema,
  dews: TelegramMiniAppCoinDewsSignalSchema,
  safety: TelegramMiniAppCoinSafetySignalSchema,
  pegStatus: z.enum(["on-peg", "off-peg", "not-monitored", "unavailable"]).optional(),
}).strict();

const TelegramMiniAppPresetSummarySchema = z.object({
  id: TelegramPresetIdSchema,
  memberCount: z.number().int().nonnegative(),
  topSymbols: z.array(z.string().min(1)).max(3),
}).strict();

const TelegramMiniAppContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coins"),
    activeDepegs: z.object({
      provenance: TelegramMiniAppContextProvenanceSchema,
      events: z.array(TelegramMiniAppActiveDepegSchema),
    }).strict(),
    coinSignals: z.record(z.string(), TelegramMiniAppCoinSignalSchema),
  }).strict(),
  z.object({
    kind: z.literal("presets"),
    provenance: TelegramMiniAppContextProvenanceSchema,
    presets: z.array(TelegramMiniAppPresetSummarySchema),
  }).strict(),
]);

export const TelegramMiniAppContextResponseSchema = z.object({
  contractVersion: z.string(),
  catalogVersion: z.string(),
  serverNowSec: z.number().int().nonnegative(),
  context: TelegramMiniAppContextSchema,
}).strict();

export const TelegramMiniAppErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum(TELEGRAM_MINI_APP_ERROR_CODES),
    retryAfterSec: z.number().optional(),
    contractVersion: z.string().optional(),
    catalogVersion: z.string().optional(),
  })
  .passthrough();

export type TelegramMiniAppMutableState = z.infer<typeof TelegramMiniAppMutableStateSchema>;
export type TelegramMiniAppState = z.infer<typeof TelegramMiniAppStateSchema>;
export type TelegramMiniAppSnapshot = z.infer<typeof TelegramMiniAppSnapshotSchema>;
export type TelegramMiniAppResponse = z.infer<typeof TelegramMiniAppResponseSchema>;
export type TelegramMiniAppBulkApplyResult = z.infer<typeof TelegramMiniAppBulkApplyResultSchema>;
export type TelegramMiniAppBulkWatchlistResponse = z.infer<typeof TelegramMiniAppBulkWatchlistResponseSchema>;
export type TelegramMiniAppContextProvenance = z.infer<typeof TelegramMiniAppContextProvenanceSchema>;
export type TelegramMiniAppActiveDepeg = z.infer<typeof TelegramMiniAppActiveDepegSchema>;
export type TelegramMiniAppCoinSignal = z.infer<typeof TelegramMiniAppCoinSignalSchema>;
export type TelegramMiniAppPresetSummary = z.infer<typeof TelegramMiniAppPresetSummarySchema>;
export type TelegramMiniAppContext = z.infer<typeof TelegramMiniAppContextSchema>;
export type TelegramMiniAppCoinsContext = Extract<TelegramMiniAppContext, { kind: "coins" }>;
export type TelegramMiniAppPresetsContext = Extract<TelegramMiniAppContext, { kind: "presets" }>;
export type TelegramMiniAppContextResponse = z.infer<typeof TelegramMiniAppContextResponseSchema>;

export function telegramMiniAppStateRevision(state: TelegramMiniAppMutableState): string {
  const serialized = JSON.stringify(state);
  return `state-v1-${serialized.length}-${fnv1a32Hex(serialized)}`;
}

export function createTelegramMiniAppSnapshot(
  state: TelegramMiniAppMutableState,
  serverNowSec = Math.floor(Date.now() / 1000),
): TelegramMiniAppSnapshot {
  return {
    contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    serverNowSec,
    stateRevision: telegramMiniAppStateRevision(state),
    state,
  };
}

export type TelegramMiniAppVersionCompatibility =
  "legacy" | "compatible" | "contract-version-mismatch" | "catalog-version-mismatch";

export function telegramMiniAppVersionCompatibility(input: {
  contractVersion?: string;
  catalogVersion?: string;
}): TelegramMiniAppVersionCompatibility {
  if (input.contractVersion == null && input.catalogVersion == null) return "legacy";
  if (input.contractVersion !== TELEGRAM_MINI_APP_CONTRACT_VERSION) return "contract-version-mismatch";
  if (input.catalogVersion !== TELEGRAM_MINI_APP_CATALOG_VERSION) return "catalog-version-mismatch";
  return "compatible";
}
