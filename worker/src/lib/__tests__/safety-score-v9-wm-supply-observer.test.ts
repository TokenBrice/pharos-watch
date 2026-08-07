import { describe, expect, it, vi } from "vitest";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import type { ChainRpcConfig } from "../chain-registry";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../evm-rpc";
import {
  buildReviewedDeploymentRouteInventory,
  expectedWmDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  fetchSolanaWmDeploymentObservation,
  observeWmReviewedDeploymentUnitPartition,
  observeWmReviewedDeploymentUnitPartitionAttempt,
  type SolanaRpcFetcher,
  WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN,
} from "../safety-score-v9-wm-supply-observer";

const AGGREGATE_SUPPLY_USD = 87_020_618.58982982;
const CLOCK_SEC = 1_784_881_340;
const REGISTRY_FINGERPRINT = "a".repeat(64);

const RAW_BY_CHAIN: Record<string, bigint> = {
  ethereum: 86_712_798_085_682n,
  arbitrum: 88_459_935_972n,
  base: 70_802_728_527n,
  plume: 1n,
};

const BLOCK_BY_CHAIN: Record<string, number> = {
  ethereum: 25_601_369,
  arbitrum: 487_159_819,
  base: 49_045_990,
  plume: 83_016_829,
};

const TIME_BY_CHAIN: Record<string, number> = {
  ethereum: 1_784_881_319,
  arbitrum: 1_784_881_326,
  base: 1_784_881_327,
  plume: 1_784_881_328,
};

