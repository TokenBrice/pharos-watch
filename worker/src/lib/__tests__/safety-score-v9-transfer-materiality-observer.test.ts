import { afterEach, describe, expect, it, vi } from "vitest";
import { observeEconomicSolanaMint } from "../safety-score-v9/economic-supply-observer";
import type { SafetyScoreV9SolanaRpcFetcher } from "../safety-score-v9/supply-observation-primitives";
import type { fetchSafetyScoreV9SolanaRpc } from "../safety-score-v9/supply-observation-primitives";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { CHAIN_META } from "@shared/types/chain-identity";
import { buildChainRpcs, logScanRpcEndpoints } from "../chain-registry";
import { observeSafetyScoreV9TransferMaterialityGeneration, TRANSFER_MATERIALITY_CAPTURE_BUDGET, transferMaterialityObserverResolvesRpc } from "../safety-score-v9/transfer-materiality-observer";
import { exactInputBoundTransferMaterialityPacket, SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS, type SafetyScoreV9TransferMaterialityGeneration } from "../safety-score-v9/transfer-materiality";
import type { MoveFungibleAssetSupplyObservation } from "../../cron/reserve-adapters/token-supply";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9/extension-supply";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { CENSUS_FIXTURE_META_BY_ID } from "./safety-score-v9-transfer-census.test-support";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";
import type * as SupplyAttributionContract from "../safety-score-v9/supply-attribution-contract";

// Hoisted mock factories load fixtures before the static subject imports.

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof StablecoinRegistry>();
  const { CENSUS_FIXTURE_META_BY_ID } = await import("./safety-score-v9-transfer-census.test-support");
  return { ...actual, ACTIVE_META_BY_ID: new Map([...actual.ACTIVE_META_BY_ID, ...CENSUS_FIXTURE_META_BY_ID]) };
});
vi.mock("../safety-score-v9/supply-attribution-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof SupplyAttributionContract>();
  const { CENSUS_FIXTURE_INDEPENDENT_IDS } = await import("./safety-score-v9-transfer-census.test-support");
  return { ...actual, REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE: {
    ...actual.REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE, independentLiabilityAssetIds: [...CENSUS_FIXTURE_INDEPENDENT_IDS],
  } };
});

