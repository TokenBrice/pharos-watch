import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  SolanaMeasuredExecutionTargetSchema,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
  type SolanaMeasuredExecutionToken,
} from "@shared/types/solana-measured-execution";
import {
  buildNativeMeasuredExecutionTargets,
  buildNativeMeasuredPoolDirectionKey,
  type NativeMeasuredExecutionInventoryAdapter,
  type NativeMeasuredExecutionInventoryInput,
} from "./native-inventory";
import {
  getSolanaMeasuredExecutionAdapter,
  getSolanaMeasuredExecutionPriorityTarget,
} from "./solana-registry";

/** Keep the native target denominator aligned with the bounded public route payload. */
export const SOLANA_MEASURED_TARGETS_PER_STABLECOIN = 10;

export function boundSolanaMeasuredExecutionTargets(
  candidates: ReadonlyMap<string, SolanaMeasuredExecutionTarget>,
  perStablecoinLimit = SOLANA_MEASURED_TARGETS_PER_STABLECOIN,
): Map<string, SolanaMeasuredExecutionTarget> {
  if (!Number.isInteger(perStablecoinLimit) || perStablecoinLimit < 1) {
    throw new RangeError("Solana measured target per-stablecoin limit must be positive");
  }
  const byStablecoin = new Map<string, Array<[string, SolanaMeasuredExecutionTarget]>>();
  for (const entry of candidates) {
    const rows = byStablecoin.get(entry[1].stablecoinId) ?? [];
    rows.push(entry);
    byStablecoin.set(entry[1].stablecoinId, rows);
  }

  const targets = new Map<string, SolanaMeasuredExecutionTarget>();
  for (const rows of byStablecoin.values()) {
    rows.sort(
      (left, right) =>
        Number(getSolanaMeasuredExecutionPriorityTarget(right[1]) !== null) -
          Number(getSolanaMeasuredExecutionPriorityTarget(left[1]) !== null) ||
        right[1].retainedTvlUsd - left[1].retainedTvlUsd ||
        left[1].targetId.localeCompare(right[1].targetId),
    );
    for (const [key, target] of rows.slice(0, perStablecoinLimit)) targets.set(key, target);
  }
  return targets;
}

export function buildSolanaMeasuredPoolDirectionKey(stablecoinId: string, poolId: string): string {
  return buildNativeMeasuredPoolDirectionKey({
    stablecoinId,
    chain: "solana",
    poolId,
    stripChainPrefix: true,
  });
}

type SolanaPoolAdapter = NonNullable<ReturnType<typeof getSolanaMeasuredExecutionAdapter>>;

const SOLANA_INVENTORY_ADAPTER: NativeMeasuredExecutionInventoryAdapter<
  SolanaMeasuredExecutionTarget,
  SolanaPoolAdapter
> = {
  chain: "solana",
  stripPoolChainPrefix: true,
  getPoolAdapter: (pool) => getSolanaMeasuredExecutionAdapter(pool.source, pool.poolType),
  isPoolEligible: () => true,
  buildTarget: ({ pool, poolId, stablecoinId, tokenIn, tokenOut, adapter, capturedAt }) => {
    const targetId = buildSolanaMeasuredExecutionTargetId({
      stablecoinId,
      adapterProfileId: adapter.adapterProfileId,
      protocol: adapter.protocol,
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
    });
    const parsed = SolanaMeasuredExecutionTargetSchema.safeParse({
      schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
      targetId,
      stablecoinId,
      adapterProfileId: adapter.adapterProfileId,
      protocol: adapter.protocol,
      chain: "solana",
      poolId,
      poolType: adapter.poolType,
      tokenIn: tokenIn as SolanaMeasuredExecutionToken,
      tokenOut: tokenOut as SolanaMeasuredExecutionToken,
      retainedTvlUsd: pool.tvlUsd,
      retainedPoolPriceUsd: tokenIn.referencePriceUsd,
      capturedAt,
    });
    return parsed.success ? parsed.data : null;
  },
};

export function buildSolanaMeasuredExecutionTargets(
  input: NativeMeasuredExecutionInventoryInput,
): Map<string, SolanaMeasuredExecutionTarget> {
  const candidates = buildNativeMeasuredExecutionTargets(input, SOLANA_INVENTORY_ADAPTER);
  return boundSolanaMeasuredExecutionTargets(candidates);
}
