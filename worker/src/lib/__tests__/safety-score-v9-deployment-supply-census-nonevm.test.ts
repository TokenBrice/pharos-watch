import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { SafetyScoreV9SolanaRpcFetcher } from "../safety-score-v9/supply-observation-primitives";
import type { MoveFungibleAssetSupplyObservation } from "../../cron/reserve-adapters/token-supply";
import {
  deploymentSupplyCensusChainReadKind,
  deploymentSupplyCensusPinAgeIssue,
  deploymentSupplyCensusPinSkewIssue,
  observeDeploymentSupplyCensusNonEvmChain,
} from "../safety-score-v9/deployment-supply-census-nonevm";
import type {
  DeploymentSupplyCensusChainRead,
  DeploymentSupplyCensusReadTarget,
} from "../safety-score-v9/deployment-supply-census-evm";

const CENSUS = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.deploymentSupplyCensus;
const SUPPLY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
const CLOCK = 1_793_294_244;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BLOCK_HASH = "1".repeat(32);
const APTOS_ADDRESS = `0x${"a".repeat(64)}`;
const MOVE_PACKAGE = `0x${"b".repeat(64)}`;

interface SolanaAccountFixture {
  owner?: string;
  decimals?: number;
  supply?: string;
  parsedType?: string;
}

function solanaMint(overrides: SolanaAccountFixture = {}): SolanaAccountFixture {
  return { owner: TOKEN_PROGRAM, decimals: 6, supply: "1000000", parsedType: "mint", ...overrides };
}

function solanaTarget(
  address: string,
  overrides: Partial<DeploymentSupplyCensusReadTarget> = {},
): DeploymentSupplyCensusReadTarget {
  return {
    assetId: "ausd-agora",
    chainId: "solana",
    tokenAddress: address,
    routeId: `solana:${address}`,
    expectedDecimals: 6,
    ...overrides,
  };
}

function moveTarget(
  address: string,
  overrides: Partial<DeploymentSupplyCensusReadTarget> = {},
): DeploymentSupplyCensusReadTarget {
  return {
    assetId: "sfrxusd-frax",
    chainId: "aptos",
    tokenAddress: address,
    routeId: `aptos:${address}`,
    expectedDecimals: 6,
    ...overrides,
  };
}

interface SolanaFixtureOptions {
  slot?: number;
  slots?: number[] | null;
  blockTime?: number;
  blockHash?: string;
  accounts?: (SolanaAccountFixture | null)[];
  calls?: [string, unknown[]][];
}

function solanaRpc(options: SolanaFixtureOptions = {}): SafetyScoreV9SolanaRpcFetcher {
  return async <T>(method: string, params: unknown[]): Promise<T | null> => {
    options.calls?.push([method, params]);
    if (method === "getMultipleAccounts") {
      const addresses = params[0] as string[];
      return {
        context: { slot: options.slot ?? 500 },
        value: addresses.map((_, index) => {
          const account = options.accounts === undefined ? solanaMint() : options.accounts[index] ?? null;
          if (account === null) return null;
          return {
            owner: account.owner ?? TOKEN_PROGRAM,
            data: {
              parsed: {
                type: account.parsedType ?? "mint",
                info: { supply: account.supply ?? "1000000", decimals: account.decimals ?? 6 },
              },
            },
          };
        }),
      } as T;
    }
    if (method === "getBlocks") return (options.slots === undefined ? [499] : options.slots) as T;
    if (method === "getBlock") {
      return {
        blockTime: options.blockTime ?? CLOCK - 60,
        blockhash: options.blockHash ?? BLOCK_HASH,
      } as T;
    }
    return null;
  };
}

function measured(
  result: DeploymentSupplyCensusChainRead,
): Extract<DeploymentSupplyCensusChainRead, { kind: "measured" }> {
  if (result.kind !== "measured") throw new Error(`expected measured chain read, received ${result.reason}`);
  return result;
}

