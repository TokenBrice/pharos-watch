import { describe, expect, it } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import {
  observeSafetyScoreV9DeploymentSupplyCensusGeneration,
  type DeploymentSupplyCensusAssemblyDependencies,
  type DeploymentSupplyCensusRegistryMeta,
} from "../safety-score-v9/deployment-supply-census";
import { DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET } from "../safety-score-v9/deployment-supply-census-evm";

const CLOCK = 1_793_300_238;
const REGISTRY_FINGERPRINT = "a".repeat(64);
const BASE_INPUT_GENERATION = `report-cards-input:v1:${"b".repeat(64)}`;
const CANONICAL = `0x${"1".repeat(40)}`;
const MIRROR = `0x${"2".repeat(40)}`;
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

type RouteFacts = {
  readonly chain: string;
  readonly address: string;
  readonly scope: "canonical" | "peripheral";
  readonly semantics: "native-mint" | "lock-mint" | "burn-mint";
};

function route(facts: RouteFacts) {
  return {
    id: `${facts.chain}:${facts.address}`,
    destinationChain: facts.chain,
    contractAddress: facts.address,
    ...(facts.scope === "peripheral" ? { canonicalChain: "ethereum" } : {}),
    protocol: "fixture-route",
    issuanceModel: facts.scope === "canonical" ? "native-issuance" : "bridge-representation",
    routeClass: facts.scope === "canonical" ? "native" : "third-party",
    riskTier: "external-lock-mint",
    semantics: facts.semantics,
    scope: facts.scope,
    reviewDisposition: "reviewed",
    reviewNote: "Fixture route review",
    observedAt: "2026-10-29",
    sources: [{ label: "Fixture", url: "https://example.com" }],
  } as const;
}

function meta(assetId: string, routes: readonly RouteFacts[]): DeploymentSupplyCensusRegistryMeta {
  return {
    id: assetId,
    contracts: routes.map(row => ({ chain: row.chain, address: row.address, decimals: 6 })),
    bridgeRouteRisk: {
      tier: "external-lock-mint",
      summary: "Fixture bridge route review.",
      reviewedAt: "2026-10-29",
      reviewer: "fixture",
      confidence: "verified",
      routes: routes.map(route),
    },
  } as unknown as DeploymentSupplyCensusRegistryMeta;
}

function fixedInput(assetId: string, aggregateUsd: number) {
  return {
    baseInputGenerationId: BASE_INPUT_GENERATION,
    sourceGeneration: "fixture-source",
    registryFingerprint: REGISTRY_FINGERPRINT,
    clockSec: CLOCK,
    activeAssetIds: [assetId],
    aggregateCirculatingById: {
      [assetId]: { circulating: { peggedUSD: aggregateUsd }, observedAtSec: CLOCK - 600 },
    },
    chainCirculatingById: { [assetId]: {} },
    navPriceById: {
      [assetId]: {
        priceUsd: 1, sourceId: "fixture-price", confidence: "high" as const,
        observedAtSec: CLOCK - 60,
      },
    },
  };
}

/** EVM dependencies: one `totalSupply()` per deployment address, decimals 6. */
function evm(
  supplies: Readonly<Record<string, bigint>>,
  observeOptions?: (options: { maxResponseBytes?: number; maxRetries?: number }) => void,
): Partial<DeploymentSupplyCensusAssemblyDependencies["evm"]> {
  return {
    resolveClosestBlockAtOrBeforeTimestamp: async (
      _chain: unknown, _target: unknown, _cache: unknown, options?: { maxResponseBytes?: number; maxRetries?: number },
    ) => {
      if (options) observeOptions?.(options);
      return 100;
    },
    fetchEvmBlockHeader: async (
      _chain: unknown, _block: unknown, options?: { maxResponseBytes?: number; maxRetries?: number },
    ) => {
      if (options) observeOptions?.(options);
      return { number: 100, hash: `0x${"ab".repeat(32)}`, timestamp: CLOCK - 60 } as never;
    },
    fetchEvmCodeStatusAtBlock: async () => ({ status: "available" as const, code: "0x6000" as `0x${string}` }),
    fetchEvmMulticall3Aggregate3AtBlock: async (
      _chain: string | undefined,
      calls: readonly { label: string; target: string; callData: string }[],
    ) => calls.map(call => ({
      label: call.label,
      success: true,
      returnData: word(call.callData === TOTAL_SUPPLY_SELECTOR
        ? supplies[call.target] ?? 0n
        : 6n),
    })),
    sha256Hex: async () => "f".repeat(64),
  };
}

const CHAIN_RPCS = new Map([["ethereum", {
  chainId: "ethereum", chainName: "Ethereum", type: "evm" as const, endpoints: [], explorerUrl: "",
}], ["megaeth", {
  chainId: "megaeth", chainName: "MegaETH", type: "evm" as const, endpoints: [], explorerUrl: "",
}]] as [string, ChainRpcConfig][]);

