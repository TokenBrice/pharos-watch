import { z } from "zod";

const AlertTypeSchema = z.enum(["dews", "depeg", "safety", "launch"]);
const PresetAlertTypeSchema = z.enum(["dews", "depeg", "safety"]);
const DewsBandSchema = z.enum(["ALERT", "WARNING", "DANGER"]);
const DepegStepSchema = z.union([z.literal(100), z.literal(250), z.literal(500)]).nullable();
const SafetyModeSchema = z.enum(["all", "downgrade-only", "upgrade-only"]).nullable();
const TelegramPresetIdSchema = z.enum([
  "usd-top10",
  "usd-top25",
  "usd-top50",
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
  }).optional(),
  dewsMinBand: DewsBandSchema.nullable().optional(),
  depegStepBps: DepegStepSchema.optional(),
  safetyMode: SafetyModeSchema.optional(),
  launch: z.boolean().optional(),
});

export const TelegramMiniAppSessionRequestSchema = z.object({
  initData: z.string().min(1),
  startParam: z.string().nullable().optional(),
});

const TelegramMiniAppOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recommended-setup"),
    presetId: TelegramPresetIdSchema,
    alertTypes: z.array(PresetAlertTypeSchema).min(1),
  }),
  z.object({
    kind: z.literal("set-global"),
    alertType: AlertTypeSchema,
    enabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("set-quiet-hours"),
    enabled: z.boolean(),
    startHourUtc: z.number().int().min(0).max(23).optional(),
    endHourUtc: z.number().int().min(0).max(23).optional(),
  }),
  z.object({ kind: z.literal("clear-snooze") }),
  z.object({
    kind: z.literal("set-coin"),
    stablecoinId: z.string().min(1),
    patch: CoinPatchSchema,
  }),
  z.object({
    kind: z.literal("remove-coin"),
    stablecoinId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("follow-preset"),
    presetId: TelegramPresetIdSchema,
    alertTypes: z.object({
      dews: z.boolean().optional(),
      depeg: z.boolean().optional(),
      safety: z.boolean().optional(),
    }),
    depegStepBps: DepegStepSchema.optional(),
  }),
  z.object({
    kind: z.literal("unfollow-preset"),
    presetId: TelegramPresetIdSchema,
  }),
]);

export type TelegramMiniAppOperation = z.infer<typeof TelegramMiniAppOperationSchema>;

export const TelegramMiniAppMutationRequestSchema = z.object({
  initData: z.string().min(1),
  operation: TelegramMiniAppOperationSchema,
});
