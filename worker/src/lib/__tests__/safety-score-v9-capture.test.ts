import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import type * as FixedInputIdentity from "@shared/lib/report-cards-fixed-input-identity";
import { reserveLossOutcome } from "../live-reserves/loss";
import type * as SnapshotModule from "../report-cards-snapshot";
import { redemptionLossOutcome } from "../redemption-backstop/loss";

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), peg: vi.fn() }));
vi.mock("../report-cards-snapshot-inputs", () => ({ loadReportCardsSnapshotInputs: mocks.inputs }));
vi.mock("../peg-analytics", () => ({ derivePegAnalyticsSnapshot: mocks.peg }));
vi.mock("@shared/lib/report-cards-fixed-input-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof FixedInputIdentity>()),
  computeReportCardsRegistryFingerprint: () => "a".repeat(64),
  computeRedemptionPayloadFingerprint: () => "b".repeat(64),
}));
vi.mock("../peg-analytics-cache", () => ({ publishPegAnalyticsCache: vi.fn(async () => true) }));
vi.mock("../report-card-evidence-journal-store", () => ({ loadReportCardEvidenceJournalByIdV1: vi.fn(async () => ({})) }));
vi.mock("../collateral-drift", () => ({ summarizeCollateralDriftFromLiveReserveMap: () => ({ fallbackCoins: [] }) }));
vi.mock("../report-cards-snapshot", async (original) => ({
  ...(await original<typeof SnapshotModule>()), loadExactDexPublicationGeneration: vi.fn(async () => ({ generationId: "dex:test", updatedAt: 1790000000 })),
}));
// Isolate capture orchestration from the separately tested full-catalog normalizer.
vi.mock("../safety-score-v9/native-input", () => ({
  computeNativeDexLiquidityPayloadFingerprint: () => "c".repeat(64),
  normalizeNativeV9Input: (value: unknown) => value,
}));
import { buildNativeSafetyScoreV9Capture } from "../safety-score-v9/capture";
const RUN = 1790000000;

function fixture(scoringClock: number, fetchedAt = RUN - 48 * 3600 + 60, metadataValid = true) {
  const entry = { ...makeRedemptionWriteRecord(), stablecoinId: "iusd-infinifi", updatedAt: RUN };
  const reserveInput = { generationId: "reserve:1790000000:test", contentSha256: "a".repeat(64), stablecoinId: entry.stablecoinId, attemptId: "success",
    configFingerprint: computeLiveReserveConfigFingerprint(ACTIVE_META_BY_ID.get(entry.stablecoinId)!.liveReservesConfig!),
    freshness: assessReserveFetchFreshness({ fetchedAt, attemptId: "success", metadata: { freshnessMode: "not-applicable" } }, RUN, 172800) };
  const runMetadata = metadataValid ? { reserveViewSchemaVersion: 2, reserveGenerationId: reserveInput.generationId, reserveContentSha256: reserveInput.contentSha256,
    runClockSec: RUN, consumedReserveInputs: { [entry.stablecoinId]: reserveInput } } : {};
  mocks.inputs.mockResolvedValue({
    stablecoinsCached: { kind: "ok", updatedAt: RUN, payload: { peggedAssets: [] } },
    dexLiquiditySnapshot: { latestUpdatedAt: RUN, map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])) },
    redemptionBackstopMap: { [entry.stablecoinId]: { ...entry, reserveInput } },
    redemptionSnapshotProvenance: { runId: "redemption:actual", latestUpdatedAt: RUN, methodologyVersion: entry.methodologyVersion, runMetadata },
    liveReserveMap: new Map(), liveReserveProvenanceMap: new Map(), liquidityStale: false, redemptionStale: false,
    reserveLossLineageById: new Map([[entry.stablecoinId, { latest: null, invalidations: {},
      authority: { attemptId: reserveInput.attemptId, observedAtSec: fetchedAt, sourceId: reserveInput.configFingerprint } }]]),
    inputFreshness: { dexLiquidity: { updatedAt: RUN, ageSeconds: 0, stale: false }, redemptionBackstops: { updatedAt: RUN, ageSeconds: 0, stale: false } },
    v9PublicationInputHealth: { dex: { state: "current" }, redemption: { state: "current", generationId: "redemption:actual", updatedAtSec: RUN }, liveReserves: { state: "available", coverageRatio: 1 } },
  });
  mocks.peg.mockResolvedValue({ nowSec: scoringClock, pegDataById: new Map(), eventsByCoin: new Map() });
}

