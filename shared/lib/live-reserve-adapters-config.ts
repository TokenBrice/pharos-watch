import { z } from "zod";
import {
  type LiveReserveAdapterKey,
  type LiveReservesConfig,
} from "../types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DESCRIPTORS } from "./live-reserve-adapter-descriptors";
import {
  adapterParamsSchemas,
  baseLiveReserveConfigSchema,
  createLiveReserveInputsSchema,
} from "./live-reserve-adapters-schemas";

function validateAdapterConfigPolicy(
  adapterKey: LiveReserveAdapterKey,
  config: Pick<LiveReservesConfig, "semantics" | "version">,
  ctx: z.RefinementCtx,
): void {
  const policy = LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey].configValidation;
  const allowedSemantics = policy.allowedSemantics as readonly LiveReservesConfig["semantics"][];
  const allowedVersions = policy.allowedVersions as readonly number[];

  if (!allowedSemantics.includes(config.semantics)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["semantics"],
      message: `${adapterKey} adapter does not support semantics "${config.semantics}"`,
    });
  }

  if (!allowedVersions.includes(config.version)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message: `${adapterKey} adapter does not support config version ${config.version}`,
    });
  }
}

const liveReserveConfigAdapterKeys = Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTORS) as LiveReserveAdapterKey[];

const liveReserveConfigVariants = liveReserveConfigAdapterKeys.map((adapterKey) =>
  baseLiveReserveConfigSchema.extend({
    adapter: z.literal(adapterKey),
    inputs: createLiveReserveInputsSchema(adapterKey),
    params: adapterParamsSchemas[adapterKey].optional(),
  }).superRefine((config, ctx) => validateAdapterConfigPolicy(adapterKey, config, ctx)),
// Zod discriminatedUnion requires a non-empty tuple type that TS cannot infer from array operations
) as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]];

export const LiveReservesConfigSchema: z.ZodType<LiveReservesConfig> = z.union(
  // Zod union requires a non-empty tuple type that TS cannot infer from the mapped array
  liveReserveConfigVariants as unknown as [z.ZodType<LiveReservesConfig>, ...z.ZodType<LiveReservesConfig>[]],
);