describe("non-EVM census chain family", () => {
  it("reads Solana and Aptos-framework Move, routes EVM to the EVM reader and leaves every other family null", () => {
    expect(deploymentSupplyCensusChainReadKind("solana")).toBe("solana-mint");
    expect(deploymentSupplyCensusChainReadKind("aptos")).toBe("move-fa-supply");
    expect(deploymentSupplyCensusChainReadKind("movement")).toBe("move-fa-supply");
    expect(deploymentSupplyCensusChainReadKind("ethereum")).toBe("evm-total-supply");
    for (const chainId of ["sui", "starknet", "cosmos", "tron", "stellar", "near", "hyperliquid"]) {
      expect(deploymentSupplyCensusChainReadKind(chainId), chainId).toBeNull();
    }
  });

  it("returns an asset-level read-unavailable rejection for a chain without a reviewed reader, never zero", async () => {
    const suiTarget: DeploymentSupplyCensusReadTarget = {
      assetId: "ausd-agora", chainId: "sui", tokenAddress: `0x${"1".repeat(64)}::ausd::AUSD`,
      routeId: "sui:ausd", expectedDecimals: 6,
    };
    for (const chainId of ["sui", "starknet", "stellar"]) {
      const result = await observeDeploymentSupplyCensusNonEvmChain({
        chainId,
        targets: [suiTarget],
        scoringClockSec: CLOCK,
        chainRpcs: new Map(),
      });
      expect(result).toEqual({ kind: "rejected", reason: "read-unavailable" });
    }
  });
});

