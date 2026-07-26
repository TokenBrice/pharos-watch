import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { buildPoolFingerprint } from "../../dex-liquidity/pool-helpers";
import { buildMeasuredPoolDirectionKey } from "../inventory";
import {
  buildDexMeasuredTargetFingerprintIndex,
  resolveDexMeasuredTargetForRetainedPool,
} from "../retained-target-resolution";

const CADC = "0x043eb4b75d0805c43d7c834902e335621983cf03";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL = "base:0x09da4832d34bebbb55783340d5bede7a70f5c48e";

function target(
  poolId = POOL,
  retainedTvlUsd = 156_900,
): DexMeasuredExecutionTarget {
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: `target:${poolId}`,
    stablecoinId: "cadc-cad-coin",
    adapterProfileId: "aerodrome-slipstream-quoter-v2",
    protocol: "aerodrome-slipstream",
    chain: "base",
    poolId,
    poolTokenAddresses: [CADC, USDC],
    tokenIn: {
      address: CADC,
      symbol: "CADC",
      decimals: 18,
      referencePriceUsd: 0.711,
      trackedAssetId: "cadc-cad-coin",
    },
    tokenOut: {
      address: USDC,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tickSpacing: 10,
    retainedTvlUsd,
    retainedPoolPriceUsd: 0.711,
    capturedAt: 1_785_084_000,
  };
}

describe("retained measured-target resolution", () => {
  it("prefers an exact physical-pool target regardless of fingerprint ambiguity", () => {
    const exact = target();
    const sibling = target("base:0x1111111111111111111111111111111111111111", 156_950);
    const exactTargets = new Map([
      [buildMeasuredPoolDirectionKey(exact.stablecoinId, exact.poolId), exact],
      [buildMeasuredPoolDirectionKey(sibling.stablecoinId, sibling.poolId), sibling],
    ]);

    expect(
      resolveDexMeasuredTargetForRetainedPool({
        stablecoinId: exact.stablecoinId,
        retainedPoolId: exact.poolId,
        retainedTvlUsd: 1,
        adapterProfileId: exact.adapterProfileId,
        exactTargets,
        fingerprintTargets: buildDexMeasuredTargetFingerprintIndex(exactTargets.values()),
      }),
    ).toBe(exact);
  });

  it("uses exactly one same-pair candidate inside the bounded TVL window", () => {
    const matching = target();
    const dustSibling = target("base:0x1111111111111111111111111111111111111111", 1.13);
    const targets = new Map([
      [buildMeasuredPoolDirectionKey(matching.stablecoinId, matching.poolId), matching],
      [buildMeasuredPoolDirectionKey(dustSibling.stablecoinId, dustSibling.poolId), dustSibling],
    ]);
    const fingerprint = buildPoolFingerprint("base", "aerodrome", [CADC, USDC])!;
    const common = {
      stablecoinId: "cadc-cad-coin",
      retainedPoolId: fingerprint,
      retainedTvlUsd: 157_000,
      adapterProfileId: matching.adapterProfileId,
      exactTargets: targets,
      fingerprintTargets: buildDexMeasuredTargetFingerprintIndex(targets.values()),
    };

    expect(resolveDexMeasuredTargetForRetainedPool(common)).toBe(matching);
    expect(
      resolveDexMeasuredTargetForRetainedPool({
        ...common,
        retainedTvlUsd: 160_000,
      }),
    ).toBeNull();
  });

  it("fails closed when two physical targets fit the fingerprint and TVL window", () => {
    const first = target();
    const second = target("base:0x1111111111111111111111111111111111111111", 157_100);
    const targets = new Map([
      [buildMeasuredPoolDirectionKey(first.stablecoinId, first.poolId), first],
      [buildMeasuredPoolDirectionKey(second.stablecoinId, second.poolId), second],
    ]);

    expect(
      resolveDexMeasuredTargetForRetainedPool({
        stablecoinId: first.stablecoinId,
        retainedPoolId: buildPoolFingerprint("base", "aerodrome", [CADC, USDC])!,
        retainedTvlUsd: 157_000,
        adapterProfileId: first.adapterProfileId,
        exactTargets: targets,
        fingerprintTargets: buildDexMeasuredTargetFingerprintIndex(targets.values()),
      }),
    ).toBeNull();
  });
});
