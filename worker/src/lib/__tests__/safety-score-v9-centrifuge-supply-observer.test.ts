import "../../test-helpers/reviewed-deployment-catalog.test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { ReviewedDeploymentSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import currentJtrsyRisk from "@shared/data/stablecoins/domains/risk-review/jtrsy-anemoy.json";
import currentJtrsyCoin from "@shared/data/stablecoins/coins/jtrsy-anemoy.json";
import type { ChainRpcConfig } from "../chain-registry";
import { makeChainRpcs } from "../../test-helpers/chain-rpc-fixtures.test-support";
import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
} from "../evm-rpc";
import {
  buildReviewedDeploymentRouteInventory,
  expectedCentrifugeDeploymentIdentity,
  reviewedDeploymentAttributionValidationError,
} from "../safety-score-v9/supply-attribution-contract";
import {
  fetchSolanaCentrifugeDeploymentObservation,
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
  type CentrifugeSolanaRpcFetcher,
} from "../safety-score-v9/centrifuge-supply-observer";

const ASSET_ID = "jtrsy-anemoy";
const AGGREGATE_SUPPLY_USD = 51_033_069.79770032;
const CLOCK_SEC = 1_784_904_600;
const REGISTRY_FINGERPRINT = "a".repeat(64);

const RAW_BY_CHAIN: Record<string, bigint> = {
  ethereum: 378_869_494_500_836_268_665_209n,
  arbitrum: 19_837_361_464_973_825_379_103n,
  avalanche: 8_837_361_464_973_825_379_103n,
  base: 0n, xlayer: 0n, arc: 0n,
  bsc: 4_837_361_464_973_825_379_103n,
  plume: 32_320_262_971_888_335_278_993_277n,
  monad: 9_837_361_464_973_825_379_103_908n,
  pharos: 3_419_937_985_239n,
};

const BLOCK_BY_CHAIN: Record<string, number> = {
  ethereum: 25_603_299,
  arbitrum: 487_200_000,
  avalanche: 73_000_000,
  base: 49_057_583,
  bsc: 52_000_000,
  plume: 83_072_568,
  monad: 89_944_923,
  pharos: 22_124_698,
  xlayer: 75_356_641,
  arc: 30_150_645,
};

const TIME_BY_CHAIN: Record<string, number> = {
  ethereum: CLOCK_SEC - 30,
  arbitrum: CLOCK_SEC - 25,
  avalanche: CLOCK_SEC - 15,
  base: CLOCK_SEC - 20,
  bsc: CLOCK_SEC - 10,
  plume: CLOCK_SEC - 7,
  monad: CLOCK_SEC - 4,
  pharos: CLOCK_SEC - 5,
  xlayer: CLOCK_SEC - 4,
  arc: CLOCK_SEC - 2,
};

const EVM_CHAINS = [
  "ethereum", "arbitrum", "avalanche", "base", "bsc", "plume", "monad", "pharos", "xlayer", "arc",
] as const;

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function chainRpcs(): Map<string, ChainRpcConfig> {
  return makeChainRpcs(["ethereum", "arbitrum", "avalanche", "base", "bsc", "xlayer", "arc"]);
}

function routeForChain(chainId: string) {
  return buildReviewedDeploymentRouteInventory(ASSET_ID)!.routes.find(route => route.chainId === chainId)!;
}

function solanaObservation(): ReviewedDeploymentSupplyObservation {
  const route = routeForChain("solana");
  const identity = expectedCentrifugeDeploymentIdentity(ASSET_ID, route.routeId);
  if (!identity || identity.runtime !== "solana") {
    throw new Error("Missing JTRSY Solana identity");
  }
  return {
    routeId: route.routeId,
    chainId: route.chainId,
    contractAddress: route.contractAddress,
    decimals: route.decimals,
    rawSupply: "0",
    blockNumberOrSlot: "434941163",
    blockTimeSec: CLOCK_SEC - 3,
    blockHash: "B".repeat(44),
    programOwner: identity.programOwner,
    mintAuthority: identity.mintAuthority,
    controllerAddress: identity.controllerAddress,
    controllerProgramOwner: identity.controllerProgramOwner,
  };
}

