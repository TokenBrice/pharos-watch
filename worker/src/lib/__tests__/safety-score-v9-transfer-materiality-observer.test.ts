import { describe, expect, it, vi } from "vitest";
import { observeEconomicSolanaMint } from "../safety-score-v9/economic-supply-observer";
import type { SafetyScoreV9SolanaRpcFetcher } from "../safety-score-v9/supply-observation-primitives";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildChainRpcs, logScanRpcEndpoints } from "../chain-registry";
import { observeSafetyScoreV9TransferMaterialityGeneration, transferMaterialityObserverResolvesRpc } from "../safety-score-v9/transfer-materiality-observer";
import { exactInputBoundTransferMaterialityPacket, type SafetyScoreV9TransferMaterialityGeneration } from "../safety-score-v9/transfer-materiality";
import type { MoveFungibleAssetSupplyObservation } from "../../cron/reserve-adapters/token-supply";

const ADDRESS = "USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A";
const PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const CLOCK = 1790850000;
function rpcFixture(options: { decimals?: number; owner?: string; slot?: number; observedAtSec?: number; hash?: string; missingAccount?: boolean; missingAnchor?: boolean } = {}): SafetyScoreV9SolanaRpcFetcher {
  return async <T>(method: string, params: unknown[]): Promise<T | null> => {
    if (method === "getAccountInfo") {
      expect(params).toEqual([ADDRESS, { commitment: "finalized", encoding: "jsonParsed" }]);
      return { context: { slot: options.slot ?? 100 }, value: options.missingAccount ? null : {
        owner: options.owner ?? PROGRAM, rentEpoch: 18446744073709552000,
        data: { parsed: { type: "mint", info: { decimals: options.decimals ?? 6, supply: "590514634" } } },
      } } as T;
    }
    if (method === "getBlocks") return (options.missingAnchor ? [] : [99]) as T;
    if (method === "getBlock") return { blockTime: options.observedAtSec ?? CLOCK - 30, blockhash: options.hash ?? "1".repeat(32) } as T;
    return null;
  };
}
describe("finalized economic Solana mint observations", () => {
  it("retains exact Token-2022 amount and case-preserved mint identity despite incidental u64 metadata", async () => {
    const result = await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture());
    expect(result).toMatchObject({ amount: "590514634", slot: "100:99", blockHash: "1".repeat(32), observedAtSec: CLOCK - 30 });
    expect(result!.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { decimals: 18 }, { owner: "incorrect-program" }, { slot: -1 }, { observedAtSec: CLOCK + 1 },
    { observedAtSec: CLOCK - 1801 }, { hash: "not-a-hash" }, { missingAccount: true }, { missingAnchor: true },
  ])("rejects invalid or unavailable source observations %j", async options => {
    expect(await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture(options))).toBeNull();
  });
  it("admits the exact 1800-second boundary without refreshing the original ledger clock", async () => {
    const result = await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture({ observedAtSec: CLOCK - 1800 }));
    expect(result!.observedAtSec).toBe(CLOCK - 1800);
  });
});

const CENSUS_ASSETS = ["sfrxusd-frax", "wsrusd-reservoir"];
const BASE_ID = `report-cards-input:v1:${"a".repeat(64)}`;
const FINGERPRINT = "b".repeat(64);

