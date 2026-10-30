import {
  SafetyScoreV9DeploymentSupplyCensusSchema,
  type SafetyScoreV9DeploymentSupplyCensus,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import { buildChainRpcs } from "../chain-registry";
import {
  DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS,
  DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN,
  observeSafetyScoreV9DeploymentSupplyCensusGeneration,
  safetyScoreV9DeploymentSupplyCensusById,
  type DeploymentSupplyCensusAssemblyDependencies,
  type DeploymentSupplyCensusAssemblyInput,
  type DeploymentSupplyCensusRegistryMeta,
} from "../safety-score-v9/deployment-supply-census";
import type { DeploymentSupplyCensusNonEvmDependencies } from "../safety-score-v9/deployment-supply-census-nonevm";
import rpcGeneration from "./fixtures/deployment-supply-census-evm/rpc-generation.json";

const CLOCK = 1_793_300_238;
const PRICE_OBSERVED_AT = 1_793_300_178;
const REGISTRY_FINGERPRINT = "a".repeat(64);
const SOURCE_GENERATION = "fixture-source";
const BASE_INPUT_GENERATION = `report-cards-input:v1:${"b".repeat(64)}`;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_BLOCK_HASH = "1".repeat(32);
const SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM_ETHLIKE = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const EVM_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const APTOS_METADATA = `0x${"a".repeat(64)}`;
const SUI_TYPE = `0x${"b".repeat(64)}::usdc::USDC`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface RouteSpec {
  readonly chain: string;
  readonly address: string;
  readonly reviewed?: boolean;
}

function fixtureRoute(spec: RouteSpec) {
  const reviewed = spec.reviewed !== false;
  return {
    id: `${spec.chain}:${spec.address}`,
    destinationChain: spec.chain,
    contractAddress: spec.address,
    protocol: "fixture-bridge",
    issuanceModel: reviewed ? "bridge-representation" : "unknown",
    routeClass: reviewed ? "canonical" : "unknown",
    riskTier: reviewed ? "canonical-rollup-bridge" : "opaque-or-unknown",
    semantics: reviewed ? "lock-mint" : "unknown",
    scope: reviewed ? "canonical" : "unknown",
    reviewDisposition: reviewed ? "reviewed" : "unresolved",
    reviewNote: "Fixture route review",
    observedAt: "2026-10-29",
    sources: [{ label: "Fixture", url: "https://example.com" }],
  } as const;
}

function fixtureMeta(
  assetId: string,
  routes: readonly RouteSpec[],
  decimals: number | null = 6,
): DeploymentSupplyCensusRegistryMeta {
  return {
    id: assetId,
    contracts: routes
      .filter(route => route.chain !== "xrpl")
      .map(route => ({ chain: route.chain, address: route.address, decimals })),
    bridgeRouteRisk: {
      tier: "canonical-rollup-bridge",
      summary: "Fixture bridge route review.",
      reviewedAt: "2026-10-29",
      reviewer: "fixture",
      confidence: "verified",
      routes: routes.map(fixtureRoute),
    },
  } as unknown as DeploymentSupplyCensusRegistryMeta;
}

interface AssetEconomics {
  readonly aggregateUsd: number | null;
  readonly chainUsd?: Readonly<Record<string, number>>;
  readonly priceUsd?: number;
  readonly priceObservedAtSec?: number;
  readonly peg?: { readonly valueUsd: number; readonly asOf: number } | null;
}

function fixtureFixedInput(
  assetIds: readonly string[],
  economics: Readonly<Record<string, AssetEconomics>>,
  clockSec = CLOCK,
): DeploymentSupplyCensusAssemblyInput["fixedInput"] {
  return {
    baseInputGenerationId: BASE_INPUT_GENERATION,
    sourceGeneration: SOURCE_GENERATION,
    registryFingerprint: REGISTRY_FINGERPRINT,
    clockSec,
    activeAssetIds: [...assetIds],
    aggregateCirculatingById: Object.fromEntries(assetIds.map(assetId => {
      const aggregate = economics[assetId]?.aggregateUsd ?? null;
      return [assetId, aggregate === null
        ? { circulating: {} as Record<string, number>, observedAtSec: null }
        : { circulating: { usd: aggregate }, observedAtSec: clockSec - 600 }];
    })),
    chainCirculatingById: Object.fromEntries(assetIds.map(assetId => [
      assetId,
      Object.fromEntries(Object.entries(economics[assetId]?.chainUsd ?? {})
        .map(([chain, current]) => [chain, { current }])),
    ])),
    navPriceById: Object.fromEntries(assetIds.flatMap(assetId => {
      const asset = economics[assetId];
      if (asset?.priceUsd === undefined) return [];
      return [[assetId, {
        priceUsd: asset.priceUsd,
        sourceId: "fixture-price",
        observedAtSec: asset.priceObservedAtSec ?? clockSec - 60,
        confidence: "high" as const,
      }]];
    })),
    pegDataById: Object.fromEntries(assetIds.flatMap(assetId => {
      const peg = economics[assetId]?.peg;
      return peg == null ? [] : [[assetId, { pegReference: peg }]];
    })),
  };
}

function run(
  assetIds: readonly string[],
  metas: readonly DeploymentSupplyCensusRegistryMeta[],
  economics: Readonly<Record<string, AssetEconomics>>,
  options: {
    readonly clockSec?: number;
    readonly dependencies?: DeploymentSupplyCensusAssemblyDependencies;
    readonly chainRpcs?: Map<string, ChainRpcConfig>;
  } = {},
) {
  return observeSafetyScoreV9DeploymentSupplyCensusGeneration({
    fixedInput: fixtureFixedInput(assetIds, economics, options.clockSec ?? CLOCK),
    assetIds,
    chainRpcs: options.chainRpcs ?? new Map(),
    metaById: new Map(metas.map(meta => [meta.id, meta])),
  }, options.dependencies ?? {});
}

function packet(generation: { censusById: Record<string, SafetyScoreV9DeploymentSupplyCensus> }, assetId: string) {
  return generation.censusById[assetId]!;
}

/**
 * Replay of SA-2a's recorded generation: chains are read concurrently, so
 * match by (url, method, params) rather than recording order. Every recorded
 * exchange must be consumed exactly once.
 */
function replayRecordedRpc(): () => void {
  const queues = new Map<string, { status: number; body: string }[]>();
  for (const exchange of rpcGeneration.exchanges) {
    const key = `${exchange.url}\u0000${exchange.method}:${JSON.stringify(exchange.params)}`;
    queues.set(key, [...(queues.get(key) ?? []), { status: exchange.status, body: exchange.body }]);
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const key = `${String(input)}\u0000${body.method}:${JSON.stringify(body.params)}`;
    const exchange = queues.get(key)?.shift();
    if (exchange === undefined) throw new Error(`unrecorded RPC ${key}`);
    return new Response(exchange.body, {
      status: exchange.status,
      headers: { "content-type": "application/json" },
    });
  });
  return () => {
    for (const [key, queue] of queues) expect(queue.length, `unused RPC ${key}`).toBe(0);
  };
}

