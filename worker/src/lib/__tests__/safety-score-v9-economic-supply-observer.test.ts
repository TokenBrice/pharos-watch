import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sha256Hex } from "@shared/lib/sha256";
import type { StablecoinMeta } from "@shared/types/core";
import { ReviewedEconomicSupplyPlanSchema, type CcipPendingRead, type CurveLzPendingRead, type LayerZeroOftPendingRead, type ReviewedEconomicSupplyPlan } from "@shared/types/safety-score-v9-supply-attribution";
import * as evmRpc from "../evm-rpc";
import type { ChainRpcConfig } from "../chain-registry";
import { ECONOMIC_SUPPLY_BODY_CAPS, observeCurveLzPending, observeEconomicSolanaMint, observeReviewedEconomicDeploymentPartitionAttempt } from "../safety-score-v9/economic-supply-observer";
import { readEconomicXrplHolding } from "../safety-score-v9/economic-supply-observer-readers";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, reviewedEconomicDeploymentAttributionValidationError } from "../safety-score-v9/supply-attribution-contract";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { admissionCodeForSupplyAttributionRejection, computeSupplyAttributionJournalIdV1, createSupplyAttributionJournalV1, SupplyAttributionJournalV1Schema, withSupplyAttributionJournalDiagnosticV1, type SupplyAttributionJournalV1Payload } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { emitSupplyAttributionDiagnostic } from "../safety-score-v9/supply-attribution-diagnostics";
import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createDwellirNativeCapability } from "../dwellir-native";
import { DWELLIR_NATIVE_ENDPOINTS } from "@shared/lib/dwellir-native-endpoints";

import { expectRecentPinRouting } from "../../test-helpers/recent-pin-routing";
const CLOCK = 1790850000;
const HASH: `0x${string}` = `0x${"a".repeat(64)}`;
const BASE_FINALITY_MARGIN_SEC = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.finalityMarginSecByChainId.base!;
const MEGAETH_FINALITY_MARGIN_SEC = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.finalityMarginSecByChainId.megaeth!;
const OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "So11111111111111111111111111111111111111112";
const apiSource = (sourceId: string) => ({ sourceId, url: `https://issuer.example/${sourceId}`, amountPath: ["data", "amount"], observedAtPath: ["data", "observedAt"], generationPath: ["data", "generation"] });
const apiBody = (amount: unknown = "1", observedAt: unknown = CLOCK - 60) => ({ data: { amount, observedAt, generation: "issuer-snapshot" } });
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const account = (supply = "100000000") => ({ context: { slot: 100 }, value: { owner: OWNER, data: { parsed: { type: "mint", info: { supply, decimals: 6 } } } } });
const diagnosticFixture = (detail: Partial<SupplyAttributionAttemptDiagnostic>): SupplyAttributionAttemptDiagnostic => ({
  observer: "economic-deployment", sourceId: "alpha", laneId: null, chainId: null, providerOrigin: null,
  method: "partition-attempt", phase: "observation-rejected", beforeCursor: null, afterCursor: null,
  targetCursor: null, pinObservedAtSec: null, finalizedLagBlocks: null, persisted: false,
  authenticatedCursorAdvanced: false, incompleteBootstrap: false, hardEvidenceFailure: true,
  failurePredicate: "deployment-state-unavailable", ...detail,
});

function fixture() {
  const address = `0x${"1".repeat(40)}`;
  const plan: ReviewedEconomicSupplyPlan = {
    assetId: "alpha", reviewer: "reviewer", reviewedAtSec: CLOCK - 86400, expiresAtSec: CLOCK + 86400,
    evidenceUrls: ["https://issuer.example/accounting"], economicScope: "All circulating holder claims",
    sourceId: "reference", accountingFamily: "independent-liability", commonClaimUnit: "claim", exhaustive: true, inFlightTreatment: "observed-reconciled",
    deployments: [{ deploymentKey: `ethereum:${address}`, chainId: "ethereum", address, holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: null, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null }],
    excludedRegistryDeploymentKeys: [], exclusions: [], escrows: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
  };
  const fixedInput = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
  Object.assign(fixedInput, {
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "d".repeat(64),
    aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } },
    chainCirculatingById: {}, navPriceById: { alpha: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } },
  });
  vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockImplementation(id => id === "alpha" ? plan : undefined);
  vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => id === "alpha" ? {
    contracts: plan.deployments.filter(row => row.holdingKind !== "native-gas").map(row => ({ chain: row.chainId, address: row.address!, decimals: row.decimals })),
  } as StablecoinMeta : undefined);
  const chainRpcs = new Map<string, ChainRpcConfig>();
  return { plan, fixedInput, assetId: "alpha", chainRpcs, scoringClockSec: CLOCK, run(signal?: AbortSignal, scoringClockSec = CLOCK) { return observeReviewedEconomicDeploymentPartitionAttempt({ assetId: "alpha", fixedInput, chainRpcs, signal, scoringClockSec }); } };
}