function dependencies() {
  return {
    sha256HexFromBytes: vi.fn((bytes: Uint8Array) => {
      const chainId = EVM_CHAINS[bytes[0]! - 1];
      const route = chainId ? routeForChain(chainId) : null;
      const identity = route
        ? expectedCentrifugeDeploymentIdentity(ASSET_ID, route.routeId)
        : null;
      return identity?.runtime === "evm"
        ? identity.runtimeCodeSha256
        : "0".repeat(64);
    }),
    fetchEvmBlockNumber: vi.fn(
      async (chainId: string) => BLOCK_BY_CHAIN[chainId] ?? null,
    ),
    fetchEvmBlockHeader: vi.fn(
      async (
        chainId: string,
        blockNumber: number | "finalized",
        _options?: unknown,
      ) =>
        blockNumber === "finalized"
          ? null
          : {
              number: blockNumber,
              timestamp: TIME_BY_CHAIN[chainId]!,
              hash: `0x${"a".repeat(64)}` as const,
            },
    ),
    fetchEvmCodeAtBlock: vi.fn(
      async (chainId: string | undefined) => {
        const marker = EVM_CHAINS.indexOf(
          chainId as (typeof EVM_CHAINS)[number],
        );
        return marker >= 0
          ? (`0x${(marker + 1).toString(16).padStart(2, "0")}` as const)
          : null;
      },
    ),
    fetchEvmStorageAtBlock: vi.fn(
      async (_chainId: string | undefined) =>
        `0x${"0".repeat(64)}` as const,
    ),
    fetchEvmMulticall3Aggregate3AtBlock: vi.fn(
      async (
        chainId: string | undefined,
        calls: readonly EvmMulticall3Call[],
      ): Promise<EvmMulticall3Result[] | null> => {
        if (!chainId || RAW_BY_CHAIN[chainId] == null) return null;
        const values: Record<string, `0x${string}`> = {
          "total-supply": uint256(RAW_BY_CHAIN[chainId]!),
          decimals: uint256(6n),
          "spoke-ward": uint256(1n),
        };
        return calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: values[call.label]!,
        }));
      },
    ),
    fetchSolanaObservation: vi.fn(
      async (): Promise<ReviewedDeploymentSupplyObservation | null> =>
        solanaObservation(),
    ),
  };
}

function observeAttempt(deps = dependencies()) {
  return observeCentrifugeReviewedDeploymentUnitPartitionAttempt({
    assetId: ASSET_ID, aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
    registryFingerprint: REGISTRY_FINGERPRINT, scoringClockSec: CLOCK_SEC, chainRpcs: chainRpcs(),
  }, deps);
}

async function observe(deps = dependencies()) {
  const attempt = await observeAttempt(deps);
  return attempt.status === "accepted" ? attempt.attribution : null;
}