function censusDependencies(moveOverride: Partial<MoveFungibleAssetSupplyObservation> = {}) {
  return {
    resolveClosestBlockAtOrBeforeTimestamp: async () => 100,
    fetchEvmBlockHeader: async () => ({ number: 100, timestamp: CLOCK - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
    fetchEvmMulticall3Aggregate3AtBlock: async (_chain: string | undefined, calls: readonly { label: string }[]) =>
      calls.map(call => ({
        label: call.label, success: true,
        returnData: `0x${(call.label.endsWith(":decimals") ? call.label.startsWith("tempo:") ? 6n : 18n : 100n).toString(16).padStart(64, "0")}` as `0x${string}`,
      })),
    observeEconomicSolanaMint: async () => ({
      amount: "100", slot: "100:99", blockHash: "1".repeat(32),
      observedAtSec: CLOCK - 10, responseSha256: "a".repeat(64),
    }),
    fetchMoveFungibleAssetSupply: async () => ({
      rawSupply: 0n, decimals: 6, ledgerVersion: "123456789",
      ledgerTimestampSec: CLOCK - 10, ...moveOverride,
    }),
  };
}

describe("complete independent-liability censuses", () => {
  const input = () => ({
    activeAssetIds: CENSUS_ASSETS, baseInputGenerationId: BASE_ID,
    registryFingerprint: FINGERPRINT, scoringClockSec: CLOCK,
    chainRpcs: buildChainRpcs("test-alchemy", undefined, { dwellirApiKey: "test-dwellir" }),
  });
  const packet = (assetId: string, generation: SafetyScoreV9TransferMaterialityGeneration) =>
    exactInputBoundTransferMaterialityPacket({
      assetId, meta: ACTIVE_META_BY_ID.get(assetId)!, generation,
      registryFingerprint: FINGERPRINT, baseInputGenerationId: BASE_ID, clockSec: CLOCK,
    });

  it("uses archive supplemental-only RPCs without inventing registry capability", () => {
    const configured = buildChainRpcs(undefined, undefined, { dwellirApiKey: "test-dwellir" });
    for (const chain of ["hyperevm", "linea", "ink", "stable", "unichain", "worldchain", "scroll", "megaeth", "xdc"]) {
      expect(transferMaterialityObserverResolvesRpc(chain, configured), chain).toBe(true);
    }
    expect(transferMaterialityObserverResolvesRpc("berachain", configured)).toBe(true);
    const stable = configured.get("stable")!;
    const recentOnly = new Map(configured).set("stable", {
      ...stable, endpoints: stable.endpoints.map(endpoint => ({ ...endpoint, stateHistory: "recent" as const })),
    });
    expect(transferMaterialityObserverResolvesRpc("stable", recentOnly)).toBe(false);
  });

  it("keeps new Alchemy census readers state-only and outside log-scan inventories", () => {
    const configured = input().chainRpcs;
    for (const chain of ["berachain", "hyperevm", "ink", "linea", "scroll", "zksync", "abstract", "unichain", "worldchain", "megaeth", "stable"]) {
      expect(configured.get(chain)?.endpoints.find(endpoint => endpoint.operator === "alchemy"), chain)
        .toMatchObject({ position: "supplemental", stateHistory: "archive", logsHistory: "none" });
      expect(logScanRpcEndpoints(configured.get(chain)), chain).toEqual([]);
    }
  });

  it("admits all 30 sfrxUSD and 21 wsrUSD exact rows, including authentic Move zero supply", async () => {
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(), censusDependencies());
    expect(packet("sfrxusd-frax", generation)?.observations).toHaveLength(30);
    expect(packet("wsrusd-reservoir", generation)?.observations).toHaveLength(21);
    expect(generation.observationsByAssetId["sfrxusd-frax"]?.find(row => row.deploymentKey.startsWith("aptos:")))
      .toMatchObject({ rawTokenUnits: "0", decimals: 6, blockNumber: "123456789", observedAtSec: CLOCK - 10, status: "accepted" });
  });

  it.each([
    { decimals: 18 }, { ledgerVersion: "not-a-version" },
    { ledgerTimestampSec: undefined }, { ledgerTimestampSec: CLOCK + 1 },
    { ledgerTimestampSec: CLOCK - 1801 }, { rawSupply: -1n },
  ])("rejects the whole sfrxUSD packet for invalid Move evidence %#", async override => {
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(), censusDependencies(override));
    expect(packet("sfrxusd-frax", generation)).toBeNull();
    expect(packet("wsrusd-reservoir", generation)).not.toBeNull();
    expect(generation.observationsByAssetId["sfrxusd-frax"]?.filter(row => row.deploymentKey.startsWith("aptos:") || row.deploymentKey.startsWith("movement:")))
      .toHaveLength(2);
  });

  it("keeps a stale EVM leg rejected instead of admitting a partial census", async () => {
    const dependencies = censusDependencies();
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(), {
      ...dependencies,
      fetchEvmBlockHeader: async (chain) => ({
        number: 100, timestamp: chain === "polygon-zkevm" ? CLOCK - 1801 : CLOCK - 10,
        hash: `0x${"1".repeat(64)}` as `0x${string}`,
      }),
    });
    expect(packet("sfrxusd-frax", generation)).toBeNull();
    expect(packet("wsrusd-reservoir", generation)).not.toBeNull();
  });
});