beforeEach(() => {
  vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockResolvedValue(102);
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - 60, hash: HASH }));
  vi.spyOn(evmRpc, "fetchEvmMulticall3Aggregate3AtBlock").mockImplementation(async (_chain, calls) => calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n : 100000000n) })));
  vi.spyOn(evmRpc, "fetchEvmRpcBatch").mockResolvedValue(["0xde0b6b3a7640000"]);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reviewed economic supply observation", () => {
  it("journals typed body rejection and bounded exact leaf provenance without changing old IDs", () => {
    const payload: SupplyAttributionJournalV1Payload = { schemaVersion: 1, lane: "supply-attribution", assetId: "alpha", attemptId: "attempt", sourceId: "reviewed.economic-deployment-partition.v1", sourceOriginClass: "issuer-disclosure-plus-onchain", baseInputGenerationId: "input", sourceGeneration: "source", registryFingerprint: "a".repeat(64), routeInventoryDigest: null, attemptCode: "supply-attribution.collector.attempted", admissionCode: admissionCodeForSupplyAttributionRejection("observer-body-over-cap"), fallbackCode: "supply-attribution.fallback.aggregate-only", rejectionCode: "observer-body-over-cap", attemptedAtSec: CLOCK, completedAtSec: CLOCK, scoringClockSec: CLOCK, sourceObservedAtSec: null, failedRouteId: "route", contentSha256: null };
    let diagnostic: SupplyAttributionAttemptDiagnostic | undefined;
    emitSupplyAttributionDiagnostic(value => { diagnostic = value; }, { observer: "economic-deployment", sourceId: "reference", hardEvidenceFailure: true, failurePredicate: "observer-body-over-cap", operands: { maxBytes: 262144, observedBytes: 262145 } });
    const original = createSupplyAttributionJournalV1(payload), enriched = withSupplyAttributionJournalDiagnosticV1(payload, diagnostic);
    expect(enriched.diagnosticLeaf).toEqual({ predicate: "observer-body-over-cap", evidenceSha256: sha256Hex(stableJsonStringifyV1(diagnostic)) });
    expect(SupplyAttributionJournalV1Schema.safeParse(createSupplyAttributionJournalV1(enriched)).success).toBe(true);
    expect(createSupplyAttributionJournalV1(withSupplyAttributionJournalDiagnosticV1(payload, undefined)).journalId).toBe(original.journalId);
    let saturated = payload;
    for (const field of ["attemptId", "baseInputGenerationId", "sourceGeneration", "failedRouteId"] as const) {
      for (let length = 1; length <= 192; length++) {
        const candidate = { ...saturated, [field]: "x".repeat(length) };
        if (SupplyAttributionJournalV1Schema.safeParse({ ...candidate, journalId: computeSupplyAttributionJournalIdV1(candidate) }).success) saturated = candidate;
      }
    }
    expect(withSupplyAttributionJournalDiagnosticV1(saturated, diagnostic)).toBe(saturated);
    expect(new TextEncoder().encode(JSON.stringify(createSupplyAttributionJournalV1(withSupplyAttributionJournalDiagnosticV1(saturated, diagnostic)))).byteLength).toBeLessThanOrEqual(1152);
  });
  it("admits a pinned EVM supply with its rechecked block identity and conserved allocation", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.observations).toEqual([expect.objectContaining({ deploymentKey: f.plan.deployments[0]!.deploymentKey, amount: "100000000", anchor: "100", anchorHash: HASH, observedAtSec: CLOCK - 60 })]);
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBe(100);
    expect(result.attribution.unattributedSupplyUsd).toBe(0);
    // Reviewed safety lag is not an authenticated finalized head.
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3]?.recentStatePin).toBeUndefined();
  });

  it("replaces the reviewed heuristic with authenticated finalized state, never a latest substitution", async () => {
    const f = fixture();
    f.plan.deployments[0]!.read = { kind: "evm-total-supply", safeBlockLag: 15059, pinPolicy: "finalized-preferred" };
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(20000);
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => {
      const height = number === "finalized" ? 19000 : number;
      return { number: height, hash: HASH, timestamp: height === 4941 ? CLOCK - 1847 : CLOCK - 900 };
    });
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      baseInputGenerationId: f.fixedInput.baseInputGenerationId,
      aggregate: { observedAtSec: CLOCK - 60 },
      observations: [expect.objectContaining({ anchor: "19000", observedAtSec: CLOCK - 900 })],
    } });
    expect(evmRpc.fetchEvmBlockHeader).not.toHaveBeenCalledWith("ethereum", 4941, expect.anything());
  });
  it("retains the reviewed lag fallback when finalized proof is unavailable", async () => {
    const f = fixture();
    f.plan.deployments[0]!.read = { kind: "evm-total-supply", safeBlockLag: 2, pinPolicy: "finalized-preferred" };
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      number === "finalized" ? null : { number, timestamp: CLOCK - 60, hash: HASH });
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      observations: [expect.objectContaining({ anchor: "100" })],
    } });
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3]?.recentStatePin).toBeUndefined();
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      expect.objectContaining({ chainRpcs: f.chainRpcs, signal: undefined, minTimestampSec: expect.any(Number) }));
  });
  it("falls back to the reviewed lag when optional finalized proof is stale", async () => {
    const f = fixture();
    f.plan.deployments[0]!.read = { kind: "evm-total-supply", safeBlockLag: 2, pinPolicy: "finalized-preferred" };
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 90 : number,
      timestamp: number === "finalized" || number === 90 ? CLOCK - 3600 : CLOCK - 60,
      hash: HASH,
    }));
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      observations: [expect.objectContaining({ anchor: "100", observedAtSec: CLOCK - 60 })],
    } });
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      expect.objectContaining({ minTimestampSec: expect.any(Number) }));
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3]?.recentStatePin).toBeUndefined();
  });
  it.each([1847, 1790])("rejects %is-old pins without enough capture headroom before reading quantities", async age => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - age, hash: HASH }));
    const result = await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, assetDeadlineMs: Date.now() + 30_000 });
    expect(result).toMatchObject({ status: "rejected" });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
  it("ages original observations through final derivation instead of renewing their clocks", async () => {
    const f = fixture();
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => CLOCK * 1000 + elapsed);
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - 1790, hash: HASH }));
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) => {
      elapsed = 20_000;
      return calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n : 100000000n) }));
    });
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-observation-skew" });
  });
  it("batches same-chain supplies and balance exclusions at one pin without mixing amounts", async () => {
    const f = fixture();
    const first = f.plan.deployments[0]!;
    const second = { ...first, deploymentKey: `ethereum:0x${"2".repeat(40)}`, address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(second);
    f.plan.exclusions = [{ id: "treasury", deploymentKey: second.deploymentKey, account: `0x${"3".repeat(40)}` }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(
        call.label.endsWith(":decimals") ? 6n : call.label === first.deploymentKey ? 100000000n :
          call.label === "treasury" ? 100000000n : 1000000000n,
      ) })),
    );
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted batch partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([10, 90]);
    expect(result.attribution.observations.map(row => row.amount)).toEqual(["100000000", "1000000000", "100000000"]);
    expect(new Set(result.attribution.observations.map(row => row.anchorHash))).toEqual(new Set([HASH]));
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][1]).toHaveLength(6);
    expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3])
      .toMatchObject({ stateBlockHash: HASH, multicallFallbackBlockHash: HASH });
  });

  it.each(["coherent", "lookup unavailable", "future aligned pin", "stale oldest pin"] as const)(
    "aligns divergent safe heads without weakening admission: %s", async scenario => {
      const f = fixture(), first = f.plan.deployments[0]!;
      f.plan.deployments.push({ ...first, deploymentKey: `base:${first.address}`, chainId: "base" });
      const oldest = CLOCK - (scenario === "stale oldest pin" ? 1801 + BASE_FINALITY_MARGIN_SEC : 300);
      const target = oldest + 120;
      vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (chain, number) => {
        const height = number === "finalized" ? 100 : number;
        if (chain === "base" && height !== 100 && scenario === "lookup unavailable") return null;
        return {
          number: height, hash: HASH,
          timestamp: chain === "ethereum" ? oldest : scenario === "future aligned pin"
            ? CLOCK - 60 : CLOCK - 60 - (100 - height) * 24,
        };
      });
      const result = await f.run();
      if (scenario !== "coherent") {
        expect(result.status).toBe("rejected");
        if (scenario !== "stale oldest pin") expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
        return;
      }
      expect(result).toMatchObject({ status: "accepted", attribution: {
        aggregate: { observedAtSec: CLOCK - 60 },
        observations: [
          expect.objectContaining({ anchor: "100", observedAtSec: oldest }),
          expect.objectContaining({ anchor: "92", observedAtSec: target - 72 }),
        ],
      } });
      expect(vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls.map(call => [call[0], call[2]]))
        .toEqual([["ethereum", 100], ["base", 92]]);
      // Stop at the first in-window header and reuse it for the state reads;
      // the only repeat of that number is the mandatory final reorg check.
      expect(vi.mocked(evmRpc.fetchEvmBlockHeader).mock.calls
        .filter(([chain]) => chain === "base").map(([, number]) => number))
        .toEqual([100, 99, 98, 96, 92, 92]);
    },
  );

  it("rejects the exact failed batch leaf, never treating its unavailable amount as zero", async () => {
    const f = fixture();
    const first = f.plan.deployments[0]!;
    const second = { ...first, deploymentKey: `ethereum:0x${"2".repeat(40)}`, address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(second);
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: call.label !== second.deploymentKey,
        returnData: word(call.label.endsWith(":decimals") ? 6n : 100000000n) })),
    );
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: second.deploymentKey,
    });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(1);
  });

  it("admits pre-capture state newer than the previous source clock without redating its source", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK + 599, hash: HASH }));
    const result = await f.run(undefined, CLOCK + 600);
    expect(result).toMatchObject({ status: "accepted", attribution: {
      baseInputGenerationId: f.fixedInput.baseInputGenerationId, sourceGeneration: "source",
      scoringClockSec: CLOCK + 600, aggregate: { observedAtSec: CLOCK - 60, sourceGeneration: "source" },
      observations: [expect.objectContaining({ observedAtSec: CLOCK + 599, anchorHash: HASH })],
    } });
  });

  it.each([CLOCK - 1, NaN, CLOCK + 0.5])("rejects an inadmissible capture clock %s", async scoringClockSec => {
    const f = fixture();
    expect(await f.run(undefined, scoringClockSec)).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it("fails closed when a reviewed deployment observer throws", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockRejectedValue(new Error("RPC unavailable"));
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: f.plan.deployments[0]!.deploymentKey });
  });

  it.each(["hash", "timestamp", "missing"])("rejects a changed %s on the pinned block recheck", async change => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH }).mockResolvedValueOnce(change === "missing" ? null : { number: 100, timestamp: CLOCK - (change === "timestamp" ? 61 : 60), hash: change === "hash" ? `0x${"b".repeat(64)}` : HASH });
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-invalid", failedRouteId: "anchor:ethereum" });
  });

  it.each(["malformed", "oversized", "wrong decimals", "failed call"])("fails closed on %s EVM results", async failure => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockResolvedValue([{ label: "supply", success: failure !== "failed call", returnData: failure === "malformed" ? "0xzz" : failure === "oversized" ? `0x${"1".repeat(66)}` : word(100000000n) }, { label: "decimals", success: true, returnData: word(failure === "wrong decimals" ? 18n : 6n) }]);
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: f.plan.deployments[0]!.deploymentKey });
  });

  it("rejects unavailable safe heads, missing aggregate clocks and unreviewed assets", async () => {
    const f = fixture();
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(1);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
    f.fixedInput.aggregateCirculatingById.alpha!.observedAtSec = null;
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null });
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, assetId: "unreviewed" })).toEqual({ status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null });
  });

  it("reads reviewed nested API price and conversion amounts and retains their provenance", async () => {
    const f = fixture();
    f.plan.referencePriceSource = apiSource("reference");
    f.plan.conversionSources = [apiSource("conversion")];
    f.plan.deployments[0]!.claimUnit = "shares";
    f.plan.deployments[0]!.conversionSourceId = "conversion";
    const text = JSON.stringify(apiBody("1.25"));
    vi.mocked(fetch).mockImplementation(async () => new Response(text));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.referencePrice).toEqual({ sourceId: "reference", value: "1.25", observedAtSec: CLOCK - 60, sourceGeneration: "issuer-snapshot", responseSha256: sha256Hex(text) });
    expect(result.attribution.conversions[0]).toMatchObject({ sourceId: "conversion", value: "1.25" });
  });

  function erc4626Fixture() {
    const f = fixture(), row = f.plan.deployments[0]!;
    row.claimUnit = "local-vault-shares"; row.conversionSourceId = "vault-nav";
    const assetAddress = `0x${"4".repeat(40)}`;
    f.plan.conversionSources = [{ kind: "evm-erc4626-convert-to-assets", sourceId: "vault-nav",
      chainId: row.chainId, vaultAddress: row.address!, vaultRuntimeCodeSha256: sha256Hex("0x6000"),
      immutable: true, assetAddress, shareDecimals: 6, assetDecimals: 18 }];
    const state = ["0x6000", `0x${assetAddress.slice(2).padStart(64, "0")}`, word(6n), word(18n), word(1067335739311306659n)];
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(state);
    return { ...f, state };
  }

  it("values immutable vault shares at their exact holding pin without rounding away the conversion", async () => {
    const f = erc4626Fixture();
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(true);
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected exact pinned vault conversion");
    expect(result.attribution.conversions).toEqual([expect.objectContaining({
      value: "1.067335739311306659", observedAtSec: CLOCK - 60,
      sourceGeneration: `ethereum:100:${HASH}`, erc4626Proof: { anchor: 100, anchorHash: HASH, assets: "1067335739311306659" },
    })]);
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBe(100);
    const calls = vi.mocked(evmRpc.fetchEvmRpcBatch).mock.calls[0][1];
    expect(calls).toHaveLength(5);
    expect(calls.every(call => JSON.stringify(call.params[call.params.length - 1]) === JSON.stringify({ blockHash: HASH, requireCanonical: true }))).toBe(true);
    expect(calls[4].params[0]).toEqual({ to: f.plan.deployments[0]!.address,
      data: toFunctionSelector("convertToAssets(uint256)") + (10n ** 6n).toString(16).padStart(64, "0") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "runtime", "asset", "share decimals", "asset decimals", "zero", "malformed", "revert", "stale"])("rejects %s vault conversion without allocation fallback", async failure => {
    const f = erc4626Fixture();
    if (failure === "runtime") f.state[0] = "0x6001";
    if (failure === "asset") f.state[1] = word(1n);
    if (failure === "share decimals") f.state[2] = word(18n);
    if (failure === "asset decimals") f.state[3] = word(6n);
    if (failure === "zero") f.state[4] = word(0n);
    if (failure === "malformed") f.state[4] = "0x1";
    if (failure === "missing") vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(null);
    if (failure === "revert") vi.mocked(evmRpc.fetchEvmRpcBatch).mockRejectedValue(new Error("RPC reverted"));
    if (failure === "stale") vi.mocked(evmRpc.fetchEvmBlockHeader).mockResolvedValue({ number: 100, hash: HASH, timestamp: CLOCK - 1801 });
    expect(await f.run()).toMatchObject({ status: "rejected" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["1e3", "-1", "0", "9".repeat(400)])("rejects invalid reviewed API amount %s", async amount => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(apiBody(amount))));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it.each([undefined, CLOCK - 86400, CLOCK + 1])("rejects missing, stale or future API observation time %s", async time => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    const body = apiBody(); body.data.observedAt = time;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode:
      time === CLOCK - 86400 ? "deployment-observation-skew" : "packet-reconciliation-failed" });
  });

  it.each(["malformed JSON", "HTTP error"])("fails closed on reviewed API %s", async failure => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    vi.mocked(fetch).mockResolvedValue(failure === "malformed JSON" ? new Response("{") : new Response(JSON.stringify(apiBody()), { status: 503 }));
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: failure === "malformed JSON" ? "deployment-state-unavailable" : "packet-reconciliation-failed" });
  });
  it("accepts an API body exactly at its UTF-8 ceiling without changing its hash", async () => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    const body = JSON.stringify(apiBody()), text = body + " ".repeat(ECONOMIC_SUPPLY_BODY_CAPS.conversion - body.length);
    vi.mocked(fetch).mockResolvedValue(new Response(text));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.attribution.referencePrice.responseSha256).toBe(sha256Hex(text));
  });

  it.each(["declared", "streamed"])("rejects %s API overflow with cancellation and typed provenance", async mode => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    const cancel = vi.fn(), onDiagnostic = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { if (mode === "streamed") controller.enqueue(new TextEncoder().encode("é".repeat(ECONOMIC_SUPPLY_BODY_CAPS.conversion / 2 + 1))); }, cancel });
    const response = new Response(body, { headers: mode === "declared" ? { "Content-Length": String(ECONOMIC_SUPPLY_BODY_CAPS.conversion + 1) } : { "Content-Length": "1" } });
    const parse = vi.spyOn(response, "json"), text = vi.spyOn(response, "text");
    vi.mocked(fetch).mockResolvedValue(response);
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic })).toMatchObject({ status: "rejected", rejectionCode: "observer-body-over-cap", failedRouteId: "reference" });
    expect(cancel).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ hardEvidenceFailure: true, failurePredicate: "observer-body-over-cap", providerOrigin: "https://issuer.example", operands: expect.objectContaining({ maxBytes: ECONOMIC_SUPPLY_BODY_CAPS.conversion }) }));
  });

  it("cancels an API HTTP error before decoding its body", async () => {
    const f = fixture(); f.plan.referencePriceSource = apiSource("reference");
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const text = vi.spyOn(response, "text"); vi.mocked(fetch).mockResolvedValue(response);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
    expect(cancel).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
  });

  it("reads balance exclusions and pending liabilities without counting excluded holdings", async () => {
    const f = fixture();
    const row = f.plan.deployments[0]!;
    row.read = { kind: "evm-balance", safeBlockLag: 2, account: `0x${"2".repeat(40)}` };
    f.plan.exclusions = [{ id: "treasury", deploymentKey: row.deploymentKey, account: `0x${"3".repeat(40)}` }];
    f.plan.liabilityInFlightSource = apiSource("pending");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(apiBody("1000000"))));
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) => calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n : call.label === "treasury" ? 20000000n : 100000000n) })));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 80 / 81);
    expect(result.attribution.unattributedSupplyUsd).toBeCloseTo(100 / 81);
    expect(result.attribution.inFlight[0]).toMatchObject({ id: "in-flight:liability", amount: "1000000" });
  });

  function pendingFixture(pendingAmount = 1000000n, escrowAmount = 20000000n, receiptChainId = "base") {
    const f = fixture(), canonical = f.plan.deployments[0]!;
    const receipt = { ...canonical, deploymentKey: `${receiptChainId}:0x${"2".repeat(40)}`, chainId: receiptChainId, address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(receipt);
    f.plan.accountingFamily = "lock-mint";
    const messageId = `0x${"f".repeat(64)}`;
    f.plan.escrows = [{ id: "bridge", canonicalDeploymentKey: canonical.deploymentKey, account: `0x${"3".repeat(40)}`,
      receiptDeploymentKeys: [receipt.deploymentKey], receiptClaimSources: [], independentReceiptLiability: false,
      inFlightSource: { kind: "evm-pending-state", sourceId: "pending", chainId: "ethereum", bridgeAddress: `0x${"3".repeat(40)}`,
        bridgeRuntimeCodeSha256: sha256Hex("0x6000"), finality: "finalized", messageCountSelector: "0x11111111",
        messageIdSelector: "0x22222222", pendingAmountSelector: "0x33333333", messageIds: [messageId] } }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n :
        call.label === "bridge" ? escrowAmount : call.label === receipt.deploymentKey ? 19000000n : 100000000n) })));
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (_chain, calls) =>
      calls[0]!.method === "eth_getCode" ? ["0x6000", word(1n)] : [messageId, word(pendingAmount)]);
    return f;
  }

  it("conserves independently observed finalized pending messages without counting them as free float", async () => {
    const result = await pendingFixture().run();
    expect(result.status).toBe("accepted");
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      expect.objectContaining({ minBlockNumber: 100 }));
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(result.attribution.unattributedSupplyUsd).toBe(1);
    expect(result.attribution.inFlight[0]).toMatchObject({ amount: "1000000", anchor: "100", anchorHash: HASH });
  });
  it("requires mandatory finalized heads to remain fresh through the admitted capture window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000);
    const f = pendingFixture(undefined, undefined, "polygon");
    const result = await observeReviewedEconomicDeploymentPartitionAttempt({
      ...f, assetDeadlineMs: CLOCK * 1000 + 30_000,
    });
    expect(result.status).toBe("accepted");
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      { chainRpcs: f.chainRpcs, signal: undefined, minTimestampSec: CLOCK + 30 - 1800 });
  });
  it("widens the whole coherent pin set by its largest reviewed finality margin", async () => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000);
    const f = pendingFixture();
    // A pin captured by the previous run's finalized heads is ~1806 s old once the reserve is added.
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - 1776, hash: HASH }));
    const result = await observeReviewedEconomicDeploymentPartitionAttempt({
      ...f, assetDeadlineMs: CLOCK * 1000 + 30_000,
    });
    expect(result.status).toBe("accepted");
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      { chainRpcs: f.chainRpcs, signal: undefined, minTimestampSec: CLOCK + 30 - 1800 - BASE_FINALITY_MARGIN_SEC });
  });
  it("rejects a margin-chain pin set beyond the base window plus its finality margin", async () => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000);
    const f = pendingFixture(), onDiagnostic = vi.fn();
    const pinAgeSec = 1800 + BASE_FINALITY_MARGIN_SEC - 20;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - pinAgeSec, hash: HASH }));
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({
      ...f, onDiagnostic, assetDeadlineMs: CLOCK * 1000 + 30_000,
    })).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: "anchor:ethereum:capture-freshness-window-insufficient" });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      failurePredicate: "capture-freshness-window-insufficient",
      operands: { freshnessClock: CLOCK + 30, maxAgeSec: 1800 + BASE_FINALITY_MARGIN_SEC } }));
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
  it.each([
    ["admits", 2010],
    ["rejects", 1800 + MEGAETH_FINALITY_MARGIN_SEC - 20],
  ] as const)("%s a MegaETH finalized pin set %s seconds old under its reviewed margin", async (verdict, pinAgeSec) => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000);
    // witry-brix's MegaETH finalized head trailed by ~2010 s; the reserved 30 s capture window still has to fit.
    const f = pendingFixture(undefined, undefined, "megaeth");
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - pinAgeSec, hash: HASH }));
    const result = await observeReviewedEconomicDeploymentPartitionAttempt({
      ...f, assetDeadlineMs: CLOCK * 1000 + 30_000,
    });
    if (verdict === "admits") expect(result.status).toBe("accepted");
    else expect(result).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: "anchor:ethereum:capture-freshness-window-insufficient" });
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", "finalized",
      { chainRpcs: f.chainRpcs, signal: undefined, minTimestampSec: CLOCK + 30 - 1800 - MEGAETH_FINALITY_MARGIN_SEC });
  });
  it("rejects mandatory pins before quantities when the reserved capture window would expire them", async () => {
    vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000);
    const f = pendingFixture(undefined, undefined, "polygon"), onDiagnostic = vi.fn();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      ({ number: number === "finalized" ? 100 : number, timestamp: CLOCK - 1790, hash: HASH }));
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({
      ...f, onDiagnostic, assetDeadlineMs: CLOCK * 1000 + 30_000,
    })).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: "anchor:ethereum:capture-freshness-window-insufficient" });
    expect(onDiagnostic.mock.calls).toEqual([[diagnosticFixture({ laneId: null, chainId: "ethereum",
      phase: "pinning", method: "capture-window", failurePredicate: "capture-freshness-window-insufficient",
      pinObservedAtSec: CLOCK - 1790, operands: { freshnessClock: CLOCK + 30, maxAgeSec: 1800 } })]]);
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
    expect(evmRpc.fetchEvmRpcBatch).not.toHaveBeenCalled();
  });
  it("keeps enumerable pending state escrow-only and rejects liability admission before acquisition", async () => {
    const f = pendingFixture(), onDiagnostic = vi.fn();
    f.plan.liabilityInFlightSource = f.plan.escrows[0]!.inFlightSource;
    f.plan.escrows = []; f.plan.accountingFamily = "independent-liability";
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic }))
      .toEqual({ status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null });
    expect(onDiagnostic.mock.calls).toEqual([[diagnosticFixture({ failurePredicate: "route-inventory-unavailable" })]]);
    expect(evmRpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
    expect(evmRpc.fetchEvmRpcBatch).not.toHaveBeenCalled();
  });
  it("propagates only the existing finalized holding pin and original economic clock", async () => {
    const f = pendingFixture();
    expect((await f.run()).status).toBe("accepted");
    const options = vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.calls[0][3]!;
    expect(options.recentStatePin).toEqual({ chainId: "ethereum",
      header: { number: 100, timestamp: CLOCK - 60, hash: HASH },
      finalized: { number: 100, timestamp: CLOCK - 60, hash: HASH },
      observedAtSec: CLOCK, maxAgeSec: 1800 + BASE_FINALITY_MARGIN_SEC });
    expect(options.observedHeadBlock).toBe(100);
    for (const [, , stateOptions] of vi.mocked(evmRpc.fetchEvmRpcBatch).mock.calls) {
      expect(stateOptions?.recentStatePin?.observedAtSec).toBe(CLOCK);
    }
    await expectRecentPinRouting(options);
  });

  it.each(["missing", "identity", "count", "code", "finalized head unavailable"])("rejects an unavailable or unauthenticated pending %s read", async failure => {
    const f = pendingFixture();
    if (failure === "finalized head unavailable") vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      number === "finalized" ? null : { number, timestamp: CLOCK - 60, hash: HASH });
    else vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (_chain, calls) =>
      failure === "missing" ? null : calls[0]!.method === "eth_getCode" ?
        [failure === "code" ? "0x6001" : "0x6000", word(failure === "count" ? 2n : 1n)] :
        [word(0n), word(1000000n)]);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: failure === "finalized head unavailable" ? f.plan.deployments[0]!.deploymentKey : "bridge" });
  });

  it("admits an empty pending queue only after a successful authenticated zero-count read", async () => {
    const f = pendingFixture(0n, 19000000n);
    const source = f.plan.escrows[0]!.inFlightSource!;
    if (!("kind" in source) || source.kind !== "evm-pending-state") throw new Error("Expected enumerable on-chain pending source");
    source.messageIds = [];
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(["0x6000", word(0n)]);
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    expect(result.attribution.unattributedSupplyUsd).toBe(0);
    expect(result.attribution.inFlight[0]!.amount).toBe("0");
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(null);
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
  });

  it("does not turn escrow surplus into pending supply", async () => {
    const f = pendingFixture(0n), onDiagnostic = vi.fn();
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic })).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ failurePredicate: "escrow-represented-equals-backing", laneId: "bridge", hardEvidenceFailure: true, operands: { representedNumerator: "19000000", representedDenominator: "1000000", backingNumerator: "20000000", backingDenominator: "1000000", pendingNumerator: "0", pendingDenominator: "1000000" } }));
  });

  it("uses reviewed receipt subsets and API pending amounts to conserve the escrow rather than its gross receipt supply", async () => {
    const f = pendingFixture(), escrow = f.plan.escrows[0]!;
    escrow.receiptClaimSources = [{ deploymentKey: escrow.receiptDeploymentKeys[0]!, source: apiSource("receipt") }];
    escrow.inFlightSource = apiSource("pending");
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(apiBody(
      String(url).endsWith("/receipt") ? "19000000" : "1000000",
    ))));
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      deployments: [expect.objectContaining({ currentSupplyUsd: 80 }), expect.objectContaining({ currentSupplyUsd: 19 })],
      unattributedSupplyUsd: 1,
      observations: expect.arrayContaining([expect.objectContaining({
        id: `receipt:bridge:${escrow.receiptDeploymentKeys[0]}`, amount: "19000000", anchor: "issuer-snapshot",
      })]),
      inFlight: [expect.objectContaining({ amount: "1000000", anchor: "issuer-snapshot" })],
    } });
  });

  it.each(["receipt", "pending"])("rejects unavailable API %s accounting instead of replacing it with a residual", async failure => {
    const f = pendingFixture(), escrow = f.plan.escrows[0]!;
    escrow.receiptClaimSources = [{ deploymentKey: escrow.receiptDeploymentKeys[0]!, source: apiSource("receipt") }];
    escrow.inFlightSource = apiSource("pending");
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith(`/${failure}`)
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify(apiBody("19000000"))));
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: failure === "receipt" ? escrow.receiptDeploymentKeys[0] : escrow.id,
    });
  });

  function oftFixture(liability = false) {
    const f = pendingFixture(0n, 19000000n), [canonical, receipt] = f.plan.deployments;
    const side = (row: typeof canonical, eid: number, endpoint: string) => ({
      chainId: row!.chainId, tokenAddress: row!.address!, oappAddress: row!.address!,
      oappRuntimeCodeSha256: sha256Hex("0x6000"), endpointAddress: endpoint,
      endpointRuntimeCodeSha256: sha256Hex("0x6000"), eid, localDecimals: 6, deploymentBlock: 100,
    });
    const source: LayerZeroOftPendingRead = {
      kind: "evm-layerzero-oft-pending", sourceId: "oft", chainId: "ethereum", finality: "finalized",
      localDecimals: 6, sharedDecimals: 6,
      sides: [side(canonical, 30101, `0x${"4".repeat(40)}`), side(receipt, 30184, `0x${"5".repeat(40)}`)],
      pathways: [{ sourceIndex: 0, destinationIndex: 1 }],
    };
    if (liability) {
      f.plan.accountingFamily = "independent-liability";
      f.plan.escrows = [];
      f.plan.liabilityInFlightSource = source;
    } else {
      f.plan.escrows[0]!.account = source.sides[0]!.oappAddress;
      f.plan.escrows[0]!.inFlightSource = source;
    }
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: [] })));
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (chain, calls) => calls.map(call => {
      if (call.method === "eth_getCode") return "0x6000";
      const query = call.params[0];
      if (!query || typeof query !== "object" || !("data" in query) || typeof query.data !== "string") {
        throw new Error("Expected OFT eth_call query");
      }
      const data = query.data.slice(0, 10);
      const index = chain === "ethereum" ? 0 : 1, local = source.sides[index]!, remote = source.sides[1 - index]!;
      const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
      if (data === toFunctionSelector("endpoint()")) return addressWord(local.endpointAddress);
      if (data === toFunctionSelector("eid()")) return word(BigInt(local.eid));
      if (data === toFunctionSelector("token()")) return addressWord(local.tokenAddress);
      if (data === toFunctionSelector("decimals()") || data === toFunctionSelector("sharedDecimals()")) return word(6n);
      if (data === toFunctionSelector("decimalConversionRate()")) return word(1n);
      if (data === toFunctionSelector("peers(uint32)")) return addressWord(remote.oappAddress);
      if (["outboundNonce(address,uint32,bytes32)", "inboundNonce(address,uint32,bytes32)", "lazyInboundNonce(address,uint32,bytes32)"]
        .some(signature => data === toFunctionSelector(signature))) return word(0n);
      throw new Error(`Unexpected OFT state read ${data}`);
    }));
    return { ...f, source };
  }

  it.each([false, true])("retains authenticated zero OFT pending proof for liability=%s without inventing free float", async liability => {
    const f = oftFixture(liability);
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      unattributedSupplyUsd: 0,
      inFlight: [expect.objectContaining({
        id: liability ? "in-flight:liability" : "in-flight:bridge",
        amount: "0", anchor: "100", anchorHash: HASH,
        layerZeroOftPendingProof: expect.objectContaining({
          pathways: [expect.objectContaining({ sentNonce: "0", pendingCount: 0 })],
        }),
      })],
    } });
  });
  it.each([false, true])("caps the shared OFT holding pin at the actual finalized head for liability=%s", async liability => {
    const f = oftFixture(liability);
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(110);
    const result = await f.run();
    expect(result).toMatchObject({ status: "accepted", attribution: {
      observations: expect.arrayContaining([expect.objectContaining({ anchor: "100" })]),
      inFlight: [expect.objectContaining({ layerZeroOftPendingProof: expect.objectContaining({
        pins: [expect.objectContaining({ anchor: 100 }), expect.objectContaining({ anchor: 100 })],
      }) })],
    } });
    expect(evmRpc.fetchEvmBlockHeader).not.toHaveBeenCalledWith(expect.anything(), 108, expect.anything());
  });

  it("rejects an unavailable finalized OFT head without reading a synthetic zero holding", async () => {
    const f = oftFixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      number === "finalized" ? null : { number, timestamp: CLOCK - 60, hash: HASH });
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: f.plan.deployments[0]!.deploymentKey,
    });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("retains the escrow OFT history-incomplete cause after successful holding and identity reads", async () => {
    const f = oftFixture(), original = vi.mocked(evmRpc.fetchEvmRpcBatch).getMockImplementation()!;
    // Keep the source pin beyond eight 1,000,000-block discovery windows.
    // The send occurs after the eight scanned windows. Each empty page has
    // a zero historical outbound counter, authenticating that sparse prefix.
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(8_001_002);
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => {
      const height = number === "finalized" ? 8_001_000 : number;
      return { number: height, timestamp: CLOCK - 60, hash: word(BigInt(height)) };
    });
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (chain, calls, options) => {
      const results = await original(chain, calls, options);
      if (!results) throw new Error("Expected OFT fixture state");
      return calls.map((call, index) => {
        const query = call.params[0], block = call.params[1];
        if (call.method === "eth_call" && query && typeof query === "object" && "data" in query &&
          typeof query.data === "string" && query.data.startsWith(toFunctionSelector("outboundNonce(address,uint32,bytes32)")) &&
          block && typeof block === "object" && "blockHash" in block) {
          return word(block.blockHash === word(8_001_000n) ? 1n : 0n);
        }
        return results[index];
      });
    });
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "in-flight:bridge:history-incomplete",
    });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it.each([false, true])("fails closed on unauthenticated OFT runtime for liability=%s", async liability => {
    const f = oftFixture(liability), onDiagnostic = vi.fn(), onPhase = vi.fn();
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockResolvedValue(["0x6001"]);
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic, onPhase })).toEqual({
      status: "rejected", rejectionCode: "deployment-state-unavailable",
      failedRouteId: liability ? "in-flight:liability:runtime-mismatch" : "in-flight:bridge:runtime-mismatch",
    });
    const context = { observer: "layerzero-oft" as const, sourceId: "oft", chainId: "ethereum",
      pinObservedAtSec: CLOCK - 60, finalizedLagBlocks: 0,
      operands: { pinNumber: 100, finalizedNumber: 100, finalizedObservedAtSec: CLOCK - 60 } };
    expect(onDiagnostic.mock.calls).toEqual([
      [diagnosticFixture({ ...context, phase: "pin-authentication", method: "eth_getBlockByNumber",
        hardEvidenceFailure: false, failurePredicate: null })],
      [diagnosticFixture({ ...context, phase: "rpc", method: "eth_getCode", failurePredicate: "runtime-mismatch" })],
    ]);
    expect(onPhase.mock.calls.flat()).toEqual(["reference", "holdings", "pinning", "holdings", "holdings",
      ...(liability ? [] : ["holdings"]), "conversions", "pending", "pending-authentication"]);
    const holdingCallOrder = vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mock.invocationCallOrder;
    expect(holdingCallOrder[holdingCallOrder.length - 1])
      .toBeLessThan(vi.mocked(evmRpc.fetchEvmRpcBatch).mock.invocationCallOrder[0]!);
  });

  it.each([false, true])("caps the shared CCIP holding pin at the actual finalized head for liability=%s instead of rejecting it", async liability => {
    const f = pendingFixture(), [canonical, receipt] = f.plan.deployments;
    const pool = f.plan.escrows[0]!.account;
    const side = (row: typeof canonical, chainSelector: string, tokenPoolAddress: string) => ({
      chainId: row!.chainId, chainSelector, tokenAddress: row!.address!, tokenPoolAddress,
      tokenPoolRuntimeCodeSha256: sha256Hex("0x6000"), decimals: 6,
    });
    const source: CcipPendingRead = {
      kind: "evm-ccip-pending", sourceId: "ccip", chainId: "ethereum", finality: "finalized", amountDecimals: 6,
      lanes: [{ id: "eth-base", version: "1.6", source: side(canonical, "1", pool),
        destination: side(receipt, "2", `0x${"4".repeat(40)}`), onRampAddress: `0x${"5".repeat(40)}`,
        offRampAddress: `0x${"6".repeat(40)}`, onRampRuntimeCodeSha256: sha256Hex("0x6000"),
        offRampRuntimeCodeSha256: sha256Hex("0x6000"), sourceStartBlock: 100 }],
    };
    if (liability) {
      f.plan.accountingFamily = "independent-liability"; f.plan.escrows = []; f.plan.liabilityInFlightSource = source;
    } else f.plan.escrows[0]!.inFlightSource = source;
    vi.mocked(evmRpc.fetchEvmBlockNumber).mockResolvedValue(110);
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 99 : number, timestamp: CLOCK - 60, hash: HASH,
    }));
    const result = await f.run();
    // Pins land on the finalized head (99); the CCIP reader then runs past its
    // finality gate, so whatever it reports is no longer `pin-not-finalized`.
    expect(result).not.toMatchObject({ failedRouteId: expect.stringContaining("pin-not-finalized") });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledWith("ethereum", expect.anything(), 99, expect.anything());
    expect(evmRpc.fetchEvmBlockHeader).not.toHaveBeenCalledWith(expect.anything(), 108, expect.anything());
  });

  it.each([false, true])("rejects an unavailable finalized CCIP head for liability=%s without assuming no pending messages", async liability => {
    const f = pendingFixture(), [canonical, receipt] = f.plan.deployments;
    const pool = f.plan.escrows[0]!.account;
    const side = (row: typeof canonical, chainSelector: string, tokenPoolAddress: string) => ({
      chainId: row!.chainId, chainSelector, tokenAddress: row!.address!, tokenPoolAddress,
      tokenPoolRuntimeCodeSha256: sha256Hex("0x6000"), decimals: 6,
    });
    const source: CcipPendingRead = {
      kind: "evm-ccip-pending", sourceId: "ccip", chainId: "ethereum", finality: "finalized", amountDecimals: 6,
      lanes: [{ id: "eth-base", version: "1.6", source: side(canonical, "1", pool),
        destination: side(receipt, "2", `0x${"4".repeat(40)}`), onRampAddress: `0x${"5".repeat(40)}`,
        offRampAddress: `0x${"6".repeat(40)}`, onRampRuntimeCodeSha256: sha256Hex("0x6000"),
        offRampRuntimeCodeSha256: sha256Hex("0x6000"), sourceStartBlock: 100 }],
    };
    if (liability) {
      f.plan.accountingFamily = "independent-liability"; f.plan.escrows = []; f.plan.liabilityInFlightSource = source;
    } else f.plan.escrows[0]!.inFlightSource = source;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      number === "finalized" ? null : { number, timestamp: CLOCK - 60, hash: HASH });
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: canonical!.deploymentKey });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps messenger pending escrow-only without substituting escrow surplus, liability=%s", async liability => {
    const f = pendingFixture(), [canonical, receipt] = f.plan.deployments;
    const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    f.plan.escrows[0]!.inFlightSource = {
      kind: "evm-l2-messenger-pending", protocol: "op-stack", bridgeFlavor: "sky",
      sourceId: "messenger", chainId: "ethereum", l2ChainId: "base", finality: "finalized",
      l1Token: canonical!.address!, l2Token: receipt!.address!, escrowAddress: f.plan.escrows[0]!.account,
      l1Bridge: address(10), l2Bridge: address(11), l1Messenger: address(12), l2Messenger: address(13),
      messagePasser: address(14), portal: address(15), l1StartBlock: 100, l2StartBlock: 100,
      scanPageBlocks: [100, 100],
      contracts: [
        ...[10, 12, 15].map(n => ({ chainId: "ethereum", address: address(n), runtimeCodeSha256: sha256Hex("0x6000") })),
        ...[11, 13, 14].map(n => ({ chainId: "base", address: address(n), runtimeCodeSha256: sha256Hex("0x6000") })),
      ],
      identityReads: [{ chainId: "ethereum", address: address(10), method: "eth_call", data: "0x12345678", expected: word(1n) }],
    };
    if (liability) {
      f.plan.liabilityInFlightSource = f.plan.escrows[0]!.inFlightSource;
      f.plan.escrows = []; f.plan.accountingFamily = "independent-liability";
    } else vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) =>
      number === "finalized" ? null : { number, timestamp: CLOCK - 60, hash: HASH });
    expect(await f.run()).toEqual({
      status: "rejected", rejectionCode: liability ? "route-inventory-unavailable" : "deployment-state-unavailable", failedRouteId: liability ? null : canonical!.deploymentKey,
    });
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
    if (liability) expect(evmRpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
  });

  it.each(["number", "hash"])("rejects pending generations whose escrow block %s changed", async failure => {
    const f = pendingFixture();
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({
      number: number === "finalized" ? 100 : number, timestamp: CLOCK - 60, hash: HASH,
    })).mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: 100, timestamp: CLOCK - 60, hash: HASH })
      .mockResolvedValueOnce({ number: failure === "number" ? 101 : 100, timestamp: CLOCK - 60,
        hash: failure === "hash" ? `0x${"b".repeat(64)}` : HASH });
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-invalid" });
  });

  it("reconciles provider-chain observations against the admitted aggregate", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    row.read = { kind: "provider-chain", sourceChain: "ethereum" }; row.amountBasis = "circulating-usd"; row.decimals = null;
    f.fixedInput.chainCirculatingById = { alpha: { ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
    f.fixedInput.chainCirculatingById.alpha!.ethereum!.current = 80;
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { unattributedSupplyUsd: 20 } });
    f.fixedInput.chainCirculatingById.alpha!.base = { ...f.fixedInput.chainCirculatingById.alpha!.ethereum!, current: 1 };
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: "provider:base" });
  });

  it.each([["Ethereum", "ethereum"], ["Fraxtal", "fraxtal"]])("reconciles the provider label %s with canonical deployment identity", async (label, chainId) => {
    const f = fixture(), row = f.plan.deployments[0]!;
    row.chainId = chainId;
    row.deploymentKey = `${chainId}:${row.address}`;
    f.fixedInput.chainCirculatingById = { alpha: { [label]: {
      current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100,
    } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      deployments: [expect.objectContaining({ chainId, currentSupplyUsd: 100 })],
    } });
    f.fixedInput.chainCirculatingById.alpha![label]!.current = 90;
    expect(await f.run()).toEqual({ status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: `provider:${label}` });
  });
  it("sums provider aliases before comparing their conserved economic allocation", async () => {
    const f = fixture(), template = { current: 60, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 };
    f.fixedInput.chainCirculatingById = { alpha: { Ethereum: template, ethereum: { ...template, current: 40 } } };
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
    f.fixedInput.chainCirculatingById.alpha!.ethereum!.current = 30;
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "packet-reconciliation-failed" });
  });

  it("propagates cancellation instead of manufacturing a rejection packet", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("finalized Solana mint observations", () => {
  function mockSolana(overrides: Record<string, unknown> = {}) {
    const results: Record<string, unknown> = { getAccountInfo: account(), getBlocks: [100], getBlock: { blockTime: CLOCK - 60, blockhash: "a".repeat(44) }, ...overrides };
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method as string;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[method] }));
    });
  }
  it("rejects an earlier produced block that does not certify the account context slot", async () => {
    mockSolana({ getBlocks: [99], getBlock: { blockTime: CLOCK - 1, blockhash: "a".repeat(44) } });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK, requireExactContextSlot: true })).toBeNull();
    const f = fixture(), row = f.plan.deployments[0]!;
    Object.assign(row, { deploymentKey: `solana:${MINT}`, chainId: "solana", address: MINT, read: { kind: "solana-mint", programOwner: OWNER } });
    expect(await f.run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: row.deploymentKey });
  });
  it("includes the Solana read in the conserved reviewed partition", async () => {
    const f = fixture(); const row = f.plan.deployments[0]!;
    Object.assign(row, { deploymentKey: `solana:${MINT}`, chainId: "solana", address: MINT, read: { kind: "solana-mint", programOwner: OWNER } });
    mockSolana();
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: { observations: [expect.objectContaining({ amount: "100000000", anchor: "100:100" })], deployments: [expect.objectContaining({ currentSupplyUsd: 100 })] } });
  });
  it.each(["01", "1.5", "-1"])("rejects noncanonical mint supply %s", async supply => {
    mockSolana({ getAccountInfo: account(supply) });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it.each(["owner", "decimals", "slots", "missing clock", "stale clock", "future clock", "hash"])("fails closed on invalid Solana %s", async failure => {
    const mint = account();
    if (failure === "owner") mint.value.owner = "UnreviewedProgram";
    if (failure === "decimals") mint.value.data.parsed.info.decimals = 18;
    mockSolana({ getAccountInfo: mint, ...(failure === "slots" ? { getBlocks: [1, 101] } : {}), getBlock: { blockTime: failure === "missing clock" ? undefined : failure === "stale clock" ? CLOCK - 1801 : failure === "future clock" ? CLOCK + 1 : CLOCK - 60, blockhash: failure === "hash" ? "invalid0" : "a".repeat(44) } });
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it("rejects oversized RPC envelopes without admitting their otherwise valid mint", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ result: account() }), { headers: { "content-length": "128001" } }));
    expect(await observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK })).toBeNull();
  });
  it("propagates an already aborted Solana request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(observeEconomicSolanaMint({ address: MINT, decimals: 6, clockSec: CLOCK, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("validated XRPL issued-currency observations", () => {
  function xrplFixture(failure?: string) {
    const f = fixture(); const row = f.plan.deployments[0]!;
    const issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    Object.assign(row, { deploymentKey: `xrpl:USD.${issuer}`, chainId: "xrpl", address: `USD.${issuer}`, amountBasis: "issued-currency-decimal", decimals: null, read: { kind: "xrpl-issued-currency", currency: "USD", issuer } });
    f.chainRpcs.set("xrpl", { chainId: "xrpl", chainName: "XRP Ledger", type: "other", explorerUrl: "https://xrpscan.com", endpoints: [{ url: "https://xrpl.example/rpc", operator: "public", keyed: false, position: "registry", stateHistory: "recent", logsHistory: "none" }] });
    const hash = "A".repeat(64);
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const method = JSON.parse(String(options?.body)).method;
      if (failure === "malformed") return new Response("{");
      return new Response(JSON.stringify({ result: method === "gateway_balances" ? { validated: failure !== "unvalidated", ledger_index: 100, ledger_hash: hash, obligations: { USD: failure === "negative" ? "-100" : "1.00e2" } } : { ledger: { ledger_hash: failure === "hash mismatch" ? "B".repeat(64) : hash, close_time: failure === "missing time" ? undefined : CLOCK - (failure === "stale time" ? 1801 : 60) - 946684800 } } }));
    });
    return f;
  }
  it("refuses non-XRPL holding kinds at the leaf without network acquisition", async () => {
    const f = fixture();
    expect(await readEconomicXrplHolding({ row: f.plan.deployments[0]!, url: "https://xrpl.example/rpc",
      bodyCaps: ECONOMIC_SUPPLY_BODY_CAPS, onBodyMethod: vi.fn() })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads liabilities and the pinned ledger close time, normalizing amount and hash", async () => {
    const result = await xrplFixture().run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    const hash = "A".repeat(64);
    const gatewayText = JSON.stringify({ result: { validated: true, ledger_index: 100, ledger_hash: hash, obligations: { USD: "1.00e2" } } });
    const ledgerText = JSON.stringify({ result: { ledger: { ledger_hash: hash, close_time: CLOCK - 60 - 946684800 } } });
    expect(result.attribution.observations[0]).toEqual({
      id: "xrpl:USD.rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", deploymentKey: "xrpl:USD.rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      amount: "100", anchor: "100", anchorHash: "a".repeat(64), observedAtSec: CLOCK - 60,
      responseSha256: sha256Hex(gatewayText + ledgerText),
    });
    expect(result.attribution.deployments[0]!.currentSupplyUsd).toBe(100);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { method: "gateway_balances", params: [{ account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", ledger_index: "validated", strict: true }] },
      { method: "ledger", params: [{ ledger_hash: hash }] },
    ]);
  });
  it.each(["malformed", "negative", "unvalidated", "hash mismatch", "missing time", "stale time"])("rejects XRPL %s", async failure => {
    const f = xrplFixture(failure), onDiagnostic = vi.fn();
    const rejectionCode = failure === "stale time" ? "deployment-observation-skew" : "deployment-state-unavailable";
    const failedRouteId = f.plan.deployments[0]!.deploymentKey;
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic }))
      .toEqual({ status: "rejected", rejectionCode, failedRouteId });
    expect(onDiagnostic.mock.calls).toEqual([[diagnosticFixture({ laneId: failedRouteId, failurePredicate: rejectionCode })]]);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method))
      .toEqual(["gateway_balances", ...(["hash mismatch", "missing time", "stale time"].includes(failure) ? ["ledger"] : [])]);
  });
  it.each(["gateway_balances", "ledger"])("rejects capped XRPL %s bodies and cancels HTTP errors before parsing", async method => {
    for (const failure of ["overflow", "http-error"]) {
      const f = xrplFixture(), original = vi.mocked(fetch).getMockImplementation()!, cancel = vi.fn(), onDiagnostic = vi.fn();
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (JSON.parse(String(init?.body)).method !== method) return original(url, init);
        const cap = method === "ledger" ? ECONOMIC_SUPPLY_BODY_CAPS.xrplLedger : ECONOMIC_SUPPLY_BODY_CAPS.xrplGatewayBalances;
        return new Response(new ReadableStream({ cancel }), { status: failure === "http-error" ? 503 : 200, headers: { "Content-Length": String(cap + 1) } });
      });
      const cap = method === "ledger" ? ECONOMIC_SUPPLY_BODY_CAPS.xrplLedger : ECONOMIC_SUPPLY_BODY_CAPS.xrplGatewayBalances;
      const failedRouteId = f.plan.deployments[0]!.deploymentKey;
      expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic })).toEqual({
        status: "rejected", rejectionCode: failure === "overflow" ? "observer-body-over-cap" : "deployment-state-unavailable", failedRouteId,
      });
      expect(onDiagnostic.mock.calls).toEqual([[diagnosticFixture(failure === "overflow" ? {
        laneId: failedRouteId, phase: "body-intake", method, providerOrigin: "https://xrpl.example",
        failurePredicate: "observer-body-over-cap", operands: { maxBytes: cap, observedBytes: cap + 1 },
      } : { laneId: failedRouteId })]]);
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
});

