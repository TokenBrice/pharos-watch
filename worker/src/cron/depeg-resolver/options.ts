import { DEFAULT_DDR_V2_STORE_CONTRACTS } from "./storage-adapters";
import type { ComputeDepegResolverV2Options, NormalizedComputeDepegResolverOptions } from "./types";
import { allocateDdrRunId } from "./utils";

export function normalizeComputeOptions(
  input: D1Database | ComputeDepegResolverV2Options,
  signal?: AbortSignal,
): NormalizedComputeDepegResolverOptions {
  const hasDb = typeof input === "object" && input != null && "db" in input;
  const nowSec = Math.floor(Date.now() / 1000);
  const options = hasDb ? input as ComputeDepegResolverV2Options : { db: input, signal };
  const runAt = options.runAt ?? nowSec;
  const slot = options.slot ?? "quarter-hour";
  return {
    db: options.db,
    signal: options.signal ?? signal,
    ddrRunId: options.ddrRunId ?? allocateDdrRunId(slot, runAt),
    runAt,
    slot,
    stablecoinsCacheSafe: options.stablecoinsCacheSafe ?? true,
    depegPipelineHealthy: options.depegPipelineHealthy ?? true,
    syncCapabilities: options.syncCapabilities ?? {},
    storeContracts: options.storeContracts ?? DEFAULT_DDR_V2_STORE_CONTRACTS,
  };
}