beforeEach(() => vi.clearAllMocks());
describe("V9 consumed reserve scoring-clock admission", () => {
  it.each(["missing-authority", "missing-attempt"] as const)("keeps healthy consumed evidence admitted despite %s diagnostic authority", async (reason) => {
    fixture(RUN + 30, RUN - 60);
    const loaded = await mocks.inputs();
    const entry = loaded.redemptionBackstopMap["iusd-infinifi"];
    if (reason === "missing-authority") loaded.reserveLossLineageById.set(entry.stablecoinId, { latest: null, invalidations: {} });
    else loaded.reserveLossLineageById.get(entry.stablecoinId).authority.attemptId = null;
    loaded.redemptionBackstopMap["usdc-circle"] = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: RUN, score: 0, immediateCapacityUsd: 0 });
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(Object.keys(input.redemptionBackstopMap).sort()).toEqual([entry.stablecoinId, "usdc-circle"].sort());
    expect(input.redemptionBackstopMap[entry.stablecoinId].reserveInput).toEqual(entry.reserveInput);
    expect(input.redemptionLossOutcomesByAssetId?.[entry.stablecoinId]).toBeUndefined();
  });

  it("preserves origin admission for a reserve-backed peer without captured per-asset loss lineage", async () => {
    fixture(RUN + 30, RUN - 60);
    const loaded = await mocks.inputs();
    loaded.reserveLossLineageById = new Map();
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(Object.keys(input.redemptionBackstopMap)).toEqual(["iusd-infinifi"]);
    expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
    expect(input.redemptionLossOutcomesByAssetId?.["iusd-infinifi"]).toBeUndefined();
  });

  it("keeps an older healthy consumed parent admitted after a newer genuine reserve success", async () => {
    fixture(RUN + 30, RUN - 60);
    const loaded = await mocks.inputs();
    const entry = loaded.redemptionBackstopMap["iusd-infinifi"];
    const authority = { attemptId: "new-success", observedAtSec: RUN + 10,
      sourceId: entry.reserveInput!.configFingerprint };
    loaded.reserveLossLineageById = new Map([[entry.stablecoinId, { latest: null, invalidations: {}, authority }]]);
    loaded.redemptionBackstopMap["usdc-circle"] = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: RUN, score: 0, immediateCapacityUsd: 0 });
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(Object.keys(input.redemptionBackstopMap).sort()).toEqual([entry.stablecoinId, "usdc-circle"].sort());
    expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
    expect(input.redemptionBackstopMap[entry.stablecoinId].reserveInput).toEqual(entry.reserveInput);
    expect(input.redemptionLossOutcomesByAssetId?.[entry.stablecoinId]).toBeUndefined();
    expect(input.reserveLossLineageById?.[entry.stablecoinId]?.authority).toEqual(authority);
    expect(input.reserveLossLineageById?.[entry.stablecoinId]?.invalidations).toEqual({});
  });

  it.each(["semantic", "unknown"] as const)("localises a newer %s reserve revocation and preserves its exact parent packet", async (disposition) => {
    fixture(RUN + 30, RUN - 60);
    const loaded = await mocks.inputs();
    const entry = loaded.redemptionBackstopMap["iusd-infinifi"];
    const parent = reserveLossOutcome({ assetId: entry.stablecoinId, sourceId: entry.reserveInput!.configFingerprint,
      attemptId: "reserve-failed", runId: "reserve-attempt", observedAtSec: RUN + 10,
      reason: disposition === "semantic" ? "validation-failed" : "collector-exception", legs: [],
      ...(disposition === "semantic" ? { rejection: { key: "admission", sourceId: entry.reserveInput!.configFingerprint,
        disposition: "semantic" as const, reason: "validation-failed", proof: "reserve-failed:admission" } } : {}),
      priorEvidence: { ref: "reserve-composition:iusd-infinifi:success", observedAtSec: RUN - 60, expiresAtSec: RUN + 172740 } });
    loaded.reserveLossLineageById = new Map([[entry.stablecoinId, { latest: parent, invalidations: { composition: parent } }]]);
    loaded.redemptionBackstopMap["usdc-circle"] = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: RUN, score: 0, immediateCapacityUsd: 0 });
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(Object.keys(input.redemptionBackstopMap)).toEqual(["usdc-circle"]);
    expect(input.redemptionBackstopMap["usdc-circle"].score).toBe(0);
    expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
    const routeLoss = input.redemptionLossOutcomesByAssetId?.[entry.stablecoinId]?.[0];
    expect(routeLoss).toEqual({ ...parent, scope: { assetId: entry.stablecoinId, kind: "route",
      key: `redemption:${entry.stablecoinId}:${entry.routeFamily}` } });
    expect(input.reserveLossLineageById?.[entry.stablecoinId]?.invalidations.composition).toEqual(parent);
    const routeGap = input.pipelineGapByAssetId?.[entry.stablecoinId]?.find((row) => row.verdict.scope.pillar === "exit");
    expect(routeGap?.verdict.proof).toMatchObject({ sourceGenerationId: "reserve-failed", observedAtSec: RUN + 10,
      rejectionCode: "redemption-admission-reserve-invalidated" });
  });


  it.each([[59, "current"], [60, "current"], [61, "stale"]] as const)("reassesses 47h59m evidence %s seconds later as %s", async (delta, state) => {
    fixture(RUN + delta);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption).toMatchObject({ state, generationId: "redemption:actual", updatedAtSec: RUN });
    expect(input.inputFreshness.redemptionBackstops.ageSeconds).toBe(delta);
    expect(Object.keys(input.redemptionBackstopMap).length).toBe(state === "current" ? 1 : 0);
  });
  it("uses unavailable for incompatible bindings while retaining actual run diagnostics", async () => {
    fixture(RUN + 1, RUN - 60, false);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption).toMatchObject({ state: "unavailable", generationId: "redemption:actual", updatedAtSec: RUN });
  });
  it("holds mode-less v1 input unavailable, then admits a newly sealed v2 run", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    loaded.redemptionSnapshotProvenance.runMetadata.reserveViewSchemaVersion = 1;
    delete loaded.redemptionSnapshotProvenance.runMetadata.consumedReserveInputs["iusd-infinifi"].freshness.freshnessMode;
    const old = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(old.input.v9PublicationInputHealth.redemption.state).toBe("unavailable");
    expect(old.input.redemptionBackstopMap).toEqual({});
    fixture(RUN + 1, RUN - 60);
    const current = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(current.input.v9PublicationInputHealth.redemption.state).toBe("current");
    expect(current.input.redemptionBackstopMap["iusd-infinifi"]).toBeDefined();
  });
  it.each([[8 * 3600, "current"], [8 * 3600 + 1, "stale"]] as const)("preserves output expiry at %s seconds", async (delta, state) => {
    fixture(RUN + delta, RUN - 60);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption.state).toBe(state);
  });
  it("quarantines only the asset whose consumed reserve evidence lost admission", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    const other = ACTIVE_STABLECOINS.find((coin) => coin.id !== "iusd-infinifi" && coin.liveReservesConfig && !coin.liveReservesConfig.suspended)!;
    const base = loaded.redemptionBackstopMap["iusd-infinifi"];
    const otherInput = { ...base.reserveInput, stablecoinId: other.id, configFingerprint: computeLiveReserveConfigFingerprint(other.liveReservesConfig!) };
    const census = loaded.redemptionSnapshotProvenance.runMetadata.consumedReserveInputs;
    census[other.id] = otherInput;
    loaded.redemptionBackstopMap[other.id] = { ...base, stablecoinId: other.id, reserveInput: otherInput };
    // The first asset's binding is internally consistent but its source freshness was never verified.
    const unverified = { ...base.reserveInput, freshness: { ...base.reserveInput.freshness, freshnessMode: "unverified" } };
    census["iusd-infinifi"] = unverified;
    loaded.redemptionBackstopMap["iusd-infinifi"] = { ...base, reserveInput: unverified };
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
    expect(Object.keys(input.redemptionBackstopMap)).toEqual([other.id]);
    expect(input.inputFreshness.redemptionBackstops.stale).toBe(false);
    expect(input.pipelineGapByAssetId?.["iusd-infinifi"]).toEqual([expect.objectContaining({
      verdict: expect.objectContaining({ scope: expect.objectContaining({ pillar: "exit", factorKey: "capacity" }),
        proof: expect.objectContaining({ rejectionCode: "redemption-admission-freshness-unverified", sourceGenerationId: "redemption:actual" }) }),
    })]);
    expect(input.pipelineGapByAssetId?.[other.id]).toBeUndefined();
  });

  it.each(["sync-error", "malformed-persisted-row"] as const)("isolates %s with original loss lineage and keeps a newest zero peer", async (reason) => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    loaded.redemptionSnapshotProvenance.runMetadata.consumedReserveInputs = {};
    const peer = makeRedemptionWriteRecord({ stablecoinId: "usdc-circle", updatedAt: RUN, score: 0, immediateCapacityUsd: 0 });
    loaded.redemptionBackstopMap = { "usdc-circle": peer };
    if (reason === "sync-error") loaded.redemptionBackstopMap["iusd-infinifi"] = makeRedemptionWriteRecord({
      stablecoinId: "iusd-infinifi", updatedAt: RUN, resolutionState: "failed", score: null, provider: "sync-error",
    });
    loaded.redemptionSnapshotProvenance.assetCensus = {
      "iusd-infinifi": { routeFamily: "basket-redeem" }, "usdc-circle": { routeFamily: "offchain-issuer" },
    };
    loaded.redemptionSnapshotProvenance.quarantinedAssetIds = reason === "malformed-persisted-row" ? ["iusd-infinifi"] : [];
    loaded.redemptionSnapshotProvenance.lossOutcomesByAssetId = { "iusd-infinifi": [redemptionLossOutcome({
      assetId: "iusd-infinifi", routeKey: "redemption:iusd-infinifi:basket-redeem", reason,
      disposition: reason === "sync-error" ? "unknown" : "semantic", runId: "redemption:actual", observedAtSec: RUN,
    })] };
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(Object.keys(input.redemptionBackstopMap)).toEqual(["usdc-circle"]);
    expect(input.redemptionBackstopMap["usdc-circle"].score).toBe(0);
    expect(input.v9PublicationInputHealth.redemption.state).toBe("current");
    expect(input.redemptionLossOutcomesByAssetId?.["iusd-infinifi"]?.[0]).toMatchObject({
      disposition: reason === "sync-error" ? "unknown" : "semantic", observedAtSec: RUN, priorEvidence: null,
    });
    expect(input.pipelineGapByAssetId?.["iusd-infinifi"]?.[0].verdict).toMatchObject({
      scope: { pillar: "exit", factorKey: "capacity" }, proof: { rejectionCode: `redemption-admission-${reason}` },
    });
    expect(input.pipelineGapByAssetId?.["usdc-circle"]).toBeUndefined();
  });

  it("captures expired trustworthy output without renewing its clock or removing the global stale hold", async () => {
    fixture(RUN + 8 * 3600 + 1, RUN - 60);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.redemptionBackstopMap).toEqual({});
    expect(input.redemptionStale).toBe(true);
    expect(input.v9PublicationInputHealth.redemption.state).toBe("stale");
    expect(input.redemptionLossOutcomesByAssetId?.["iusd-infinifi"]?.[0]).toMatchObject({
      reason: "output-stale", disposition: "evidential", observedAtSec: RUN, priorEvidence: null,
    });
    expect(input.pipelineGapByAssetId?.["iusd-infinifi"]?.[0].verdict.proof).toMatchObject({ rejectionCode: "redemption-admission-output-stale" });
  });

  it("retains the global stale hold when every current row is quarantined", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    loaded.redemptionSnapshotProvenance.runMetadata.consumedReserveInputs = {};
    loaded.redemptionBackstopMap = {};
    loaded.redemptionSnapshotProvenance.assetCensus = { "iusd-infinifi": { routeFamily: "basket-redeem" } };
    loaded.redemptionSnapshotProvenance.quarantinedAssetIds = ["iusd-infinifi"];
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.redemptionBackstopMap).toEqual({});
    expect(input.redemptionStale).toBe(true);
    expect(input.v9PublicationInputHealth.redemption.state).toBe("stale");
    expect(input.redemptionLossOutcomesByAssetId?.["iusd-infinifi"]?.[0]).toMatchObject({
      reason: "malformed-persisted-row", disposition: "semantic", runId: "redemption:actual", observedAtSec: RUN,
    });
  });
});

describe("V9 peg price clocks in exact capture", () => {
  it("keeps original price clocks distinct from capture and cache generation clocks", async () => {
    fixture(RUN + 60, RUN - 60);
    const base = makeV9FixedInput().pegDataById.alpha!;
    const pegDataById = new Map([
      ["usdc-circle", { ...base, id: "usdc-circle", priceSource: "cached", priceObservedAt: RUN - 3_601, priceObservedAtMode: "upstream" }],
      ["usdt-tether", { ...base, id: "usdt-tether", priceSource: "coingecko", priceObservedAt: RUN - 10, priceObservedAtMode: "local_fetch" }],
    ]);
    mocks.peg.mockResolvedValue({ nowSec: RUN + 60, pegDataById, eventsByCoin: new Map() });
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.clockSec).toBe(RUN + 60);
    expect(input.updatedAt).toBe(RUN);
    expect(input.pegDataById["usdc-circle"]).toEqual(pegDataById.get("usdc-circle"));
    expect(input.pegDataById["usdt-tether"]).toEqual(pegDataById.get("usdt-tether"));
  });
});
