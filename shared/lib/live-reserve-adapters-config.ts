import { z } from "zod";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReservesConfig } from "../types/live-reserves";
import {
  adapterParamsSchemas,
  baseLiveReserveConfigSchema,
  createLiveReserveInputsSchema,
} from "./live-reserve-adapters-schemas";

const liveReserveConfigVariants = LIVE_RESERVE_ADAPTER_KEYS.map((adapterKey) =>
  baseLiveReserveConfigSchema.extend({
    adapter: z.literal(adapterKey),
    inputs: createLiveReserveInputsSchema(adapterKey),
    params: adapterParamsSchemas[adapterKey].optional(),
  }),
// Zod discriminatedUnion requires a non-empty tuple type that TS cannot infer from array operations
) as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]];

export const LiveReservesConfigSchema: z.ZodType<LiveReservesConfig> = z.union(
  // Zod union requires a non-empty tuple type that TS cannot infer from the mapped array
  liveReserveConfigVariants as unknown as [z.ZodType<LiveReservesConfig>, ...z.ZodType<LiveReservesConfig>[]],
);