describe("identity-bound non-EVM economic supply", () => {
  const metadataAddress = `0x${"b".repeat(64)}`;
  const master = "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr";
  const pin = { workchain: -1, shard: "-9223372036854775808", seqno: 97048839,
    root_hash: "G++xuEKh8vIc5zIdqmuZXGKyAKbwCiAqzTKEsTSI3OM=", file_hash: "VsEwupusnpifJYRlFR4f9cZ1vJqpnxb9Huywp8jBA90=" };
  function nonEvmFixture(chainId: "aptos" | "movement" | "ton", failure?: string) {
    const f = fixture(), row = f.plan.deployments[0]!;
    const address = chainId === "ton" ? master : metadataAddress;
    Object.assign(row, { deploymentKey: `${chainId}:${address}`, chainId, address, read: chainId === "ton"
      ? { kind: "ton-jetton-supply", apiUrl: "https://ton.example/api/v2" }
      : { kind: "move-fa-supply", identityKind: "metadata-address", metadataAddress, ledgerChainId: chainId === "aptos" ? 1 : 126 } });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url);
      let result: unknown;
      if (chainId !== "ton") {
        if (path.includes("ConcurrentSupply")) result = { type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "100000000" } } };
        else if (path.includes("Metadata")) result = { type: "0x1::fungible_asset::Metadata", data: { decimals: failure === "decimals" ? 18 : 6 } };
        else if (path.includes("ObjectCore")) result = { type: "0x1::object::ObjectCore", data: { transfer_events: { guid: { id: { addr: failure === "identity" ? "0x123" : metadataAddress } } } } };
        else result = { chain_id: chainId === "aptos" ? 1 : 126, ledger_version: failure === "pin" ? undefined : "100",
          oldest_ledger_version: "1", ledger_timestamp: failure === "timestamp" ? undefined : String((CLOCK - 60) * 1_000_000) };
      } else {
        if (path.includes("getMasterchainInfo")) result = { ok: true, result: { last: pin } };
        else if (path.includes("lookupBlock")) result = { ok: true, result: pin };
        else if (path.includes("getBlockHeader")) result = { ok: true, result: { id: pin, global_id: -239, gen_utime: failure === "timestamp" ? undefined : CLOCK - 60 } };
        else if (init?.method === "POST" && path.endsWith("runGetMethod")) result = { ok: true, result: { exit_code: 0, block_id: failure === "pin" ? undefined : pin, stack: [["num", "0x5f5e100"]] } };
        else result = { ok: true, result: { address: failure === "identity" ? "other-master" : master, contract_type: "jetton_master", total_supply: "100000000",
          jetton_content: { type: "onchain", data: { decimals: failure === "decimals" ? "18" : "6" } } } };
      }
      return new Response(JSON.stringify(result));
    });
    return f;
  }
  it.each(["aptos", "ton"] as const)("admits %s supply to the conserved census without rewriting the provider aggregate", async chainId => {
    const f = nonEvmFixture(chainId);
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(true);
    expect(await f.run()).toMatchObject({ status: "accepted", attribution: {
      aggregate: { supplyUsd: 100, observedAtSec: CLOCK - 60 }, quantitativeCompleteness: true,
      observations: [expect.objectContaining({ amount: "100000000", anchor: chainId === "ton" ? String(pin.seqno) : "100", observedAtSec: CLOCK - 60 })],
      deployments: [expect.objectContaining({ currentSupplyUsd: 100 })],
    } });
  });
  it.each(["aptos", "movement"] as const)("passes admitted native context into %s's identity-bound supply read", async chainId => {
    const f = nonEvmFixture(chainId);
    const dwellirNative = createDwellirNativeCapability("native-test-key-placeholder");
    const result = await observeReviewedEconomicDeploymentPartitionAttempt({
      assetId: f.assetId, fixedInput: f.fixedInput, chainRpcs: f.chainRpcs, scoringClockSec: CLOCK, dwellirNative,
    });
    expect(result.status).toBe("accepted");
    const base = DWELLIR_NATIVE_ENDPOINTS.find(endpoint => endpoint.network === chainId)!.baseUrl;
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(base);
    expect(vi.mocked(fetch).mock.calls.every(([url, init]) => String(url).startsWith(base) &&
      new Headers(init?.headers).get("X-Api-Key") === "native-test-key-placeholder")).toBe(true);
  });
  it.each(["aptos", "ton"] as const)("rejects %s wrong metadata, missing chronology and decimals", async chainId => {
    for (const failure of ["identity", "pin", "timestamp", "decimals"]) {
      expect(await nonEvmFixture(chainId, failure).run()).toMatchObject({ status: "rejected", rejectionCode: "deployment-state-unavailable" });
    }
  });
  it("rejects Move plan metadata and ledger-chain mismatches before observation", () => {
    const f = nonEvmFixture("aptos"), row = f.plan.deployments[0]!;
    if (row.read.kind !== "move-fa-supply") throw new Error("Expected Move read");
    row.read.metadataAddress = "0x123";
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(false);
    row.read.metadataAddress = metadataAddress;
    row.read.ledgerChainId = 126;
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(f.plan).success).toBe(false);
  });
  it.each(["aptos", "ton"] as const)("rejects missing persisted %s anchor identity rather than trusting conserved rows", async chainId => {
    const f = nonEvmFixture(chainId), result = await f.run();
    if (result.status !== "accepted") throw new Error("Expected accepted partition");
    const validate = () => reviewedEconomicDeploymentAttributionValidationError({
      assetId: "alpha", attribution: result.attribution, aggregateSupplyUsd: 100,
      registryFingerprint: f.fixedInput.registryFingerprint, clockSec: CLOCK,
    });
    expect(validate()).toBeNull();
    const observation = result.attribution.observations[0]!;
    const anchor = observation.anchor;
    observation.anchor = "latest";
    expect(validate()).toBe("Economic supply attribution accounting/census invalid");
    observation.anchor = anchor;
    observation.anchorHash = "unpinned";
    expect(validate()).toBe("Economic supply attribution accounting/census invalid");
  });
});