describe("Solana finalized-slot census", () => {
  it("pins one produced finalized block for a batch of mints", async () => {
    const calls: [string, unknown[]][] = [];
    const rpc = solanaRpc({
      calls,
      accounts: [solanaMint({ supply: "1000000" }), solanaMint({ supply: "2000000", owner: TOKEN_2022_PROGRAM })],
    });
    const result = measured(await observeDeploymentSupplyCensusNonEvmChain({
      chainId: "solana",
      targets: [solanaTarget("MintA"), solanaTarget("MintB")],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, { fetchSafetyScoreV9SolanaRpc: rpc }));

    const accountsCall = calls.find(([method]) => method === "getMultipleAccounts");
    expect(accountsCall?.[1]).toEqual([
      ["MintA", "MintB"],
      { commitment: "finalized", encoding: "jsonParsed" },
    ]);
    expect(calls.filter(([method]) => method === "getBlocks")).toHaveLength(1);
    expect(calls.filter(([method]) => method === "getBlock")).toHaveLength(1);
    expect(calls.find(([method]) => method === "getBlocks")?.[1]).toEqual([
      436, 500, { commitment: "finalized", minContextSlot: 500 },
    ]);

    expect(result.rows.get("solana:MintA")).toEqual({
      decimals: 6,
      totalSupplyRaw: "1000000",
      pin: {
        kind: "solana-finalized-slot",
        slot: 499,
        blockHash: BLOCK_HASH,
        blockTimeSec: CLOCK - 60,
        mintProgramOwner: TOKEN_PROGRAM,
      },
    });
    const mintBPin = result.rows.get("solana:MintB")?.pin;
    expect(mintBPin?.kind === "solana-finalized-slot" ? mintBPin.mintProgramOwner : null).toBe(TOKEN_2022_PROGRAM);
    expect(result.rejected.size).toBe(0);
  });

  it("batches mint reads by the policy account cap", async () => {
    const batchSizes: number[] = [];
    const rpc: SafetyScoreV9SolanaRpcFetcher = async <T>(method: string, params: unknown[]): Promise<T | null> => {
      if (method === "getMultipleAccounts") {
        const addresses = params[0] as string[];
        batchSizes.push(addresses.length);
        expect(params[1]).toEqual({ commitment: "finalized", encoding: "jsonParsed" });
        return {
          context: { slot: 900 },
          value: addresses.map(() => ({
            owner: TOKEN_PROGRAM,
            data: { parsed: { type: "mint", info: { supply: "1", decimals: 6 } } },
          })),
        } as T;
      }
      if (method === "getBlocks") return [899] as T;
      if (method === "getBlock") return { blockTime: CLOCK - 10, blockhash: BLOCK_HASH } as T;
      return null;
    };
    const targets = Array.from({ length: CENSUS.solanaMaxAccountsPerRequest + 1 }, (_, index) =>
      solanaTarget(`Mint${index}`));
    const result = measured(await observeDeploymentSupplyCensusNonEvmChain({
      chainId: "solana", targets, scoringClockSec: CLOCK, chainRpcs: new Map(),
    }, { fetchSafetyScoreV9SolanaRpc: rpc }));

    expect(batchSizes).toEqual([CENSUS.solanaMaxAccountsPerRequest, 1]);
    expect(result.rows.size).toBe(targets.length);
    expect(result.rejected.size).toBe(0);
  });

  it("admits the observation boundary and rejects a future or stale pin", async () => {
    const read = (blockTime: number) => observeDeploymentSupplyCensusNonEvmChain({
      chainId: "solana",
      targets: [solanaTarget("MintA")],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, { fetchSafetyScoreV9SolanaRpc: solanaRpc({ blockTime }) });

    expect(measured(await read(CLOCK)).rows.get("solana:MintA")?.pin.blockTimeSec).toBe(CLOCK);
    expect(measured(await read(CLOCK - SUPPLY.observationMaxAgeSec)).rows.size).toBe(1);
    expect(measured(await read(CLOCK - SUPPLY.observationMaxAgeSec - 1)).rejected.get("solana:MintA"))
      .toBe("observation-stale");
    expect(measured(await read(CLOCK + 1)).rejected.get("solana:MintA")).toBe("future-dated-pin");
  });

  it("rejects malformed or unreviewed mint reads without publishing a quantity", async () => {
    const read = async (account: SolanaAccountFixture | null, target = solanaTarget("MintA")) =>
      measured(await observeDeploymentSupplyCensusNonEvmChain({
        chainId: "solana", targets: [target], scoringClockSec: CLOCK, chainRpcs: new Map(),
      }, { fetchSafetyScoreV9SolanaRpc: solanaRpc({ accounts: [account] }) }));

    const missing = await read(null);
    expect(missing.rows.size).toBe(0);
    expect(missing.rejected.get("solana:MintA")).toBe("read-unavailable");

    expect((await read(solanaMint({ owner: "NotATokenProgram" }))).rejected.get("solana:MintA"))
      .toBe("read-unavailable");
    expect((await read(solanaMint({ parsedType: "account" }))).rejected.get("solana:MintA"))
      .toBe("read-unavailable");
    expect((await read(solanaMint({ supply: "01" }))).rejected.get("solana:MintA"))
      .toBe("read-unavailable");
    expect((await read(solanaMint({ decimals: 9 }))).rejected.get("solana:MintA"))
      .toBe("route-unreviewed");
    const reviewedToken2022 = solanaTarget("MintA", { programOwner: TOKEN_2022_PROGRAM });
    expect((await read(solanaMint({ owner: TOKEN_PROGRAM }), reviewedToken2022)).rejected.get("solana:MintA"))
      .toBe("route-unreviewed");
  });

  it("fails closed when the finalized anchor cannot be proven", async () => {
    const read = async (options: SolanaFixtureOptions) =>
      measured(await observeDeploymentSupplyCensusNonEvmChain({
        chainId: "solana", targets: [solanaTarget("MintA")], scoringClockSec: CLOCK, chainRpcs: new Map(),
      }, { fetchSafetyScoreV9SolanaRpc: solanaRpc(options) }));

    const noBlock = await read({ slots: [] });
    expect(noBlock.rows.size).toBe(0);
    expect(noBlock.rejected.get("solana:MintA")).toBe("missing-block-pin");

    expect((await read({ slots: [499], blockHash: "not-a-blockhash" })).rejected.get("solana:MintA"))
      .toBe("missing-block-pin");
    expect((await read({ slots: null })).rejected.get("solana:MintA")).toBe("read-unavailable");
  });
});

describe("Move ledger-version census", () => {
  const observation: MoveFungibleAssetSupplyObservation = {
    rawSupply: 123456789n,
    decimals: 6,
    ledgerVersion: "9876543210",
    ledgerTimestampSec: CLOCK - 45,
  };

  it("pins the fungible-asset ledger version read at or before the census clock", async () => {
    const calls: { address: string; url: string; options: unknown }[] = [];
    const result = measured(await observeDeploymentSupplyCensusNonEvmChain({
      chainId: "aptos",
      targets: [moveTarget(APTOS_ADDRESS)],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      fetchMoveFungibleAssetSupply: async (address, _signal, url, _ctx, options) => {
        calls.push({ address, url, options });
        return observation;
      },
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.mainnet.aptoslabs.com/v1");
    expect(calls[0]!.options).toMatchObject({
      clockSec: CLOCK,
      expectedChainId: 1,
      expectedDecimals: 6,
      identityKind: "metadata-address",
    });
    expect(result.rows.get(`aptos:${APTOS_ADDRESS}`)).toEqual({
      decimals: 6,
      totalSupplyRaw: "123456789",
      pin: {
        kind: "move-ledger-version",
        ledgerVersion: "9876543210",
        blockTimeSec: CLOCK - 45,
        packageAddress: APTOS_ADDRESS,
      },
    });
  });

  it("reads a reviewed OFT package through its metadata and pins the package address", async () => {
    const calls: { address: string; options: unknown }[] = [];
    const metadata = `0x${"c".repeat(64)}`;
    const result = measured(await observeDeploymentSupplyCensusNonEvmChain({
      chainId: "movement",
      targets: [moveTarget(metadata, {
        chainId: "movement",
        routeId: `movement:${MOVE_PACKAGE}`,
        packageAddress: MOVE_PACKAGE,
      })],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      fetchMoveFungibleAssetSupply: async (address, _signal, _url, _ctx, options) => {
        calls.push({ address, options });
        return observation;
      },
    }));

    expect(calls[0]!.address).toBe(MOVE_PACKAGE);
    expect(calls[0]!.options).toMatchObject({
      expectedChainId: 126,
      identityKind: "oft-package",
      expectedMetadataAddress: metadata,
    });
    expect(result.rows.get(`movement:${MOVE_PACKAGE}`)?.pin).toMatchObject({
      kind: "move-ledger-version",
      packageAddress: MOVE_PACKAGE,
    });
  });

  it("admits the observation boundary and rejects a future or stale ledger timestamp", async () => {
    const read = (ledgerTimestampSec: number) => observeDeploymentSupplyCensusNonEvmChain({
      chainId: "aptos", targets: [moveTarget(APTOS_ADDRESS)], scoringClockSec: CLOCK, chainRpcs: new Map(),
    }, { fetchMoveFungibleAssetSupply: async () => ({ ...observation, ledgerTimestampSec }) });

    expect(measured(await read(CLOCK)).rows.size).toBe(1);
    expect(measured(await read(CLOCK - SUPPLY.observationMaxAgeSec)).rows.size).toBe(1);
    expect(measured(await read(CLOCK - SUPPLY.observationMaxAgeSec - 1)).rejected.get(`aptos:${APTOS_ADDRESS}`))
      .toBe("observation-stale");
    expect(measured(await read(CLOCK + 1)).rejected.get(`aptos:${APTOS_ADDRESS}`)).toBe("future-dated-pin");
  });

  it("rejects a missing pin, an unreviewed unit basis or an unrepresentable quantity", async () => {
    const read = async (value: MoveFungibleAssetSupplyObservation | null) =>
      measured(await observeDeploymentSupplyCensusNonEvmChain({
        chainId: "aptos", targets: [moveTarget(APTOS_ADDRESS)], scoringClockSec: CLOCK, chainRpcs: new Map(),
      }, { fetchMoveFungibleAssetSupply: async () => value }));
    const key = `aptos:${APTOS_ADDRESS}`;

    const unavailable = await read(null);
    expect(unavailable.rows.size).toBe(0);
    expect(unavailable.rejected.get(key)).toBe("read-unavailable");

    expect((await read({ ...observation, ledgerTimestampSec: undefined })).rejected.get(key))
      .toBe("missing-block-pin");
    expect((await read({ ...observation, ledgerVersion: "" })).rejected.get(key)).toBe("missing-block-pin");
    expect((await read({ ...observation, decimals: 8 })).rejected.get(key)).toBe("route-unreviewed");
    expect((await read({ ...observation, rawSupply: -1n })).rejected.get(key)).toBe("read-unavailable");
  });
});

describe("census pin admission helpers", () => {
  it("bounds pin age at the policy window", () => {
    expect(deploymentSupplyCensusPinAgeIssue(CLOCK, { blockTimeSec: CLOCK })).toBeNull();
    expect(deploymentSupplyCensusPinAgeIssue(CLOCK, { blockTimeSec: CLOCK - SUPPLY.observationMaxAgeSec }))
      .toBeNull();
    expect(deploymentSupplyCensusPinAgeIssue(CLOCK, { blockTimeSec: CLOCK - SUPPLY.observationMaxAgeSec - 1 }))
      .toBe("observation-stale");
    expect(deploymentSupplyCensusPinAgeIssue(CLOCK, { blockTimeSec: CLOCK + 1 })).toBe("future-dated-pin");
  });

  it("bounds cross-chain skew at the policy window", () => {
    const newest = CLOCK - 60;
    expect(deploymentSupplyCensusPinSkewIssue([])).toBeNull();
    expect(deploymentSupplyCensusPinSkewIssue([{ blockTimeSec: newest }])).toBeNull();
    expect(deploymentSupplyCensusPinSkewIssue([
      { blockTimeSec: newest },
      { blockTimeSec: newest - SUPPLY.observationMaxSkewSec },
    ])).toBeNull();
    expect(deploymentSupplyCensusPinSkewIssue([
      { blockTimeSec: newest },
      { blockTimeSec: newest - SUPPLY.observationMaxSkewSec - 1 },
    ])).toBe("cross-chain-skew");
  });
});