const RUNTIME_CODE_BY_CHAIN: Record<string, `0x${string}`> = {
  ethereum: "0x60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc54365f80375f80365f845af43d5f803e808015603f573d5ff35b3d5ffdfea2646970667358221220d2631db1b18b2947844c1d7d37e70f0971180c52e4a2cab755f41723bab4648764736f6c63430008170033",
  arbitrum: "0x60806040525f807f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc54368280378136915af43d5f803e15603d573d5ff35b3d5ffdfea2646970667358221220873fa86d070f0e378ace52953e252f64968354d185bab148e3a6aad8dcd9523f64736f6c634300081a0033",
  base: "0x60806040525f8073ffffffffffffffffffffffffffffffffffffffff7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5416368280378136915af43d5f803e156053573d5ff35b3d5ffdfea26469706673582212203fa62813d58f399d153670a92f46384f2ea4f80e48ba9cb71cfdead84a3b7f8d64736f6c634300081a0033",
  plume: "0x6080604052600a600c565b005b60186014601a565b605d565b565b5f60587f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5473ffffffffffffffffffffffffffffffffffffffff1690565b905090565b365f80375f80365f845af43d5f803e8080156076573d5ff35b3d5ffdfea2646970667358221220235077aeb2ddadd8a33ba3e240b110e0341538b2f43ca3e7c2c8d7794680257a64736f6c634300081a0033",
};

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map(
    ["ethereum", "arbitrum", "base"].map((chainId) => [
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

function evmImplementationAddress(chainId: string | undefined): string | null {
  if (!chainId) return null;
  const identity = expectedWmDeploymentIdentity(
    `${chainId}:0x437cc33344a0b27a429f795ff6b469c72698b291`,
  );
  return identity?.runtime === "evm" ? identity.implementationAddress : null;
}

function evmCodeAtBlock(
  chainId: string | undefined,
  address: string,
): `0x${string}` | null {
  if (!chainId) return null;
  const routeIdentity = expectedWmDeploymentIdentity(
    `${chainId}:0x437cc33344a0b27a429f795ff6b469c72698b291`,
  );
  if (
    routeIdentity?.runtime === "evm" &&
    address.toLowerCase() === routeIdentity.implementationAddress
  ) {
    const marker = ["ethereum", "arbitrum", "base", "plume"].indexOf(chainId) + 1;
    return marker > 0
      ? (`0x${marker.toString(16).padStart(2, "0")}` as const)
      : null;
  }
  return RUNTIME_CODE_BY_CHAIN[chainId] ?? null;
}

function solanaObservation(): ReviewedDeploymentSupplyObservation {
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0")!;
  const route = inventory.routes.find((candidate) => candidate.chainId === "solana")!;
  const identity = expectedWmDeploymentIdentity(route.routeId);
  if (!identity || identity.runtime !== "solana") throw new Error("Missing Solana identity");
  return {
    routeId: route.routeId,
    chainId: route.chainId,
    contractAddress: route.contractAddress,
    decimals: route.decimals,
    rawSupply: "247794997129",
    blockNumberOrSlot: "434885841",
    blockTimeSec: 1_784_881_315,
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
      if (bytes.length === 1) {
        const chainId = ["ethereum", "arbitrum", "base", "plume"][
          bytes[0]! - 1
        ];
        if (chainId) {
          const identity = expectedWmDeploymentIdentity(
            `${chainId}:0x437cc33344a0b27a429f795ff6b469c72698b291`,
          );
          if (identity?.runtime === "evm") {
            return identity.implementationCodeSha256;
          }
        }
      }
      return sha256HexFromBytes(bytes);
    }),
    fetchEvmBlockNumber: vi.fn(async (chainId: string) => BLOCK_BY_CHAIN[chainId] ?? null),
    fetchEvmBlockHeader: vi.fn(
      async (chainId: string, blockNumber: number | "finalized", _options?: unknown) =>
        blockNumber === "finalized"
          ? null
          : {
              number: blockNumber,
              timestamp: TIME_BY_CHAIN[chainId]!,
              hash: `0x${"a".repeat(64)}` as const,
            },
    ),
    fetchEvmCodeAtBlock: vi.fn(
      async (chainId: string | undefined, address: string) =>
        evmCodeAtBlock(chainId, address),
    ),
    fetchEvmStorageAtBlock: vi.fn(async (chainId: string | undefined) => {
      const implementationAddress = evmImplementationAddress(chainId);
      return implementationAddress ? addressWord(implementationAddress) : null;
    }),
    fetchEvmMulticall3Aggregate3AtBlock: vi.fn(
      async (
        chainId: string | undefined,
        calls: readonly EvmMulticall3Call[],
      ): Promise<EvmMulticall3Result[] | null> => {
        if (!chainId) return null;
        const routeId = `${chainId}:0x437cc33344a0b27a429f795ff6b469c72698b291`;
        const identity = expectedWmDeploymentIdentity(routeId);
        if (!identity || identity.runtime !== "evm") return null;
        const values: Record<string, `0x${string}`> = {
          "total-supply": uint256(RAW_BY_CHAIN[chainId]!),
          decimals: uint256(6n),
          "m-token": addressWord(identity.underlyingTokenAddress),
          controller: addressWord(identity.controllerAddress),
        };
        return calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: values[call.label]!,
        }));
      },
    ),
    fetchSolanaObservation: vi.fn(
      async (): Promise<ReviewedDeploymentSupplyObservation | null> => solanaObservation(),
    ),
  };
}

async function observe(overrides: ReturnType<typeof dependencies> = dependencies()) {
  return observeWmReviewedDeploymentUnitPartition(
    {
      aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
      registryFingerprint: REGISTRY_FINGERPRINT,
      scoringClockSec: CLOCK_SEC,
      chainRpcs: chainRpcs(),
    },
    overrides,
  );
}