function solanaRpc(options: {
  readonly supply?: string;
  readonly decimals?: number;
  readonly blockTimeSec?: number;
  readonly slot?: number;
} = {}): DeploymentSupplyCensusNonEvmDependencies["fetchSafetyScoreV9SolanaRpc"] {
  return (async <T>(method: string, params: unknown[]): Promise<T | null> => {
    if (method === "getMultipleAccounts") {
      const addresses = params[0] as string[];
      return {
        context: { slot: options.slot ?? 500 },
        value: addresses.map(() => ({
          owner: TOKEN_PROGRAM,
          data: {
            parsed: {
              type: "mint",
              info: { supply: options.supply ?? "1000000", decimals: options.decimals ?? 6 },
            },
          },
        })),
      } as T;
    }
    if (method === "getBlocks") return [(options.slot ?? 500) - 1] as T;
    if (method === "getBlock") {
      return {
        blockTime: options.blockTimeSec ?? CLOCK - 60,
        blockhash: SOLANA_BLOCK_HASH,
      } as T;
    }
    return null;
  }) as DeploymentSupplyCensusNonEvmDependencies["fetchSafetyScoreV9SolanaRpc"];
}

function moveSupply(options: {
  readonly rawSupply: bigint;
  readonly decimals?: number;
  readonly ledgerTimeSec?: number;
}): DeploymentSupplyCensusNonEvmDependencies["fetchMoveFungibleAssetSupply"] {
  return ((async () => ({
    rawSupply: options.rawSupply,
    decimals: options.decimals ?? 6,
    ledgerVersion: "1000",
    ledgerTimestampSec: options.ledgerTimeSec ?? CLOCK - 60,
  })) as unknown) as DeploymentSupplyCensusNonEvmDependencies["fetchMoveFungibleAssetSupply"];
}