describe("Centrifuge reviewed deployment observer", () => {
  const metaById = ACTIVE_META_BY_ID as Map<string, StablecoinMeta>;
  const historical = metaById.get(ASSET_ID)!;
  beforeEach(() => metaById.set(ASSET_ID, {
    ...historical, contracts: currentJtrsyCoin.contracts, bridgeRouteRisk: structuredClone(currentJtrsyRisk.bridgeRouteRisk),
  } as unknown as StablecoinMeta));
  afterEach(() => metaById.set(ASSET_ID, historical));

  it.each(["0", "1", null])("admits an unreviewed Solana route only at observed zero within the current inventory (%s)", async (rawSupply) => {
    const reviewed = metaById.get(ASSET_ID)!;
    metaById.set(ASSET_ID, { ...reviewed, bridgeRouteRisk: { ...reviewed.bridgeRouteRisk!,
      routes: reviewed.bridgeRouteRisk!.routes!.map(route => route.destinationChain === "solana"
        ? { ...route, reviewDisposition: "unresolved", issuanceModel: "unknown", semantics: "unknown" } : route),
    } });
    try {
      const deps = dependencies();
      deps.fetchSolanaObservation.mockResolvedValue(rawSupply === null ? null : { ...solanaObservation(), rawSupply });
      const attempt = await observeAttempt(deps);
      if (rawSupply === "0") expect(attempt.status).toBe("accepted");
      else expect(attempt).toEqual({ status: "rejected",
        rejectionCode: rawSupply === null ? "deployment-state-unavailable" : "packet-reconciliation-failed",
        failedRouteId: rawSupply === null ? routeForChain("solana").routeId : null,
      });
    } finally {
      metaById.set(ASSET_ID, reviewed);
    }
  });
  it("accepts the current JTRSY packet with positive Pharos supply on its reviewed provider route", async () => {
    const pharos = routeForChain("pharos");
    const review = ACTIVE_META_BY_ID.get(ASSET_ID)!.bridgeRouteRisk!.routes!.find(row => row.id === pharos.routeId)!;
    expect(review).toMatchObject({
      reviewDisposition: "reviewed", semantics: "burn-mint", issuanceModel: "bridge-representation",
      routeClass: "third-party", providerKeys: ["layerzero", "chainlink-ccip"], controllerChain: "pharos",
    });
    expect(review.rail).toBeUndefined();
    const attempt = await observeAttempt();
    expect(attempt.status).toBe("accepted");
    if (attempt.status !== "accepted") throw new Error("Expected complete JTRSY attribution");
    expect(attempt.attribution.deployments.find(row => row.chainId === "pharos"))
      .toMatchObject({ rawSupply: RAW_BY_CHAIN.pharos!.toString() });
    expect(reviewedDeploymentAttributionValidationError({
      assetId: ASSET_ID, attribution: attempt.attribution, aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
      registryFingerprint: REGISTRY_FINGERPRINT, clockSec: CLOCK_SEC,
    })).toBeNull();
  });

  it("finishes finalized Solana first and rewinds newer EVM pins into its actual clock window", async () => {
    const deps = dependencies();
    const solanaTime = CLOCK_SEC - 240;
    deps.fetchSolanaObservation.mockResolvedValue({ ...solanaObservation(), blockTimeSec: solanaTime });
    deps.fetchEvmBlockNumber.mockImplementation(async chainId => {
      expect(deps.fetchSolanaObservation).toHaveBeenCalledTimes(1);
      return BLOCK_BY_CHAIN[chainId] ?? null;
    });
    deps.fetchEvmBlockHeader.mockImplementation(async (chainId, number) => {
      if (number === "finalized") return null;
      const route = routeForChain(chainId), identity = expectedCentrifugeDeploymentIdentity(ASSET_ID, route.routeId);
      if (!identity || identity.runtime !== "evm") throw new Error("fixture");
      const safeHead = BLOCK_BY_CHAIN[chainId]! - identity.safeBlockLag;
      return { number, timestamp: CLOCK_SEC - 30 - (safeHead - number) * 12, hash: `0x${"a".repeat(64)}` };
    });
    const result = await observe(deps);
    expect(result).not.toBeNull();
    expect(result!.deployments.find(row => row.chainId === "solana")).toMatchObject({ rawSupply: "0", blockTimeSec: solanaTime });
    const times = result!.deployments.map(row => row.blockTimeSec);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(120);
  });
  it("rejects when the safe EVM head is older than the non-rewindable Solana interval", async () => {
    const deps = dependencies();
    deps.fetchEvmBlockHeader.mockImplementation(async (_chain, number) => number === "finalized" ? null :
      { number, timestamp: CLOCK_SEC - 400, hash: `0x${"a".repeat(64)}` });
    expect(await observe(deps)).toBeNull();
    expect(deps.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
  it("captures the complete EVM and Solana burn/mint inventory atomically", async () => {
    const deps = dependencies();
    const attribution = await observe(deps);

    expect(attribution).not.toBeNull();
    expect(attribution!.deployments).toHaveLength(currentJtrsyCoin.contracts.length);
    expect(attribution!.deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)).toBe(AGGREGATE_SUPPLY_USD);
    expect(
      attribution!.deployments.filter((row) => row.rawSupply === "0"),
    ).toEqual(["arc", "base", "solana", "xlayer"].map(chainId => expect.objectContaining({ chainId, currentSupplyUsd: 0 })));
  });

  it("rejects the whole packet when Spoke authorization or Solana is unavailable", async () => {
    const wrongWard = dependencies();
    wrongWard.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (chainId, calls): Promise<EvmMulticall3Result[] | null> => {
        if (!chainId || RAW_BY_CHAIN[chainId] == null) return null;
        return calls.map((call) => ({
          label: call.label,
          success: true,
          returnData:
            call.label === "total-supply"
              ? uint256(RAW_BY_CHAIN[chainId]!)
              : call.label === "decimals"
                ? uint256(6n)
                : uint256(chainId === "monad" ? 0n : 1n),
        }));
      },
    );
    await expect(observe(wrongWard)).resolves.toBeNull();

    const missingSolana = dependencies();
    missingSolana.fetchSolanaObservation.mockResolvedValue(null);
    await expect(observe(missingSolana)).resolves.toBeNull();
  });

  it("fails closed if a supposedly immutable share token becomes a proxy", async () => {
    const proxyDrift = dependencies();
    proxyDrift.fetchEvmStorageAtBlock.mockImplementation(
      async (chainId) =>
        chainId === "base"
          ? (`0x${"1".padStart(64, "0")}` as const)
          : (`0x${"0".repeat(64)}` as const),
    );

    await expect(observeAttempt(proxyDrift)).resolves.toEqual({
      status: "rejected",
      rejectionCode: "deployment-state-invalid",
      failedRouteId: routeForChain("base").routeId,
    });
  });

  it.each(["jtrsy-anemoy", "acrdx-anemoy-apollo"])("reads the rotated Token-2022 authority for %s and rejects its predecessor", async (assetId) => {
    const route = buildReviewedDeploymentRouteInventory(assetId)!.routes.find(row => row.chainId === "solana")!;
    const identity = expectedCentrifugeDeploymentIdentity(
      assetId,
      route.routeId,
    );
    if (!identity || identity.runtime !== "solana") {
      throw new Error("Missing JTRSY Solana identity");
    }
    const authority = "BUo4FKP1hSAZ1zcNGzJHTS1V9zcQM8fzUFpYj1NboRK4";
    expect(identity).toMatchObject({
      mintAuthority: authority, controllerAddress: authority,
      programOwner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      controllerProgramOwner: "11111111111111111111111111111111",
    });
    let observedAuthority = authority;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === "getMultipleAccounts") {
        expect(params).toEqual([
          [route.contractAddress, identity.controllerAddress],
          { commitment: "finalized", encoding: "jsonParsed" },
        ]);
        return {
          context: { slot: 465_239_190 },
          value: [
            {
              owner: identity.programOwner,
              data: {
                parsed: {
                  info: {
                    decimals: 6,
                    supply: "0",
                    mintAuthority: observedAuthority,
                    freezeAuthority: observedAuthority,
                  },
                },
              },
            },
            {
              owner: identity.controllerProgramOwner,
              executable: false,
            },
          ],
        };
      }
      if (method === "getBlocks") {
        expect(params).toEqual([
          465_239_126,
          465_239_190,
          { commitment: "finalized", minContextSlot: 465_239_190 },
        ]);
        return [465_239_190];
      }
      expect(method).toBe("getBlock");
      return {
        blockhash: "8CyVUSfa6dgiAgAFNQY261sEMYrCSktpSfdsq1UwbMAD",
        blockTime: 1_793_781_842,
      };
    });

    const fetch = () => fetchSolanaCentrifugeDeploymentObservation(
      assetId, route.routeId, route.contractAddress, undefined, rpc as unknown as CentrifugeSolanaRpcFetcher,
    );
    await expect(fetch()).resolves.toMatchObject({
      rawSupply: "0",
      blockNumberOrSlot: "465239190",
      blockTimeSec: 1_793_781_842,
      decimals: 6,
      programOwner: identity.programOwner,
      mintAuthority: identity.mintAuthority,
      controllerProgramOwner: identity.controllerProgramOwner,
    });
    observedAuthority = "3JiU6sJt94WcD6r7EFTUnJo6By9DJ9WJxovRGfY9oseb";
    await expect(fetch()).resolves.toBeNull();
  });
});