describe("nonce-authenticated Curve LayerZero pending history", () => {
  function curveFixture() {
    const source: CurveLzPendingRead = {
      kind: "evm-curve-lz-pending", sourceId: "curve-pending", chainId: "ethereum", finality: "finalized",
      sides: [0, 1].map((index) => ({
        chainId: index === 0 ? "ethereum" : "base",
        bridgeAddress: `0x${String(index + 3).repeat(40)}`,
        bridgeRuntimeCodeSha256: sha256Hex("0x6000"),
        endpointAddress: `0x${String(index + 5).repeat(40)}`,
        endpointRuntimeCodeSha256: sha256Hex("0x6000"),
        lzChainId: index === 0 ? 101 : 184, deploymentBlock: 90,
        sendLibraries: [{ address: `0x${String(index + 7).repeat(40)}`, runtimeCodeSha256: sha256Hex("0x6000"), encoding: "packet-v1" as const }],
        outboundNonceRead: { address: `0x${String(index + 5).repeat(40)}`, runtimeCodeSha256: sha256Hex("0x6000"), callData: "0x11111111" },
        supportsFailed: index === 0,
      })) as CurveLzPendingRead["sides"],
    };
    const receiver = `0x${"9".repeat(40)}` as `0x${string}`;
    const payload = encodeAbiParameters(parseAbiParameters("address,uint256"), [receiver, 1000000n]);
    const topic = (name: string) => keccak256(toHex(name));
    const sent: Array<Array<Record<string, unknown>>> = [[], []], received: Array<Array<Record<string, unknown>>> = [[], []];
    const rawLog = (address: string, topics: string[], data: string, height = 95, index = 0) =>
      ({ address, topics, data, blockNumber: `0x${height.toString(16)}`, blockHash: HASH, transactionHash: HASH, logIndex: `0x${index.toString(16)}`, removed: false });
    const send = (i: number, nonce = 1n, index = 0) => {
      const a = source.sides[i]!, b = source.sides[1 - i]!;
      const packet = `0x${nonce.toString(16).padStart(16, "0")}${a.lzChainId.toString(16).padStart(4, "0")}${a.bridgeAddress.slice(2)}${b.lzChainId.toString(16).padStart(4, "0")}${b.bridgeAddress.slice(2)}${payload.slice(2)}` as `0x${string}`;
      sent[i]!.push(rawLog(a.sendLibraries[0]!.address, [topic("Packet(bytes)")], encodeAbiParameters(parseAbiParameters("bytes"), [packet]), 95, index));
    };
    const receive = (direction: number, name = "Delayed", nonce = 1n, index = 0) => {
      const side = 1 - direction;
      received[side]!.push(rawLog(source.sides[side]!.bridgeAddress, [topic(`${name}(uint64,address,uint256)`), word(nonce), `0x${receiver.slice(2).padStart(64, "0")}`], word(1000000n), 96, index));
    };
    let badCommitment = false;
    vi.mocked(evmRpc.fetchEvmRpcBatch).mockImplementation(async (chain, calls) => {
      const i = chain === "ethereum" ? 0 : 1, side = source.sides[i]!;
      if (calls[0]!.method === "eth_getCode") return calls.map(() => "0x6000");
      if (calls[0]!.method === "eth_getLogs") {
        const params = calls[0]!.params[0] as { address: string | string[]; fromBlock: string; toBlock: string };
        const rows = Array.isArray(params.address) ? sent[i]! : received[i]!;
        return [rows.filter(row => BigInt(row.blockNumber as string) >= BigInt(params.fromBlock) && BigInt(row.blockNumber as string) <= BigInt(params.toBlock))];
      }
      if (calls[0]!.method === "eth_getTransactionByHash") return [{ hash: HASH, to: side.bridgeAddress, input: toFunctionSelector("bridge(uint256)") + word(1000000n).slice(2) }];
      const call = calls[0]!.params[0] as { data: string };
      if (call.data === toFunctionSelector("LZ_ENDPOINT()")) return [`0x${side.endpointAddress.slice(2).padStart(64, "0")}`, word(BigInt(source.sides[1 - i]!.lzChainId))];
      if (call.data === "0x11111111") return [word(BigInt(sent[i]!.length))];
      if (call.data.startsWith(toFunctionSelector("getInboundNonce(uint16,bytes)"))) return [word(BigInt(received[i]!.filter(row => (row.topics as string[])[0] !== topic("Issued(uint64,address,uint256)")).length))];
      if (call.data.startsWith(toFunctionSelector("delayed(uint64)"))) return [badCommitment ? word(0n) : keccak256(encodeAbiParameters(parseAbiParameters("uint256,bytes"), [BigInt(CLOCK - 60), payload]))];
      if (call.data.startsWith(toFunctionSelector("failed(uint64)"))) return [keccak256(payload)];
      throw new Error("Unexpected RPC method");
    });
    const input = { source, clockSec: CLOCK, headers: [{ number: 100, timestamp: CLOCK - 60, hash: HASH }, { number: 100, timestamp: CLOCK - 60, hash: HASH }], chainRpcs: new Map<string, ChainRpcConfig>() };
    return { input, send, receive, sent, received, rejectCommitment() { badCommitment = true; } };
  }

  it("authenticates delayed commitments in both directions without estimating an escrow residual", async () => {
    const f = curveFixture(); f.send(0); f.receive(0); f.send(1); f.receive(1, "Failed");
    const result = await observeCurveLzPending(f.input);
    expect(result).toMatchObject({ status: "accepted", amount: "2000000", proof: { pins: [expect.objectContaining({ chainId: "ethereum" }), expect.objectContaining({ chainId: "base" })] } });
  });
  it("passes Curve's authenticated current pin without classifying other history as recent", async () => {
    const f = curveFixture();
    expect((await observeCurveLzPending(f.input)).status).toBe("accepted");
    for (const side of f.input.source.sides) {
      expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledWith(side.chainId, "finalized",
        expect.objectContaining({ minBlockNumber: 100 }));
    }
    const options = vi.mocked(evmRpc.fetchEvmRpcBatch).mock.calls[0][2]!;
    expect(options.recentStatePin).toMatchObject({ chainId: "ethereum",
      header: f.input.headers[0], finalized: f.input.headers[0], observedAtSec: CLOCK, maxAgeSec: 1800 });
    await expectRecentPinRouting(options);
  });

  it("counts an authenticated source send not yet delivered to the destination", async () => {
    const f = curveFixture(); f.send(0);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "accepted", amount: "1000000" });
  });

  it("resumes contiguous bounded history and admits zero only after all four streams finish", async () => {
    const f = curveFixture();
    f.input.headers[0]!.number = 30000; f.input.headers[1]!.number = 30000;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 30000 : number, timestamp: CLOCK - 60, hash: HASH }));
    let result = await observeCurveLzPending(f.input);
    for (let attempt = 0; attempt < 8 && result.status === "rejected"; attempt++) {
      expect(result.reason).toBe("history-incomplete");
      if (!result.checkpoint) throw new Error("Expected bounded progress");
      result = await observeCurveLzPending({ ...f.input, checkpoint: result.checkpoint });
    }
    expect(result).toMatchObject({ status: "accepted", amount: "0" });
  });

  it("rejects a missing source nonce rather than treating a partial event book as complete", async () => {
    const f = curveFixture(); f.send(0, 2n);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "missing-nonce" });
  });

  it("rejects a replayed nonce in another valid log position", async () => {
    const f = curveFixture(); f.send(0); f.send(0, 1n, 1);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "replayed-nonce" });
  });

  it("rejects replayed consumption of an already issued nonce", async () => {
    const f = curveFixture(); f.send(0); f.receive(0, "Issued"); f.receive(0, "Issued", 1n, 1);
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "replayed-or-missing-nonce" });
  });

  it("retains a bounded catch-up checkpoint without publishing a partial pending quantity", async () => {
    const f = curveFixture();
    f.input.headers[0]!.number = 30000; f.input.headers[1]!.number = 30000;
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (_chain, number) => ({ number: number === "finalized" ? 30000 : number, timestamp: CLOCK - 60, hash: HASH }));
    const first = await observeCurveLzPending(f.input);
    expect(first).toMatchObject({ status: "rejected", reason: "history-incomplete" });
    if (first.status !== "rejected" || !first.checkpoint) throw new Error("Expected catch-up checkpoint");
    expect(first.checkpoint.directions[0]!.sent.nextBlock).toBe(16090);
    first.checkpoint.directions[0]!.sent.nextBlock++;
    expect(await observeCurveLzPending({ ...f.input, checkpoint: first.checkpoint })).toMatchObject({ status: "rejected", reason: "history-gap" });
  });

  it("rejects a cleared delayed commitment without a matching Issued event", async () => {
    const f = curveFixture(); f.send(0); f.receive(0); f.rejectCommitment();
    expect(await observeCurveLzPending(f.input)).toMatchObject({ status: "rejected", reason: "commitment-mismatch" });
  });

  it("feeds a conserved canonical-free/receipt/pending partition into existing admission", async () => {
    const f = fixture(), history = curveFixture(), canonical = f.plan.deployments[0]!;
    history.send(0); history.receive(0);
    const receipt = { ...canonical, deploymentKey: `base:0x${"2".repeat(40)}`, chainId: "base", address: `0x${"2".repeat(40)}` };
    f.plan.deployments.push(receipt);
    f.plan.accountingFamily = "lock-mint";
    f.plan.escrows = [{ id: "bridge", canonicalDeploymentKey: canonical.deploymentKey, account: history.input.source.sides[0].bridgeAddress,
      receiptDeploymentKeys: [receipt.deploymentKey], receiptClaimSources: [], independentReceiptLiability: false, inFlightSource: history.input.source }];
    vi.mocked(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
      calls.map(call => ({ label: call.label, success: true, returnData: word(call.label.endsWith(":decimals") ? 6n :
        call.label === "bridge" ? 20000000n : call.label === receipt.deploymentKey ? 19000000n : 100000000n) })));
    const result = await f.run();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected conserved partition");
    expect(result.attribution.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(result.attribution.unattributedSupplyUsd).toBe(1);
    expect(result.attribution.inFlight[0]!.curvePendingProof).toBeDefined();
  });
  it("keeps Curve history escrow-only rather than widening independent-liability support", async () => {
    const f = fixture(), history = curveFixture(), canonical = f.plan.deployments[0]!, onDiagnostic = vi.fn();
    f.plan.deployments.push({ ...canonical, deploymentKey: `base:0x${"2".repeat(40)}`, chainId: "base", address: `0x${"2".repeat(40)}` });
    f.plan.liabilityInFlightSource = history.input.source;
    expect(await observeReviewedEconomicDeploymentPartitionAttempt({ ...f, onDiagnostic }))
      .toEqual({ status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null });
    expect(onDiagnostic.mock.calls).toEqual([[diagnosticFixture({ failurePredicate: "route-inventory-unavailable" })]]);
    expect(evmRpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
    expect(evmRpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
});