describe("bounded same-chain provider census", () => {
  it("reads both XLayer contracts at one pin without probing the other 86 USDC contracts", async () => {
    const clock = 1791184659;
    const chains: string[] = [];
    const dependencies = censusDependencies();
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      activeAssetIds: ["usdc-circle"], baseInputGenerationId: BASE_ID,
      registryFingerprint: FINGERPRINT, scoringClockSec: clock, chainRpcs: new Map(),
    }, {
      ...dependencies,
      resolveClosestBlockAtOrBeforeTimestamp: async chain => { chains.push(chain!); return 100; },
      fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
      fetchEvmMulticall3Aggregate3AtBlock: async (_chain, calls) => calls.map(call => ({
        label: call.label, success: true,
        returnData: `0x${(call.label.endsWith(":decimals") ? 6n : 100n).toString(16).padStart(64, "0")}` as `0x${string}`,
      })),
    });
    expect(chains).toEqual(["xlayer"]);
    expect(generation.observationsByAssetId["usdc-circle"]).toHaveLength(2);
    for (const row of generation.observationsByAssetId["usdc-circle"]!) {
      expect(row).toMatchObject({
        status: "accepted", rawTokenUnits: "100", decimals: 6,
        blockNumber: "100", blockHash: `0x${"1".repeat(64)}`, observedAtSec: clock - 10,
      });
    }
    expect(exactInputBoundTransferMaterialityPacket({
      assetId: "usdc-circle", meta: ACTIVE_META_BY_ID.get("usdc-circle")!, generation,
      registryFingerprint: FINGERPRINT, baseInputGenerationId: BASE_ID, clockSec: clock,
    })).toBeNull();
  });

  it("retains a failed contract as rejected instead of shrinking the reviewed two-contract roster", async () => {
    const clock = 1791184659;
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      activeAssetIds: ["usdc-circle"], baseInputGenerationId: BASE_ID,
      registryFingerprint: FINGERPRINT, scoringClockSec: clock, chainRpcs: new Map(),
    }, {
      ...censusDependencies(),
      fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
      fetchEvmMulticall3Aggregate3AtBlock: async (_chain, calls) => calls.map(call => ({
        label: call.label, success: !call.label.includes("b6ceceab"),
        returnData: `0x${(call.label.endsWith(":decimals") ? 6n : 100n).toString(16).padStart(64, "0")}` as `0x${string}`,
      })),
    });
    expect(generation.observationsByAssetId["usdc-circle"]).toHaveLength(2);
    expect(generation.observationsByAssetId["usdc-circle"]?.map(row => row.status)).toEqual(["accepted", "rejected"]);
  });

  it("rejects catalog expansion before issuing any additional contract probes", async () => {
    const meta = structuredClone(ACTIVE_META_BY_ID.get("usdc-circle")!);
    meta.contracts!.push({ chain: "xlayer", address: `0x${"f".repeat(40)}`, decimals: 6 });
    const lookup = vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue(meta);
    const resolve = vi.fn(async () => 100);
    try {
      const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
        activeAssetIds: ["usdc-circle"], baseInputGenerationId: BASE_ID,
        registryFingerprint: FINGERPRINT, scoringClockSec: 1791184659, chainRpcs: new Map(),
      }, { ...censusDependencies(), resolveClosestBlockAtOrBeforeTimestamp: resolve });
      expect(resolve).not.toHaveBeenCalled();
      expect(generation.observationsByAssetId["usdc-circle"]).toHaveLength(2);
      expect(generation.observationsByAssetId["usdc-circle"]?.every(row => row.status === "rejected")).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  });
});