import { sleepWithSignal } from "../abort";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
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
    fetchEvmBlockNumber: async () => 100,
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
    fetchSafetyScoreV9SolanaRpc: async <T>(_method: string, params: unknown[]): Promise<T | null> => ({
      context: { slot: 100 }, value: (params[0] as string[]).map(() => null),
    }) as T,
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
    // Berachain and Ink Alchemy endpoints were promoted to reviewed full-log registry
    // readers for CCIP history (wave-4 P2); the remaining census readers stay state-only.
    for (const chain of ["hyperevm", "linea", "scroll", "zksync", "abstract", "unichain", "worldchain", "megaeth", "stable"]) {
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

  it("captures all finalized Solana mints before shared anchor reads can advance their context", async () => {
    const methods: string[] = [];
    const fetch: typeof fetchSafetyScoreV9SolanaRpc =
      async <T>(method: string, params: unknown[]): Promise<T | null> => {
        methods.push(method);
        if (method === "getMultipleAccounts") return {
          context: { slot: 100 },
          value: (params[0] as string[]).map(address => ({
            owner: PROGRAM, data: { parsed: { type: "mint", info: {
              decimals: address === ADDRESS ? 6 : 9, supply: "100",
            } } },
          })),
        } as T;
        if (method === "getBlocks") return [99] as T;
        if (method === "getBlock") return { blockTime: CLOCK - 10, blockhash: "1".repeat(32) } as T;
        // No later getAccountInfo can silently substitute a newer snapshot.
        throw new Error(`Unexpected sequential Solana read: ${method}`);
      };
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      ...input(), activeAssetIds: ["usdai-usd-ai", "wsrusd-reservoir"],
    }, { ...censusDependencies(), observeEconomicSolanaMint, fetchSafetyScoreV9SolanaRpc: fetch });
    expect(methods).toEqual(["getMultipleAccounts", "getBlocks", "getBlock"]);
    for (const assetId of ["usdai-usd-ai", "wsrusd-reservoir"]) {
      expect(generation.observationsByAssetId[assetId].find(row => row.deploymentKey.startsWith("solana:")))
        .toMatchObject({ status: "accepted", blockNumber: "100", observedAtSec: CLOCK - 10, rawTokenUnits: "100" });
    }
  });

  it.each(["unavailable", "wrong-count", "future", "decimals", "missing-mint"] as const)(
    "keeps %s batched Solana evidence rejected without a partial partition",
    async fault => {
      const fetch: typeof fetchSafetyScoreV9SolanaRpc =
        async <T>(method: string, params: unknown[]): Promise<T | null> => {
          if (method === "getMultipleAccounts") {
            if (fault === "unavailable") return null;
            return { context: { slot: 100 }, value: fault === "wrong-count" ? [] :
              (params[0] as string[]).map(() => fault === "missing-mint" ? null : {
                owner: PROGRAM, data: { parsed: { type: "mint", info: {
                  decimals: fault === "decimals" ? 18 : 9, supply: "100",
                } } },
              }),
            } as T;
          }
          if (method === "getBlocks") return [99] as T;
          if (method === "getBlock") return {
            blockTime: fault === "future" ? CLOCK + 1 : CLOCK - 10, blockhash: "1".repeat(32),
          } as T;
          return null;
        };
      const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
        ...input(), activeAssetIds: ["wsrusd-reservoir"],
      }, { ...censusDependencies(), observeEconomicSolanaMint, fetchSafetyScoreV9SolanaRpc: fetch });
      expect(generation.observationsByAssetId["wsrusd-reservoir"].find(row => row.deploymentKey.startsWith("solana:"))?.status)
        .toBe("rejected");
      expect(packet("wsrusd-reservoir", generation)).toBeNull();
    },
  );

  it("does not retain an oversized Solana quantity as accepted census evidence", async () => {
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(), {
      ...censusDependencies(),
      observeEconomicSolanaMint: async () => ({
        amount: "1".repeat(79), slot: "100:99", blockHash: "1".repeat(32),
        observedAtSec: CLOCK - 10, responseSha256: "a".repeat(64),
      }),
    });
    expect(generation.observationsByAssetId["wsrusd-reservoir"].find(row => row.deploymentKey.startsWith("solana:")))
      .toMatchObject({ status: "rejected", rawTokenUnits: null });
    expect(packet("wsrusd-reservoir", generation)).toBeNull();
  });

  it.each([
    { decimals: 18 }, { ledgerVersion: "not-a-version" },
    { ledgerTimestampSec: undefined }, { ledgerTimestampSec: CLOCK + 1 },
    { ledgerTimestampSec: CLOCK - 1801 }, { rawSupply: -1n },
    { rawSupply: 10n ** 78n }, { ledgerVersion: "1".repeat(21) },
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

  const stallSec = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.haltedChainMinStallSec;
  async function stalledGeneration(options: { age?: number; secondUnavailable?: boolean; secondHash?: string; secondNumber?: number; secondLive?: boolean } = {}) {
    const dependencies = censusDependencies();
    return observeSafetyScoreV9TransferMaterialityGeneration(input(), {
      ...dependencies,
      fetchEvmBlockNumber: async (_chain, rpcOptions) => {
        const url = rpcOptions?.chainRpcs?.get("polygon-zkevm")?.endpoints[0]?.url;
        return url?.includes("drpc.org") && options.secondUnavailable ? null : 100;
      },
      fetchEvmBlockHeader: async (chain, _number, rpcOptions) => {
        const second = rpcOptions?.chainRpcs?.get("polygon-zkevm")?.endpoints.length === 1 &&
          rpcOptions.chainRpcs.get("polygon-zkevm")?.endpoints[0]?.url.includes("drpc.org");
        return {
          number: second ? options.secondNumber ?? 100 : 100,
          timestamp: chain !== "polygon-zkevm" || second && options.secondLive ? CLOCK - 10 : CLOCK - (options.age ?? stallSec),
          hash: `0x${(second ? options.secondHash ?? "1" : "1").repeat(64)}` as `0x${string}`,
        };
      },
    });
  }

  it("admits agreeing independent final heads at the policy stall boundary as a frozen liability", async () => {
    const generation = await stalledGeneration();
    const admitted = packet("sfrxusd-frax", generation)!;
    expect(admitted.observations).toHaveLength(30);
    expect(admitted.observations.find(row => row.deploymentKey.startsWith("polygon-zkevm:")))
      .toMatchObject({
        rawTokenUnits: "100", observedAtSec: CLOCK - stallSec, status: "accepted",
        provenance: { kind: "halted-chain", checkedAtSec: CLOCK, heads: [
          { endpointOrigin: "https://zkevm-rpc.com", blockNumber: "100", blockHash: `0x${"1".repeat(64)}`, timestampSec: CLOCK - stallSec },
          { endpointOrigin: "https://polygon-zkevm.drpc.org", blockNumber: "100", blockHash: `0x${"1".repeat(64)}`, timestampSec: CLOCK - stallSec },
        ] },
      });
    const meta = ACTIVE_META_BY_ID.get("sfrxusd-frax")!;
    const review = buildSafetyScoreV9SupplyReview({
      clockSec: CLOCK, baseInputGenerationId: BASE_ID, registryFingerprint: FINGERPRINT,
      chainCirculatingById: {}, aggregateCirculatingById: { "sfrxusd-frax": { circulating: { peggedUSD: 1000 } } },
    } as unknown as ReportCardsFixedInput, "sfrxusd-frax", meta.bridgeRouteRisk, { meta, transferMaterialityGeneration: generation })!;
    const frozenRoute = review.selectedBridgeRoutes.find(row => row.deploymentRouteKey.startsWith("polygon-zkevm:"))!;
    expect(frozenRoute.supplyShare).toBeGreaterThan(0);
    expect(frozenRoute.reviewedRouteKind).toBe("controlled");
    const frozenController = CENSUS_FIXTURE_META_BY_ID.get("sfrxusd-frax")!.bridgeRouteRisk!.routes!
      .find(route => route.destinationChain === "polygon-zkevm")!.controllerAddress!;
    expect(review.failureDomains).toContainEqual({ kind: "bridge-route", key: `contract:polygon-zkevm:${frozenController}` });
    expect(packet("wsrusd-reservoir", generation)).not.toBeNull();
  });

  it.each([
    { secondUnavailable: true }, { age: stallSec - 1 }, { secondHash: "2" }, { secondNumber: 101 },
  ])("rejects an incomplete or disagreeing halt proof %j", async options => {
    const generation = await stalledGeneration(options);
    expect(packet("sfrxusd-frax", generation)).toBeNull();
    expect(generation.observationsByAssetId["sfrxusd-frax"].find(row => row.deploymentKey.startsWith("polygon-zkevm:"))?.status).toBe("rejected");
  });

  it("uses a live independent endpoint instead of labelling its liability halted", async () => {
    const generation = await stalledGeneration({ secondLive: true });
    const row = packet("sfrxusd-frax", generation)!.observations.find(row => row.deploymentKey.startsWith("polygon-zkevm:"))!;
    expect(row.observedAtSec).toBe(CLOCK - 10);
    expect(row.provenance).toBeUndefined();
  });

  it("does not refresh a stale head-check or admit forged agreeing-head provenance", async () => {
    const generation = await stalledGeneration();
    const row = generation.observationsByAssetId["sfrxusd-frax"].find(row => row.provenance)!;
    row.provenance!.checkedAtSec = CLOCK - 1801;
    expect(packet("sfrxusd-frax", generation)).toBeNull();
    row.provenance!.checkedAtSec = CLOCK;
    row.provenance!.heads[1].endpointOrigin = row.provenance!.heads[0].endpointOrigin;
    expect(packet("sfrxusd-frax", generation)).toBeNull();
  });

  it("reads Nibiru's exact mainnet liability at the historical pin and retains authentic zero supply", async () => {
    const dependencies = censusDependencies();
    let nibiruPin: number | "latest" | undefined;
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      ...input(), activeAssetIds: ["usbd-bima", "yusd-aegis"],
    }, {
      ...dependencies,
      fetchEvmMulticall3Aggregate3AtBlock: async (chain, calls, blockNumber, options) => {
        if (chain === "nibiru") {
          nibiruPin = blockNumber;
          expect(CHAIN_META.nibiru!.evmChainId).toBe(6900);
          expect(options?.chainRpcs?.get("nibiru")?.endpoints[0]?.url).toBe("https://evm-rpc.nibiru.fi");
          return calls.map(call => ({
            label: call.label, success: true,
            returnData: `0x${(call.label.endsWith(":decimals") ? 18n : 0n).toString(16).padStart(64, "0")}` as `0x${string}`,
          }));
        }
        return dependencies.fetchEvmMulticall3Aggregate3AtBlock(chain, calls);
      },
    });
    expect(nibiruPin).toBe(100);
    expect(packet("usbd-bima", generation)?.observations).toHaveLength(6);
    expect(packet("yusd-aegis", generation)?.observations).toHaveLength(4);
    expect(generation.observationsByAssetId["usbd-bima"]?.find(row => row.deploymentKey.startsWith("nibiru:")))
      .toMatchObject({ rawTokenUnits: "0", decimals: 18, blockNumber: "100", observedAtSec: CLOCK - 10, status: "accepted" });
  });

  it("rejects the entire omitted-chain census when Nibiru cannot read while unrelated YUSD remains complete", async () => {
    const dependencies = censusDependencies();
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      ...input(), activeAssetIds: ["usbd-bima", "yusd-aegis"],
    }, {
      ...dependencies,
      fetchEvmMulticall3Aggregate3AtBlock: async (chain, calls) =>
        chain === "nibiru" ? null : dependencies.fetchEvmMulticall3Aggregate3AtBlock(chain, calls),
    });
    expect(packet("usbd-bima", generation)).toBeNull();
    expect(packet("yusd-aegis", generation)?.observations).toHaveLength(4);
    expect(generation.observationsByAssetId["usbd-bima"]?.find(row => row.deploymentKey.startsWith("nibiru:")))
      .toMatchObject({ status: "rejected", rawTokenUnits: null });
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
      fetchEvmMulticall3Aggregate3AtBlock: async (_chain, calls, block, options) => {
        expect(block).toBe(100);
        expect(options?.stateBlockHash).toBe(`0x${"1".repeat(64)}`);
        expect(options?.multicallFallbackBlockHash).toBeUndefined();
        return calls.map(call => ({
          label: call.label, success: true,
          returnData: `0x${(call.label.endsWith(":decimals") ? 6n : 100n).toString(16).padStart(64, "0")}` as `0x${string}`,
        }));
      },
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

  it.each([false, true])("keeps the canonical hash on fallback and rejects unavailable pinned state (unavailable=%s)", async unavailable => {
    const clock = 1791184659;
    const hash = `0x${"1".repeat(64)}` as `0x${string}`;
    let attempts = 0;
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      activeAssetIds: ["usdc-circle"], baseInputGenerationId: BASE_ID,
      registryFingerprint: FINGERPRINT, scoringClockSec: clock, chainRpcs: new Map(),
    }, {
      ...censusDependencies(),
      fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash }),
      fetchEvmMulticall3Aggregate3AtBlock: async (_chain, calls, block, options) => {
        attempts += 1;
        expect(block).toBe(100);
        expect(options?.stateBlockHash).toBe(hash);
        expect(options?.multicallFallbackBlockHash).toBe(attempts === 1 ? undefined : hash);
        if (attempts === 1 || unavailable) return null;
        return calls.map(call => ({
          label: call.label, success: true,
          returnData: `0x${(call.label.endsWith(":decimals") ? 6n : 100n).toString(16).padStart(64, "0")}` as `0x${string}`,
        }));
      },
    });
    expect(attempts).toBe(2);
    expect(generation.observationsByAssetId["usdc-circle"]).toHaveLength(2);
    expect(generation.observationsByAssetId["usdc-circle"]?.every(row => row.status === (unavailable ? "rejected" : "accepted"))).toBe(true);
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

