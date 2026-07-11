import { z } from "zod";
import type { LiveReserveAdapterKey } from "./live-reserve-adapter-descriptors";
import { adapterParamsSchemas, LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS } from "./live-reserve-adapter-descriptors";
import { createLiveReserveInputSchemaForKinds } from "./live-reserve-adapter-schema-primitives";

export * from "./live-reserve-adapter-schema-primitives";
export {
  adapterParamsSchemas,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  liveReserveAdapterSchemaMetadata,
} from "./live-reserve-adapter-descriptors";

export function createLiveReserveInputsSchema(adapterKey: LiveReserveAdapterKey): z.ZodTypeAny {
  const inputSchema = createLiveReserveInputSchemaForKinds(LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[adapterKey]);
  return z
    .object({
      primary: inputSchema,
      fallbacks: z.array(inputSchema).optional(),
    })
    .strict();
}

export type LiveReserveAdapterParamsByKey = {
  [K in LiveReserveAdapterKey]: z.infer<(typeof adapterParamsSchemas)[K]>;
};

export type LiveReserveAdapterParams = LiveReserveAdapterParamsByKey[LiveReserveAdapterKey];
export type LiveReserveAdapterParamsSchemaMap = typeof adapterParamsSchemas;
export type LiveReserveAdapterParamsSchemaKey = keyof LiveReserveAdapterParamsSchemaMap;