describe("wM reviewed deployment observer", () => {
  it("captures all EVM and Solana routes atomically at reviewed identities", async () => {
    const deps = dependencies();
    const attribution = await observe(deps);

    expect(attribution).not.toBeNull();
    expect(attribution!.deployments).toHaveLength(5);
    expect(attribution!.deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)).toBe(
      AGGREGATE_SUPPLY_USD,
    );
    expect(attribution!.deployments.find((row) => row.chainId === "solana")).toMatchObject({
      programOwner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      controllerAddress: "mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY",
    });
    expect(deps.fetchEvmBlockNumber).toHaveBeenCalledTimes(4);
    expect(deps.fetchSolanaObservation).toHaveBeenCalledTimes(1);
  });

  it("accepts a finalized Solana observation just after the fixed clock", async () => {
    const deps = dependencies();
    deps.fetchSolanaObservation.mockResolvedValue({
      ...solanaObservation(),
      blockTimeSec: CLOCK_SEC + 5,
    });

    const attempt = await observeWmReviewedDeploymentUnitPartitionAttempt(
      {
        aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        chainRpcs: chainRpcs(),
      },
      deps,
    );

    expect(attempt.status).toBe("accepted");
    if (attempt.status !== "accepted") throw new Error("Expected accepted wM attribution");
    expect(attempt.attribution.observedAtSec).toBe(CLOCK_SEC + 5);
  });

  it("reports an over-wide cross-chain observation envelope as skew", async () => {
    const deps = dependencies();
    const solana = solanaObservation();
    deps.fetchSolanaObservation.mockResolvedValue({
      ...solana,
      blockTimeSec: CLOCK_SEC + 121,
    });

    await expect(
      observeWmReviewedDeploymentUnitPartitionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: REGISTRY_FINGERPRINT,
          scoringClockSec: CLOCK_SEC,
          chainRpcs: chainRpcs(),
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "rejected",
      rejectionCode: "deployment-observation-skew",
      failedRouteId: solana.routeId,
    });
  });

  it("walks back from a head newer than the fixed scoring clock", async () => {
    const deps = dependencies();
    deps.fetchEvmBlockHeader.mockImplementation(async (chainId, blockNumber) =>
      blockNumber === "finalized"
        ? null
        : {
            number: blockNumber,
            timestamp: blockNumber === BLOCK_BY_CHAIN[chainId]! - WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN[chainId]!
              ? CLOCK_SEC + 2
              : TIME_BY_CHAIN[chainId]!,
            hash: `0x${"a".repeat(64)}` as const,
          },
    );

    const attribution = await observe(deps);

    expect(attribution).not.toBeNull();
    for (const chainId of Object.keys(BLOCK_BY_CHAIN)) {
      expect(deps.fetchEvmBlockHeader).toHaveBeenCalledWith(
        chainId,
        BLOCK_BY_CHAIN[chainId]! - WM_EVM_SAFE_BLOCK_LAG_BY_CHAIN[chainId]! - 1,
        expect.any(Object),
      );
    }
    expect(deps.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Number),
      expect.any(Object),
    );
  });

  it("rejects the whole packet when Plume or Solana is unavailable", async () => {
    const missingPlume = dependencies();
    missingPlume.fetchEvmCodeAtBlock.mockImplementation(async (chainId, address) =>
      chainId === "plume" ? null : evmCodeAtBlock(chainId, address),
    );
    await expect(observe(missingPlume)).resolves.toBeNull();

    const missingSolana = dependencies();
    missingSolana.fetchSolanaObservation.mockResolvedValue(null);
    await expect(observe(missingSolana)).resolves.toBeNull();
  });

  it("returns bounded route-specific rejection provenance", async () => {
    const unavailable = dependencies();
    unavailable.fetchEvmCodeAtBlock.mockImplementation(async (chainId, address) =>
      chainId === "base" ? null : evmCodeAtBlock(chainId, address),
    );

    await expect(
      observeWmReviewedDeploymentUnitPartitionAttempt(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: REGISTRY_FINGERPRINT,
          scoringClockSec: CLOCK_SEC,
          chainRpcs: chainRpcs(),
        },
        unavailable,
      ),
    ).resolves.toEqual({
      status: "rejected",
      rejectionCode: "deployment-state-unavailable",
      failedRouteId: "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
    });
  });

  it("rejects a runtime-code or controller identity change", async () => {
    const wrongCode = dependencies();
    wrongCode.fetchEvmCodeAtBlock.mockImplementation(async (chainId, address) =>
      chainId === "base" && address.toLowerCase() !== evmImplementationAddress("base")
        ? "0x6000"
        : evmCodeAtBlock(chainId, address),
    );
    await expect(observe(wrongCode)).resolves.toBeNull();

    const wrongController = dependencies();
    wrongController.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (chainId, calls): Promise<EvmMulticall3Result[] | null> => {
        if (!chainId) return null;
        const routeId = `${chainId}:0x437cc33344a0b27a429f795ff6b469c72698b291`;
        const identity = expectedWmDeploymentIdentity(routeId);
        if (!identity || identity.runtime !== "evm") return null;
        return calls.map((call) => ({
          label: call.label,
          success: true,
          returnData:
            call.label === "total-supply"
              ? uint256(RAW_BY_CHAIN[chainId]!)
              : call.label === "decimals"
                ? uint256(6n)
                : call.label === "m-token"
                  ? addressWord(identity.underlyingTokenAddress)
                  : addressWord(
                      chainId === "arbitrum"
                        ? "0x0000000000000000000000000000000000000001"
                        : identity.controllerAddress,
                    ),
        }));
      },
    );
    await expect(observe(wrongController)).resolves.toBeNull();
  });

  it("rejects implementation bytecode drift at the pinned block", async () => {
    const baseImplementation = evmImplementationAddress("base");
    if (!baseImplementation) throw new Error("Missing Base implementation identity");
    const drifted = dependencies();
    drifted.fetchEvmCodeAtBlock.mockImplementation(async (chainId, address) =>
      chainId === "base" &&
      address.toLowerCase() === baseImplementation
        ? "0x6000"
        : evmCodeAtBlock(chainId, address),
    );

    await expect(observe(drifted)).resolves.toBeNull();
    expect(drifted.fetchEvmCodeAtBlock).toHaveBeenCalledWith(
      "base",
      baseImplementation,
      expect.any(Number),
      expect.any(Object),
    );
  });

  it("rejects the retired V1 implementation on every migrated chain", async () => {
    for (const migratedChain of ["arbitrum", "base", "ethereum"]) {
      const outdated = dependencies();
      outdated.fetchEvmStorageAtBlock.mockImplementation(async (chainId) => {
        const implementationAddress = chainId === migratedChain
          ? "0x813b926b1d096e117721bd1eb017fba122302da0"
          : evmImplementationAddress(chainId);
        return implementationAddress ? addressWord(implementationAddress) : null;
      });

      await expect(
        observeWmReviewedDeploymentUnitPartitionAttempt(
          {
            aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
            registryFingerprint: REGISTRY_FINGERPRINT,
            scoringClockSec: CLOCK_SEC,
            chainRpcs: chainRpcs(),
          },
          outdated,
        ),
      ).resolves.toEqual({
        status: "rejected",
        rejectionCode: "deployment-identity-mismatch",
        failedRouteId: `${migratedChain}:0x437cc33344a0b27a429f795ff6b469c72698b291`,
      });
    }
  });

  it("reads Solana mint and controller from one finalized context and binds its block hash", async () => {
    const inventory = buildReviewedDeploymentRouteInventory("wm-m0")!;
    const route = inventory.routes.find((candidate) => candidate.chainId === "solana")!;
    const identity = expectedWmDeploymentIdentity(route.routeId);
    if (!identity || identity.runtime !== "solana") throw new Error("Missing Solana identity");
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === "getMultipleAccounts") {
        expect(params).toEqual([
          [route.contractAddress, identity.controllerAddress],
          { commitment: "finalized", encoding: "jsonParsed" },
        ]);
        return {
          context: { slot: 434_885_841 },
          value: [
            {
              owner: identity.programOwner,
              data: {
                parsed: {
                  info: {
                    decimals: route.decimals,
                    supply: "247794997129",
                    mintAuthority: identity.mintAuthority,
                  },
                },
              },
            },
            {
              owner: identity.controllerProgramOwner,
              executable: true,
            },
          ],
        };
      }
      expect(method).toBe("getBlock");
      expect(params).toEqual([
        434_885_841,
        {
          commitment: "finalized",
          transactionDetails: "none",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      return {
        blockhash: "B".repeat(44),
        blockTime: 1_784_881_315,
      };
    });

    await expect(
      fetchSolanaWmDeploymentObservation(
        route.routeId,
        route.contractAddress,
        undefined,
        rpc as unknown as SolanaRpcFetcher,
      ),
    ).resolves.toMatchObject({
      blockNumberOrSlot: "434885841",
      blockTimeSec: 1_784_881_315,
      blockHash: "B".repeat(44),
      controllerProgramOwner: identity.controllerProgramOwner,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation instead of turning it into missing evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      observeWmReviewedDeploymentUnitPartition(
        {
          aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
          registryFingerprint: REGISTRY_FINGERPRINT,
          scoringClockSec: CLOCK_SEC,
          chainRpcs: chainRpcs(),
          signal: controller.signal,
        },
        dependencies(),
      ),
    ).rejects.toThrow();
  });
});