const LOCK_MINT_ROUTES: readonly RouteFacts[] = [
  { chain: "ethereum", address: CANONICAL, scope: "canonical", semantics: "native-mint" },
  { chain: "megaeth", address: MIRROR, scope: "peripheral", semantics: "lock-mint" },
];

function run(
  routes: readonly RouteFacts[],
  aggregateUsd: number,
  dependencies: DeploymentSupplyCensusAssemblyDependencies = {},
) {
  return observeSafetyScoreV9DeploymentSupplyCensusGeneration({
    fixedInput: fixedInput("wi-mirror", aggregateUsd),
    observationClockSec: fixedInput("wi-mirror", aggregateUsd).clockSec,
    assetIds: ["wi-mirror"],
    chainRpcs: CHAIN_RPCS,
    metaById: new Map([["wi-mirror", meta("wi-mirror", routes)]]),
  }, dependencies);
}

describe("deployment supply census lock-mint mirror", () => {
  it("counts a lock-mint representation once by netting it out of the canonical deployment", async () => {
    const generation = await run(LOCK_MINT_ROUTES, 100, {
      evm: evm({ [CANONICAL]: 100_000_000n, [MIRROR]: 99_000_000n }),
    });

    const packet = generation.censusById["wi-mirror"]!;
    expect(packet.conservation).toMatchObject({ conserved: true });
    expect(packet.rejected).toEqual([]);
    expect(packet.deployments.map(row => row.routeId)).toEqual([
      `ethereum:${CANONICAL}`, `megaeth:${MIRROR}`,
    ]);
    const canonical = packet.deployments.find(row => row.chainId === "ethereum")!;
    const mirror = packet.deployments.find(row => row.chainId === "megaeth")!;
    // 100 units total, 99 mirrored: the canonical free float is 1 unit.
    expect(canonical.totalSupplyRaw).toBe("1000000");
    expect(canonical.supplyUsdUpper).toBeCloseTo(1, 6);
    expect(canonical.shareUpper).toBeCloseTo(0.01, 9);
    expect(mirror.totalSupplyRaw).toBe("99000000");
    expect(mirror.shareUpper).toBeCloseTo(0.99, 9);
    expect(canonical.shareUpper + mirror.shareUpper).toBeCloseTo(1, 9);
  });

  it("does not net a burn-mint representation: destroyed canonical supply is not escrow", async () => {
    const generation = await run([
      LOCK_MINT_ROUTES[0]!,
      { chain: "megaeth", address: MIRROR, scope: "peripheral", semantics: "burn-mint" },
    ], 100, { evm: evm({ [CANONICAL]: 100_000_000n, [MIRROR]: 99_000_000n }) });

    const packet = generation.censusById["wi-mirror"]!;
    expect(packet.conservation).toMatchObject({ conserved: false, rosterComplete: true });
    expect(packet.deployments).toEqual([]);
    expect(packet.rejected).toEqual([
      { routeId: `ethereum:${CANONICAL}`, code: "census-rejected:conservation-breach" },
      { routeId: `megaeth:${MIRROR}`, code: "census-rejected:conservation-breach" },
    ]);
  });

  it("fails closed when the mirrors claim more than the canonical deployment holds", async () => {
    const generation = await run(LOCK_MINT_ROUTES, 200, {
      evm: evm({ [CANONICAL]: 100_000_000n, [MIRROR]: 120_000_000n }),
    });

    const packet = generation.censusById["wi-mirror"]!;
    // No clamp to zero and no partial row: the reads cannot form a partition.
    expect(packet.conservation).toMatchObject({ conserved: false, measuredSupplyUsd: 0 });
    expect(packet.deployments).toEqual([]);
    expect(packet.rejected.map(entry => entry.code)).toEqual([
      "census-rejected:conservation-breach", "census-rejected:conservation-breach",
    ]);
  });
});

describe("deployment supply census pin budget", () => {
  it("pins with the header body budget and one retry instead of the state-read cap", async () => {
    const seen: { maxResponseBytes?: number; maxRetries?: number }[] = [];
    await run(LOCK_MINT_ROUTES, 100, {
      evm: evm({ [CANONICAL]: 100_000_000n, [MIRROR]: 99_000_000n }, options => seen.push(options)),
    });
    // Base blocks exceed the 128 KiB state cap; a pin read is a full block body.
    expect(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.headerResponseBytes)
      .toBeGreaterThan(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxResponseBytes);
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options.maxResponseBytes).toBe(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.headerResponseBytes);
      expect(options.maxRetries).toBe(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.pinRetries);
    }
  });
});