describe("transfer census admission and execution budgets", () => {
  const assets = ["aa-falconx-mev-capital", "asusdf-astherus", "bbqusdc-steakhouse", "bd-basedollar", "dusd-dialectic", "eearn-ember"];
  const chains = ["ethereum", "bsc", "base", "arbitrum", "optimism", "polygon"];
  const budget = TRANSFER_MATERIALITY_CAPTURE_BUDGET;
  const input = (ids = assets, clock = CLOCK) => ({
    activeAssetIds: ids, baseInputGenerationId: BASE_ID, registryFingerprint: FINGERPRINT,
    scoringClockSec: clock, chainRpcs: buildChainRpcs("test-alchemy"),
  });
  function inventory(count: number, distinctChains = false) {
    const original = ACTIVE_META_BY_ID.get.bind(ACTIVE_META_BY_ID);
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => {
      const meta = original(id);
      const assetIndex = assets.indexOf(id);
      if (!meta || assetIndex < 0) return meta;
      return { ...meta, contracts: Array.from({ length: count }, (_, index) => ({
        chain: distinctChains ? chains[assetIndex]! : "ethereum",
        address: `0x${(assetIndex * 100 + index + 1).toString(16).padStart(40, "0")}`, decimals: 18,
      })) };
    });
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rotates whole-asset admission fairly, preserving every deferred leg as unknown", async () => {
    inventory(64, true);
    const ids = assets.slice(0, 5);
    const firstBucket = Math.floor(CLOCK / SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC);
    const deferred = new Set<string>();
    for (let step = 0; step < ids.length; step++) {
      const clock = (firstBucket + step) * SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC;
      const dependencies = censusDependencies();
      const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(ids, clock), {
        ...dependencies,
        fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
        fetchEvmMulticall3Aggregate3AtBlock: async (chain, calls, block, options) => {
          expect(calls).toHaveLength(128); // Four complete 64-deployment assets, each on its own chain.
          expect(options).toMatchObject({ multicallBatchSize: 64, maxResponseBytes: 131072, maxRetries: 0 });
          return dependencies.fetchEvmMulticall3Aggregate3AtBlock(chain, calls);
        },
      });
      expect(Object.keys(generation.observationsByAssetId)).toEqual(ids);
      const skipped = ids.filter(id => generation.observationsByAssetId[id].every(row => row.status === "rejected"));
      expect(skipped).toHaveLength(1);
      deferred.add(skipped[0]!);
      expect(skipped[0]).toBe(ids[(firstBucket + step + 4) % ids.length]);
      expect(generation.observationsByAssetId[skipped[0]!]).toHaveLength(64);
      expect(generation.observationsByAssetId[skipped[0]!].every(row => row.rawTokenUnits === null && row.decimals === null)).toBe(true);
      expect(exactInputBoundTransferMaterialityPacket({
        assetId: skipped[0]!, meta: ACTIVE_META_BY_ID.get(skipped[0]!)!, generation,
        registryFingerprint: FINGERPRINT, baseInputGenerationId: BASE_ID, clockSec: clock,
      })).toBeNull();
      const retry = await observeSafetyScoreV9TransferMaterialityGeneration(input(ids, clock), {
        ...dependencies,
        fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
      });
      expect(retry.generationId).toBe(generation.generationId);
    }
    expect(deferred.size).toBe(ids.length);
  });

  it("fairly rotates a crowded shared chain without enlarging its fallback batch", async () => {
    inventory(64);
    const ids = assets.slice(0, 5);
    const observedFirst = new Set<string>();
    const firstBucket = Math.floor(CLOCK / SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC);
    for (let step = 0; step < ids.length; step++) {
      const clock = (firstBucket + step) * SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC;
      const dependencies = censusDependencies();
      const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input(ids, clock), {
        ...dependencies,
        fetchEvmBlockHeader: async () => ({ number: 100, timestamp: clock - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
        fetchEvmMulticall3Aggregate3AtBlock: async (chain, calls) => {
          expect(calls).toHaveLength(128);
          return dependencies.fetchEvmMulticall3Aggregate3AtBlock(chain, calls);
        },
      });
      const accepted = ids.filter(id => generation.observationsByAssetId[id].every(row => row.status === "accepted"));
      expect(accepted).toEqual([ids[(firstBucket + step) % ids.length]]);
      observedFirst.add(accepted[0]!);
      const unknown = ids.filter(id => !accepted.includes(id));
      expect(unknown.every(id => generation.observationsByAssetId[id].length === 64 &&
        generation.observationsByAssetId[id].every(row => row.rawTokenUnits === null))).toBe(true);
    }
    expect(observedFirst.size).toBe(ids.length);
  });

  it("rejects an oversized whole inventory without any contract probes or a partial packet", async () => {
    inventory(65);
    const resolve = vi.fn(async () => 100);
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input([assets[0]!]), {
      ...censusDependencies(), resolveClosestBlockAtOrBeforeTimestamp: resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(generation.observationsByAssetId[assets[0]!]).toEqual([]);
  });

  it("reserves publication time and stops at the inherited deadline without opening another chain batch", async () => {
    vi.useFakeTimers();
    inventory(1, true);
    let active = 0;
    let peak = 0;
    const signals: AbortSignal[] = [];
    const resolve = vi.fn(async (_chain, _clock, _cache, options) => {
      signals.push(options!.signal!);
      peak = Math.max(peak, ++active);
      try { await sleepWithSignal(1000, options!.signal); return 100; }
      finally { active--; }
    });
    const operation = observeSafetyScoreV9TransferMaterialityGeneration({
      ...input(), deadlineMs: Date.now() + budget.publicationReserveMs + 20,
    }, { ...censusDependencies(), resolveClosestBlockAtOrBeforeTimestamp: resolve });
    await vi.advanceTimersByTimeAsync(20);
    const generation = await operation;
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(Object.values(generation.observationsByAssetId).flat().every(row =>
      row.status === "rejected" && row.rawTokenUnits === null && row.observedAtSec === null)).toBe(true);
  });

  it("settles a timed-out chain before the next batch and still observes healthy peers", async () => {
    vi.useFakeTimers();
    inventory(1, true);
    let active = 0;
    let peak = 0;
    const resolve = vi.fn(async (chain, _clock, _cache, options) => {
      peak = Math.max(peak, ++active);
      try { await sleepWithSignal(chain === "ethereum" ? budget.chainTimeoutMs + 100 : 1, options!.signal); return 100; }
      finally { active--; }
    });
    const operation = observeSafetyScoreV9TransferMaterialityGeneration(input(), {
      ...censusDependencies(), resolveClosestBlockAtOrBeforeTimestamp: resolve,
    });
    await vi.advanceTimersByTimeAsync(budget.chainTimeoutMs + 10);
    const generation = await operation;
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(6);
    expect(generation.observationsByAssetId[assets[0]!][0].status).toBe("rejected");
    expect(assets.slice(1).every(id => generation.observationsByAssetId[id][0].status === "accepted")).toBe(true);
  });

  it("does not admit a late completion even when the dependency ignores cancellation", async () => {
    vi.useFakeTimers();
    inventory(1);
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration({
      ...input([assets[0]!]), deadlineMs: Date.now() + budget.publicationReserveMs + 20,
    }, {
      ...censusDependencies(),
      resolveClosestBlockAtOrBeforeTimestamp: async () => { vi.setSystemTime(Date.now() + 21); return 100; },
    });
    expect(generation.observationsByAssetId[assets[0]!][0]).toMatchObject({ status: "rejected", rawTokenUnits: null });
  });

  it("enforces a trigger-local request ceiling with no hidden retries", async () => {
    inventory(1);
    let admittedRequests = 0;
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input([assets[0]!]), {
      ...censusDependencies(),
      resolveClosestBlockAtOrBeforeTimestamp: async (_chain, _clock, _cache, options) => {
        expect(options?.maxRetries).toBe(0);
        while (options!.beforeRequest!("https://rpc.example")) admittedRequests++;
        return null;
      },
    });
    expect(admittedRequests).toBe(budget.maxEvmRequests);
    expect(generation.observationsByAssetId[assets[0]!][0].rawTokenUnits).toBeNull();
  });

  it("publishes every current candidate's outcome within the bounded census shape", async () => {
    const generation = await observeSafetyScoreV9TransferMaterialityGeneration(input([...SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS]), censusDependencies());
    expect(Object.keys(generation.observationsByAssetId)).toEqual(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS);
    expect(Object.values(generation.observationsByAssetId).every(rows => rows.length <= budget.maxDeploymentsPerAsset)).toBe(true);
    expect(Object.values(generation.observationsByAssetId).flat().filter(row => row.status === "accepted").length)
      .toBeLessThanOrEqual(budget.maxDeploymentsPerRun);
  });

  it("clips its own wall window at 180 seconds, regardless of a later slot deadline", async () => {
    vi.useFakeTimers();
    const meta = ACTIVE_META_BY_ID.get(assets[0]!)!;
    const chainIds = Object.keys(CHAIN_META).filter(chain => CHAIN_META[chain]?.type === "evm").slice(0, 40);
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue({
      ...meta, contracts: chainIds.map((chain, index) => ({
        chain, address: `0x${(index + 1).toString(16).padStart(40, "0")}`, decimals: 18,
      })),
    });
    const chainRpcs = new Map(chainIds.map(chain => [chain, {
      chainId: chain, chainName: chain, type: "evm" as const, explorerUrl: "https://explorer.example",
      endpoints: [{ url: "https://rpc.example", operator: "public" as const, keyed: false,
        position: "registry" as const, stateHistory: "archive" as const, logsHistory: "none" as const }],
    }]));
    const resolve = vi.fn(async (_chain, _clock, _cache, options) => {
      await sleepWithSignal(budget.chainTimeoutMs + 100, options!.signal);
      return 100;
    });
    const operation = observeSafetyScoreV9TransferMaterialityGeneration({
      ...input([assets[0]!]), chainRpcs, deadlineMs: Date.now() + 600_000,
    }, { ...censusDependencies(), resolveClosestBlockAtOrBeforeTimestamp: resolve });
    await vi.advanceTimersByTimeAsync(budget.wallTimeoutMs);
    const generation = await operation;
    expect(resolve).toHaveBeenCalledTimes(36); // 12 settled batches of three at 15 seconds.
    expect(generation.observationsByAssetId[assets[0]!]).toHaveLength(40);
    expect(generation.observationsByAssetId[assets[0]!].every(row => row.rawTokenUnits === null)).toBe(true);
  });
});
