import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";

import { buildPoolFingerprint } from "../dex-liquidity/pool-helpers";
import { buildMeasuredPoolDirectionKey } from "./inventory";

const RETAINED_TARGET_FINGERPRINT_MAX_TVL_RELATIVE_DRIFT = 0.005;

export type DexMeasuredTargetFingerprintIndex = Map<string, DexMeasuredExecutionTarget[]>;

function fingerprintDirectionKey(stablecoinId: string, fingerprint: string): string {
  return `${stablecoinId}|${fingerprint}`;
}

/**
 * Build a same-asset fingerprint census without collapsing multiple physical
 * pools that share a token pair. Resolution applies the ambiguity rule later,
 * against the retained row's contemporaneous TVL.
 */
export function buildDexMeasuredTargetFingerprintIndex(
  targets: Iterable<DexMeasuredExecutionTarget>,
): DexMeasuredTargetFingerprintIndex {
  const index: DexMeasuredTargetFingerprintIndex = new Map();
  for (const target of targets) {
    if (target.poolTokenAddresses?.length !== 2) continue;
    const fingerprint = buildPoolFingerprint(
      target.chain,
      target.protocol,
      [...target.poolTokenAddresses],
    );
    if (!fingerprint) continue;
    const key = fingerprintDirectionKey(target.stablecoinId, fingerprint);
    const candidates = index.get(key) ?? [];
    candidates.push(target);
    index.set(key, candidates);
  }
  return index;
}

/**
 * Resolve an exact retained pool id first. Fingerprint-only retained rows may
 * use one same-family target only when exactly one physical candidate is within
 * the bounded contemporaneous-TVL window; no match or multiple matches fail
 * closed.
 */
export function resolveDexMeasuredTargetForRetainedPool(input: {
  stablecoinId: string;
  retainedPoolId: string;
  retainedTvlUsd: number;
  adapterProfileId: DexMeasuredExecutionTarget["adapterProfileId"];
  exactTargets: ReadonlyMap<string, DexMeasuredExecutionTarget>;
  fingerprintTargets: ReadonlyMap<string, readonly DexMeasuredExecutionTarget[]>;
  maxTvlRelativeDrift?: number;
}): DexMeasuredExecutionTarget | null {
  const exact = input.exactTargets.get(
    buildMeasuredPoolDirectionKey(input.stablecoinId, input.retainedPoolId),
  );
  if (exact) {
    return exact.adapterProfileId === input.adapterProfileId ? exact : null;
  }
  if (!input.retainedPoolId.startsWith("fp:")) return null;
  if (!Number.isFinite(input.retainedTvlUsd) || input.retainedTvlUsd <= 0) return null;

  const maxTvlRelativeDrift =
    input.maxTvlRelativeDrift ?? RETAINED_TARGET_FINGERPRINT_MAX_TVL_RELATIVE_DRIFT;
  if (!Number.isFinite(maxTvlRelativeDrift) || maxTvlRelativeDrift < 0) return null;

  const candidates = input.fingerprintTargets.get(
    fingerprintDirectionKey(input.stablecoinId, input.retainedPoolId),
  ) ?? [];
  const matching = candidates.filter(
    (candidate) =>
      candidate.adapterProfileId === input.adapterProfileId &&
      Number.isFinite(candidate.retainedTvlUsd) &&
      candidate.retainedTvlUsd > 0 &&
      Math.abs(candidate.retainedTvlUsd / input.retainedTvlUsd - 1) <= maxTvlRelativeDrift,
  );
  return matching.length === 1 ? matching[0]! : null;
}