describe("deployment supply census assembly", () => {
  it("assembles the recorded EVM generation into one conserved packet with a deterministic id", async () => {
    const meta = fixtureMeta("usdc-circle", [
      { chain: "ethereum", address: EVM_ETHLIKE },
      { chain: "base", address: EVM_BASE },
    ]);
    const economics = {
      "usdc-circle": {
        aggregateUsd: rpcGeneration.aggregateSupplyUsd,
        chainUsd: rpcGeneration.chainSupplyUsdByChainId,
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    };
    const input = {
      assetIds: ["usdc-circle"],
      clockSec: rpcGeneration.clockSec,
      chainRpcs: buildChainRpcs(),
    } as const;

    const replay = replayRecordedRpc();
    const first = await run([input.assetIds[0]], [meta], economics, {
      clockSec: input.clockSec,
      chainRpcs: input.chainRpcs,
    });
    replay();

    const census = packet(first, "usdc-circle");
    // The packet is exactly the reader rows plus the row-derived conservation
    // block; no share is rewritten between the reader and the packet.
    expect(census.deployments).toEqual(rpcGeneration.census.rows);
    expect(census.rejected).toEqual([]);
    expect(census.conservation).toMatchObject({
      aggregateSupplyUsd: rpcGeneration.aggregateSupplyUsd,
      rosterComplete: true,
      conserved: true,
    });
    expect(census.conservation.measuredSupplyUsd).toBeCloseTo(
      census.deployments.reduce((sum, row) => sum + row.supplyUsdUpper, 0), 6,
    );
    expect(census.conservation.measuredShareSum).toBeCloseTo(
      census.deployments.reduce((sum, row) => sum + row.shareUpper, 0), 12,
    );
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(census)).toEqual(census);
    expect(first.capturedAtSec).toBe(rpcGeneration.clockSec);
    expect(safetyScoreV9DeploymentSupplyCensusById(first)).toEqual(first.censusById);

    // Same inputs and clock produce the same content-addressed generation.
    const replayAgain = replayRecordedRpc();
    const second = await run([input.assetIds[0]], [meta], economics, {
      clockSec: input.clockSec,
      chainRpcs: input.chainRpcs,
    });
    replayAgain();
    expect(second.generationId).toBe(first.generationId);
    expect(safetyScoreV9DeploymentSupplyCensusById(second)).toEqual(first.censusById);
  });

  it("rejects a 100.4% partition as conservation-breach and names the deployment", async () => {
    const route = `0x${"c".repeat(64)}`;
    const meta = fixtureMeta("usdcx-movement", [{ chain: "movement", address: route }]);
    const generation = await run(["usdcx-movement"], [meta], {
      "usdcx-movement": {
        aggregateUsd: 1_000_000_000,
        chainUsd: { movement: 1_100_000_000 },
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    }, {
      dependencies: { nonEvm: { fetchMoveFungibleAssetSupply: moveSupply({ rawSupply: 1_004_000_000_000_000n }) } },
    });

    const census = packet(generation, "usdcx-movement");
    expect(census.deployments).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: true, conserved: false });
    expect(census.rejected).toEqual([{
      routeId: `movement:${route}`,
      code: "census-rejected:conservation-breach",
    }]);
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(census)).toEqual(census);
  });

  it("leaves an unsupported chain null instead of inventing a quantity", async () => {
    const solana = vi.fn(solanaRpc());
    const move = vi.fn(moveSupply({ rawSupply: 1n }));
    const meta = fixtureMeta("sui-asset", [{ chain: "sui", address: SUI_TYPE }]);
    const generation = await run(["sui-asset"], [meta], {
      "sui-asset": { aggregateUsd: 1_000_000_000, chainUsd: { sui: 1_000_000_000 }, priceUsd: 1 },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solana.mock as unknown as DeploymentSupplyCensusNonEvmDependencies["fetchSafetyScoreV9SolanaRpc"],
        fetchMoveFungibleAssetSupply: move,
      } },
    });

    const census = packet(generation, "sui-asset");
    expect(census.deployments).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: false, conserved: false });
    expect(census.rejected).toEqual([{
      routeId: `sui:${SUI_TYPE}`,
      code: "census-rejected:read-unavailable",
    }]);
    // No reader is asked for a chain family it does not support.
    expect(solana).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("reads no sibling when one reviewed roster route cannot be measured", async () => {
    const solana = vi.fn(solanaRpc());
    const meta = fixtureMeta("mixed-asset", [
      { chain: "solana", address: SOLANA_MINT },
      { chain: "ethereum", address: EVM_ETHLIKE, reviewed: false },
    ]);
    const generation = await run(["mixed-asset"], [meta], {
      "mixed-asset": { aggregateUsd: 1_000_000_000, priceUsd: 1 },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solana.mock as unknown as DeploymentSupplyCensusNonEvmDependencies["fetchSafetyScoreV9SolanaRpc"],
      } },
    });

    const census = packet(generation, "mixed-asset");
    expect(census.deployments).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: false, conserved: false });
    expect(census.rejected).toEqual([{
      routeId: `ethereum:${EVM_ETHLIKE}`,
      code: "census-rejected:route-unreviewed",
    }]);
    // A partial packet is not worth spending the shared read budget.
    expect(solana).not.toHaveBeenCalled();
  });

  it("rejects an over-cap roster whole rather than truncating it", async () => {
    const routes = Array.from({ length: 65 }, (_, index) => ({
      chain: "solana",
      address: `${SOLANA_MINT.slice(0, -2)}${index.toString(36).padStart(2, "0")}`,
    }));
    const meta = fixtureMeta("over-cap", routes);
    const solana = vi.fn(solanaRpc());
    const generation = await run(["over-cap"], [meta], {
      "over-cap": { aggregateUsd: 1_000_000_000, priceUsd: 1 },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solana.mock as unknown as DeploymentSupplyCensusNonEvmDependencies["fetchSafetyScoreV9SolanaRpc"],
      } },
    });

    const census = packet(generation, "over-cap");
    expect(census.deployments).toEqual([]);
    expect(census.rejected).toEqual([{
      routeId: null,
      code: "census-rejected:deployment-over-cap",
    }]);
    expect(solana).not.toHaveBeenCalled();
  });

  it("admits Solana and Move bounds with their own pins inside the conservation budget", async () => {
    const meta = fixtureMeta("ausd-agora", [
      { chain: "solana", address: SOLANA_MINT },
      { chain: "aptos", address: APTOS_METADATA },
    ]);
    const generation = await run(["ausd-agora"], [meta], {
      "ausd-agora": {
        aggregateUsd: 1_000_000_000,
        chainUsd: { solana: 100_000_000, aptos: 100_000_000 },
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solanaRpc({ supply: "10000000" }),
        fetchMoveFungibleAssetSupply: moveSupply({ rawSupply: 20_000_000_000n }),
      } },
    });

    const census = packet(generation, "ausd-agora");
    expect(census.rejected).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: true, conserved: true });
    expect(census.deployments.map(row => row.routeId)).toEqual([
      `aptos:${APTOS_METADATA}`,
      `solana:${SOLANA_MINT}`,
    ]);
    for (const row of census.deployments) {
      expect(row.evidenceKind).toBe("upper-bound");
      expect(row.pin.blockTimeSec).toBe(CLOCK - 60);
    }
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(census)).toEqual(census);
  });

  it("bounds a non-EVM chain by its provider allocation before admission", async () => {
    const meta = fixtureMeta("ausd-agora", [{ chain: "solana", address: SOLANA_MINT }]);
    const generation = await run(["ausd-agora"], [meta], {
      "ausd-agora": {
        aggregateUsd: 1_000_000_000,
        // 10 USD measured against a 5 USD provider allocation on the chain.
        chainUsd: { solana: 5 },
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solanaRpc({ supply: "10000000" }),
      } },
    });

    const census = packet(generation, "ausd-agora");
    expect(census.deployments).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: true, conserved: false });
    expect(census.rejected).toEqual([{
      routeId: `solana:${SOLANA_MINT}`,
      code: "census-rejected:conservation-breach",
    }]);
  });

  it("rejects a cross-family pin skew above the one skew authority", async () => {
    const meta = fixtureMeta("usdc-circle", [
      { chain: "ethereum", address: EVM_ETHLIKE },
      { chain: "base", address: EVM_BASE },
      { chain: "solana", address: SOLANA_MINT },
    ]);
    const replay = replayRecordedRpc();
    const generation = await run(["usdc-circle"], [meta], {
      "usdc-circle": {
        aggregateUsd: 100_000_000_000,
        chainUsd: { ethereum: 100_000_000_000, base: 20_000_000_000, solana: 10_000_000_000 },
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    }, {
      clockSec: rpcGeneration.clockSec,
      chainRpcs: buildChainRpcs(),
      dependencies: { nonEvm: {
        // A finalized Solana anchor 200 s behind the EVM header outruns the 120 s allowance.
        fetchSafetyScoreV9SolanaRpc: solanaRpc({ supply: "1000000", blockTimeSec: rpcGeneration.clockSec - 200 }),
      } },
    });
    replay();

    const census = packet(generation, "usdc-circle");
    expect(census.deployments).toEqual([]);
    expect(census.conservation).toMatchObject({ rosterComplete: true, conserved: false });
    expect(census.rejected.map(entry => entry.code)).toEqual([
      "census-rejected:cross-chain-skew",
      "census-rejected:cross-chain-skew",
      "census-rejected:cross-chain-skew",
    ]);
    expect(census.rejected.map(entry => entry.routeId).sort()).toEqual([
      `base:${EVM_BASE}`,
      `ethereum:${EVM_ETHLIKE}`,
      `solana:${SOLANA_MINT}`,
    ].sort());
  });

  it("carries a sub-1% Solana bound and keeps >=1% rows for the consumer's escrow outcome", async () => {
    const meta = fixtureMeta("ausd-agora", [{ chain: "solana", address: SOLANA_MINT }]);
    const generation = await run(["ausd-agora"], [meta], {
      "ausd-agora": {
        aggregateUsd: 1_000_000_000,
        chainUsd: { solana: 1_000_000_000 },
        priceUsd: 1,
        priceObservedAtSec: PRICE_OBSERVED_AT,
      },
    }, {
      dependencies: { nonEvm: {
        fetchSafetyScoreV9SolanaRpc: solanaRpc({ supply: "5000000" }),
      } },
    });
    const row = packet(generation, "ausd-agora").deployments[0]!;
    expect(row.shareUpper).toBeLessThan(0.01);
    expect(row.shareUpper).toBeGreaterThan(0);
  });

  it("emits no packet for an asset with no bridge route inventory", async () => {
    const meta = { id: "no-routes", contracts: [] } as unknown as DeploymentSupplyCensusRegistryMeta;
    const generation = await run(["no-routes"], [meta], {
      "no-routes": { aggregateUsd: 1_000_000_000 },
    });
    expect(generation.censusById).toEqual({});
  });

  it("refuses a cohort or run beyond the transfer-materiality census budget", async () => {
    const assetIds = Array.from({ length: DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS + 1 }, (_, index) => `asset-${index}`);
    await expect(run(assetIds, [], {})).rejects.toThrow(
      `Deployment supply census cohort exceeds ${DEPLOYMENT_SUPPLY_CENSUS_MAX_ASSETS} assets`,
    );
    const routes = Array.from({ length: 60 }, (_, index) => ({
      chain: "solana",
      address: `${SOLANA_MINT.slice(0, -2)}${index.toString(36).padStart(2, "0")}`,
    }));
    const metas = Array.from({ length: 5 }, (_, index) => fixtureMeta(`asset-${index}`, routes));
    const economics = Object.fromEntries(metas.map(meta => [meta.id, { aggregateUsd: 1_000_000_000 }]));
    await expect(run(metas.map(meta => meta.id), metas, economics)).rejects.toThrow(
      `Deployment supply census run exceeds ${DEPLOYMENT_SUPPLY_CENSUS_MAX_DEPLOYMENTS_PER_RUN} deployments`,
    );
  });
});
