import { describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
} from "../evm-rpc";
import {
  buildReviewedDeploymentRouteInventory,
  expectedCentrifugeDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  fetchSolanaCentrifugeDeploymentObservation,
  observeCentrifugeReviewedDeploymentUnitPartition,
  observeCentrifugeReviewedDeploymentUnitPartitionAttempt,
  type CentrifugeSolanaRpcFetcher,
} from "../safety-score-v9-centrifuge-supply-observer";

const ASSET_ID = "acrdx-anemoy-apollo";
const AGGREGATE_SUPPLY_USD = 51_033_069.79770032;
const CLOCK_SEC = 1_784_904_600;
const REGISTRY_FINGERPRINT = "a".repeat(64);

const RAW_BY_CHAIN: Record<string, bigint> = {
  ethereum: 378_869_494_500_836_268_665_209n,
  plume: 32_320_262_971_888_335_278_993_277n,
  monad: 9_837_361_464_973_825_379_103_908n,
  base: 0n,
};

const BLOCK_BY_CHAIN: Record<string, number> = {
  ethereum: 25_603_299,
  plume: 83_072_568,
  monad: 89_944_923,
  base: 49_057_583,
};

const TIME_BY_CHAIN: Record<string, number> = {
  ethereum: CLOCK_SEC - 30,
  plume: CLOCK_SEC - 7,
  monad: CLOCK_SEC - 4,
  base: CLOCK_SEC - 20,
};

const EVM_CHAINS = ["ethereum", "plume", "monad", "base"] as const;

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map(
    ["ethereum", "base"].map((chainId) => [
      chainId,
      {
        chainId,
        chainName: chainId,
        type: "evm" as const,
        rpcUrl: `https://${chainId}.example`,
        explorerUrl: `https://${chainId}.example/explorer`,
      },
    ]),
  );
}

function routeForChain(chainId: string) {
  return buildReviewedDeploymentRouteInventory(ASSET_ID)!.routes.find(
    (route) => route.chainId === chainId,
  )!;
}

function solanaObservation(): ReviewedDeploymentSupplyObservation {
  const route = routeForChain("solana");
  const identity = expectedCentrifugeDeploymentIdentity(
    ASSET_ID,
    route.routeId,
  );
  if (!identity || identity.runtime !== "solana") {
    throw new Error("Missing ACRDX Solana identity");
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
          decimals: uint256(18n),
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

async function observe(
  overrides: ReturnType<typeof dependencies> = dependencies(),
) {
  return observeCentrifugeReviewedDeploymentUnitPartition(
    {
      assetId: ASSET_ID,
      aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
      registryFingerprint: REGISTRY_FINGERPRINT,
      scoringClockSec: CLOCK_SEC,
      chainRpcs: chainRpcs(),
    },
    overrides,
  );
}

describe("Centrifuge reviewed deployment observer", () => {
  it("captures the complete EVM and Solana burn/mint inventory atomically", async () => {
    const deps = dependencies();
    const attribution = await observe(deps);

    expect(attribution).not.toBeNull();
    expect(attribution!.deployments).toHaveLength(5);
    expect(
      attribution!.deployments.reduce(
        (sum, row) => sum + row.currentSupplyUsd,
        0,
      ),
    ).toBe(AGGREGATE_SUPPLY_USD);
    expect(
      attribution!.deployments.filter((row) => row.rawSupply === "0"),
    ).toEqual([
      expect.objectContaining({ chainId: "base", currentSupplyUsd: 0 }),
      expect.objectContaining({ chainId: "solana", currentSupplyUsd: 0 }),
    ]);
    expect(deps.fetchEvmBlockNumber).toHaveBeenCalledTimes(4);
    expect(deps.fetchSolanaObservation).toHaveBeenCalledTimes(1);
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
                ? uint256(18n)
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

    await expect(
      observeCentrifugeReviewedDeploymentUnitPartitionAttempt(
        {
          assetId: ASSET_ID,
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: REGISTRY_FINGERPRINT,
          scoringClockSec: CLOCK_SEC,
          chainRpcs: chainRpcs(),
        },
        proxyDrift,
      ),
    ).resolves.toEqual({
      status: "rejected",
      rejectionCode: "deployment-state-invalid",
      failedRouteId:
        "base:0x9477724bb54ad5417de8baff29e59df3fb4da74f",
    });
  });

  it("reads the pinned Token-2022 mint and direct authority from one finalized context", async () => {
    const route = routeForChain("solana");
    const identity = expectedCentrifugeDeploymentIdentity(
      ASSET_ID,
      route.routeId,
    );
    if (!identity || identity.runtime !== "solana") {
      throw new Error("Missing ACRDX Solana identity");
    }
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === "getMultipleAccounts") {
        expect(params).toEqual([
          [route.contractAddress, identity.controllerAddress],
          { commitment: "finalized", encoding: "jsonParsed" },
        ]);
        return {
          context: { slot: 434_941_163 },
          value: [
            {
              owner: identity.programOwner,
              data: {
                parsed: {
                  info: {
                    decimals: route.decimals,
                    supply: "0",
                    mintAuthority: identity.mintAuthority,
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
      expect(method).toBe("getBlock");
      return {
        blockhash: "B".repeat(44),
        blockTime: CLOCK_SEC - 3,
      };
    });

    await expect(
      fetchSolanaCentrifugeDeploymentObservation(
        ASSET_ID,
        route.routeId,
        route.contractAddress,
        undefined,
        rpc as unknown as CentrifugeSolanaRpcFetcher,
      ),
    ).resolves.toMatchObject({
      rawSupply: "0",
      blockNumberOrSlot: "434941163",
      programOwner: identity.programOwner,
      mintAuthority: identity.mintAuthority,
      controllerProgramOwner: identity.controllerProgramOwner,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
