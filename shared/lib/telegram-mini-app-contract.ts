import { z } from "zod";
import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "./telegram-mini-app-catalog";
import { TELEGRAM_PRESET_IDS } from "./telegram-presets";

export const TELEGRAM_MINI_APP_CONTRACT_VERSION = "2";
export const TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM = "mini_app_contract";
export const TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM = "mini_app_catalog";
export { TELEGRAM_MINI_APP_CATALOG_VERSION };

export const TELEGRAM_MINI_APP_ERROR_CODES = [
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
  "contract-version-mismatch",
  "catalog-version-mismatch",
] as const;

export type TelegramMiniAppErrorCode = (typeof TELEGRAM_MINI_APP_ERROR_CODES)[number];

const MINI_APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(TELEGRAM_MINI_APP_ERROR_CODES);

export function isTelegramMiniAppErrorCode(value: unknown): value is TelegramMiniAppErrorCode {
  return typeof value === "string" && MINI_APP_ERROR_CODE_SET.has(value);
}

export const TelegramAlertTypeSchema = z.enum(["dews", "depeg", "safety", "launch", "reserve"]);
export const TelegramDewsBandSchema = z.enum(["ALERT", "WARNING", "DANGER"]);
export const TelegramDepegStepBpsSchema = z.union([z.literal(100), z.literal(250), z.literal(500)]);
export const TelegramSafetyModeSchema = z.enum(["all", "downgrade-only", "upgrade-only"]);
export const TelegramPresetIdSchema = z.enum(TELEGRAM_PRESET_IDS);

const NullableDepegStepSchema = TelegramDepegStepBpsSchema.nullable();
const AlertTypesSchema = z
  .object({
    dews: z.boolean(),
    depeg: z.boolean(),
    safety: z.boolean(),
    launch: z.boolean(),
    reserve: z.boolean(),
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
      })
      .strict()
      .optional(),
    dewsMinBand: TelegramDewsBandSchema.nullable().optional(),
    depegStepBps: NullableDepegStepSchema.optional(),
    safetyMode: TelegramSafetyModeSchema.nullable().optional(),
    launch: z.boolean().optional(),
    reserve: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "set-coin patch must include at least one field",
  });

const SnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h"]);
const CoinSnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h", "clear"]);

export const TelegramMiniAppOperationSchema = z.discriminatedUnion("kind", [
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
        if (operation.startHourUtc == null || operation.endHourUtc == null) return true;
        return operation.startHourUtc !== operation.endHourUtc;
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
export type TelegramAlertType = z.infer<typeof TelegramAlertTypeSchema>;
export type TelegramDewsBand = z.infer<typeof TelegramDewsBandSchema>;
export type TelegramDepegStepBps = z.infer<typeof TelegramDepegStepBpsSchema>;
export type TelegramSafetyMode = z.infer<typeof TelegramSafetyModeSchema>;
export type TelegramSnoozeDurationToken = z.infer<typeof SnoozeDurationTokenSchema>;
export type TelegramCoinSnoozeDurationToken = z.infer<typeof CoinSnoozeDurationTokenSchema>;

const VersionCapabilitySchema = z.object({
  contractVersion: z.string().min(1).max(64).optional(),
  catalogVersion: z.string().min(1).max(64).optional(),
});

export const TelegramMiniAppSessionRequestSchema = VersionCapabilitySchema.extend({
  initData: z
    .string()
    .min(1)
    .max(8 * 1024),
}).strict();

export const TelegramMiniAppMutationRequestSchema = VersionCapabilitySchema.extend({
  initData: z
    .string()
    .min(1)
    .max(8 * 1024),
  operation: TelegramMiniAppOperationSchema,
}).strict();

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
    searchableCoins: z.array(
      z
        .object({
          stablecoinId: z.string(),
          symbol: z.string(),
          name: z.string(),
          peg: z.string().nullable().optional(),
          status: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
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
      })
      .passthrough(),
  })
  .passthrough();

export const TelegramMiniAppStateSchema = TelegramMiniAppMutableStateSchema.extend({
  catalog: TelegramMiniAppCatalogSchema,
}).passthrough();

export const TelegramMiniAppSnapshotSchema = z
  .object({
    contractVersion: z.string(),
    catalogVersion: z.string(),
    stateRevision: z.string(),
    state: TelegramMiniAppMutableStateSchema,
  })
  .strict();

export const TelegramMiniAppResponseSchema = z.union([TelegramMiniAppSnapshotSchema, TelegramMiniAppStateSchema]);

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

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function telegramMiniAppStateRevision(state: TelegramMiniAppMutableState): string {
  const serialized = JSON.stringify(state);
  return `state-v1-${serialized.length}-${fnv1a32(serialized)}`;
}

export function createTelegramMiniAppSnapshot(state: TelegramMiniAppMutableState): TelegramMiniAppSnapshot {
  return {
    contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
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
