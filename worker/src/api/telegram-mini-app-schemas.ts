import { z } from "zod";

const AlertTypeSchema = z.enum(["dews", "depeg", "safety", "launch"]);
const DewsBandSchema = z.enum(["ALERT", "WARNING", "DANGER"]);
const DepegStepSchema = z.union([z.literal(100), z.literal(250), z.literal(500)]).nullable();
const SafetyModeSchema = z.enum(["all", "downgrade-only", "upgrade-only"]).nullable();
const TelegramPresetIdSchema = z.enum([
  "usd-top10",
  "usd-top25",
  "usd-top50",
  "non-usd-top10",
  "non-usd-top25",
  "non-usd-top50",
  "eur-top10",
  "gold-top5",
  "mcap-ge-1b",
  "mcap-ge-100m",
]);

const CoinPatchSchema = z.object({
  alertTypes: z.object({
    dews: z.boolean().optional(),
    depeg: z.boolean().optional(),
    safety: z.boolean().optional(),
    launch: z.boolean().optional(),
  }).strict().optional(),
  dewsMinBand: DewsBandSchema.nullable().optional(),
  depegStepBps: DepegStepSchema.optional(),
  safetyMode: SafetyModeSchema.optional(),
  launch: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: "set-coin patch must include at least one field",
});

export const TelegramMiniAppSessionRequestSchema = z.object({
  initData: z.string().min(1).max(8 * 1024),
}).strict();

const SnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h"]);
const CoinSnoozeDurationTokenSchema = z.enum(["1h", "4h", "24h", "clear"]);

const TelegramMiniAppOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recommended-setup"),
    presetId: z.literal("usd-top25"),
    alertTypes: z.tuple([z.literal("dews"), z.literal("depeg")]),
  }).strict(),
  z.object({
    kind: z.literal("set-global"),
    alertType: AlertTypeSchema,
    enabled: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("set-global-depeg-step"),
    depegStepBps: DepegStepSchema,
  }).strict(),
  z.object({
    kind: z.literal("set-quiet-hours"),
    enabled: z.boolean(),
    startHourUtc: z.number().int().min(0).max(23).optional(),
    endHourUtc: z.number().int().min(0).max(23).optional(),
  }).strict().refine(
    (operation) => {
      if (!operation.enabled) return true;
      if (operation.startHourUtc == null || operation.endHourUtc == null) return true;
      return operation.startHourUtc !== operation.endHourUtc;
    },
    { message: "quiet-hours start and end must differ" },
  ),
  z.object({ kind: z.literal("clear-snooze") }).strict(),
  z.object({
    kind: z.literal("set-snooze"),
    durationToken: SnoozeDurationTokenSchema,
  }).strict(),
  z.object({
    kind: z.literal("set-coin-snooze"),
    stablecoinId: z.string().min(1),
    durationToken: CoinSnoozeDurationTokenSchema,
  }).strict(),
  z.object({
    kind: z.literal("set-timezone"),
    timezone: z.string().min(1).max(64).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unsubscribe-all") }).strict(),
  z.object({ kind: z.literal("forget-me") }).strict(),
  z.object({
    kind: z.literal("set-coin"),
    stablecoinId: z.string().min(1),
    patch: CoinPatchSchema,
  }).strict(),
  z.object({
    kind: z.literal("remove-coin"),
    stablecoinId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("follow-preset"),
    presetId: TelegramPresetIdSchema,
    alertTypes: z.object({
      dews: z.boolean().optional(),
      depeg: z.boolean().optional(),
      safety: z.boolean().optional(),
    }).strict(),
    depegStepBps: DepegStepSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("unfollow-preset"),
    presetId: TelegramPresetIdSchema,
  }).strict(),
]);

export type TelegramMiniAppOperation = z.infer<typeof TelegramMiniAppOperationSchema>;

export const TelegramMiniAppMutationRequestSchema = z.object({
  initData: z.string().min(1).max(8 * 1024),
  operation: TelegramMiniAppOperationSchema,
}).strict();
