import { z } from "zod";
import { type LiveReserveAdapterKey } from "../types/live-reserves";
import {
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES,
} from "./live-reserve-adapter-descriptors";
import { LiveReservesConfigSchema } from "./live-reserve-adapters-config";
import {
  adapterParamsSchemas,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  type LiveReserveAdapterParamsByKey,
  type LiveReserveAdapterParams,
} from "./live-reserve-adapters-schemas";
import { LIVE_RESERVE_ADAPTER_PROVENANCE, LIVE_RESERVE_ADAPTER_STATUS_VALUES } from "./live-reserve-adapter-descriptors";

export type LiveReserveRedemptionCapacityTelemetry = "direct" | "proxy" | "none";
export type LiveReserveRedemptionFeeTelemetry = "current-bps" | "none";

export {
  LiveReservesConfigSchema,
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  LIVE_RESERVE_ADAPTER_PROVENANCE,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
};
export { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "./live-reserve-adapter-descriptors";

export type { LiveReserveAdapterParamsByKey, LiveReserveAdapterParams };
export type { LiveReserveAdapterDescriptorMap } from "./live-reserve-adapter-descriptors";

export function getLiveReserveAdapterDefinition(
  adapterKey: string,
): (typeof LIVE_RESERVE_ADAPTER_DESCRIPTORS)[LiveReserveAdapterKey] | null {
  return LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey as LiveReserveAdapterKey] ?? null;
}

export function parseLiveReserveAdapterParams<K extends LiveReserveAdapterKey>(
  adapterKey: K,
  params: Record<string, unknown> | undefined,
): LiveReserveAdapterParamsByKey[K] {
  // Zod indexed access loses the per-key type; cast aligns the schema with the keyed params type
  const schema = adapterParamsSchemas[adapterKey] as unknown as z.ZodType<LiveReserveAdapterParamsByKey[K]>;
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
  throw new Error(`${adapterKey} adapter params invalid${path}: ${issue?.message ?? "unknown validation error"}`);
}
