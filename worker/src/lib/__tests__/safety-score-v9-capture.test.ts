import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import type * as SnapshotModule from "../report-cards-snapshot";

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), peg: vi.fn() }));
vi.mock("../report-cards-snapshot-inputs", () => ({ loadReportCardsSnapshotInputs: mocks.inputs }));
vi.mock("../peg-analytics", () => ({ derivePegAnalyticsSnapshot: mocks.peg }));
vi.mock("../peg-analytics-cache", () => ({ publishPegAnalyticsCache: vi.fn(async () => true) }));
vi.mock("../report-card-evidence-journal-store", () => ({ loadReportCardEvidenceJournalByIdV1: vi.fn(async () => ({})) }));
vi.mock("../collateral-drift", () => ({ summarizeCollateralDriftFromLiveReserveMap: () => ({ fallbackCoins: [] }) }));
vi.mock("../report-cards-snapshot", async (original) => ({
  ...(await original<typeof SnapshotModule>()), loadExactDexPublicationGeneration: vi.fn(async () => ({ generationId: "dex-liquidity-1790000000", updatedAt: 1790000000 })),
}));
import { buildNativeSafetyScoreV9Capture } from "../safety-score-v9/capture";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
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
    inputFreshness: { dexLiquidity: { updatedAt: RUN, ageSeconds: 0, stale: false }, redemptionBackstops: { updatedAt: RUN, ageSeconds: 0, stale: false } },
    v9PublicationInputHealth: { dex: { state: "current" }, redemption: { state: "current", generationId: "redemption:actual", updatedAtSec: RUN }, liveReserves: { state: "available", coverageRatio: 1 } },
  });
  mocks.peg.mockResolvedValue({ nowSec: scoringClock, pegDataById: new Map(), eventsByCoin: new Map() });
}

beforeEach(() => vi.clearAllMocks());
describe("V9 consumed reserve scoring-clock admission", () => {
  // 10.26: evidence fresh at the run's assessment is carried until the run's
  // own output budget (8h, covered below), so 61s past its fetch budget stays current.
  it.each([[59, "current"], [60, "current"], [61, "current"]] as const)("reassesses 47h59m evidence %s seconds later as %s", async (delta, state) => {
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
        proof: expect.objectContaining({ rejectionCode: "redemption-reserve-input-freshness-unverified", sourceGenerationId: "redemption:actual" }) }),
    })]);
    expect(input.pipelineGapByAssetId?.[other.id]).toBeUndefined();
  });
  it("keeps the unaffected cohort when a published DEX row is quarantined", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    // The reader rejected usdc-circle's persisted row and named the reason; the
    // rest of the publication is still admitted (R8/ADR-35).
    loaded.dexLiquiditySnapshot = {
      latestUpdatedAt: RUN,
      map: Object.fromEntries(ACTIVE_STABLECOINS
        .filter((coin) => coin.id !== "usdc-circle")
        .map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
      quarantined: { "usdc-circle": { reason: "invalid-coverage-evidence", methodologyVersion: "1.0" } },
    };
    mocks.inputs.mockResolvedValue(loaded);

    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());

    // The quarantined asset keeps an evidence-free row: the input still covers
    // the cohort, and the exit compiler reads unavailable DEX evidence rather
    // than an absent subject or a zero-liquidity market (R1/R2).
    expect(Object.keys(input.dexLiqMap).sort()).toEqual(input.activeAssetIds);
    expect(input.dexLiqMap["usdc-circle"]).toEqual({ updatedAt: RUN });
    expect(input.pipelineGapByAssetId?.["usdc-circle"]?.map(({ verdict }) =>
      verdict.proof.rejectionCode).join(" ")).toMatch(/dex|coverage/i);
  });

  it("still holds the cohort when a quarantined DEX row carries another methodology", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    loaded.dexLiquiditySnapshot = {
      latestUpdatedAt: RUN,
      map: Object.fromEntries(ACTIVE_STABLECOINS
        .filter((coin) => coin.id !== "usdc-circle")
        .map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
      quarantined: { "usdc-circle": { reason: "invalid-coverage-evidence", methodologyVersion: "2.0" } },
    };
    mocks.inputs.mockResolvedValue(loaded);

    // A rejected row's own version still participates in the single-methodology
    // publication guard; a mixed publication is a producer-level defect.
    await expect(buildNativeSafetyScoreV9Capture(mockD1())).rejects.toThrow(/spans 2 DEX methodologies/);
  });

  it("retains separately sealed Reservoir redemption evidence without upgrading undated composition", async () => {
    fixture(RUN + 1, RUN - 60);
    const loaded = await mocks.inputs();
    const assetId = "rusd-reservoir";
    const sourceTimestamp = RUN - 60;
    const reserveInput = {
      ...loaded.redemptionBackstopMap["iusd-infinifi"].reserveInput,
      stablecoinId: assetId,
      configFingerprint: computeLiveReserveConfigFingerprint(ACTIVE_META_BY_ID.get(assetId)!.liveReservesConfig!),
      freshness: assessReserveFetchFreshness({
        fetchedAt: RUN - 59, attemptId: "success", metadata: { freshnessMode: "unverified" },
      }, RUN, 172800),
      redemptionCapacityEvidence: { sourceTimestamp, blockNumber: 26164363, outputAssetKeys: ["usdc-circle"] },
    };
    loaded.redemptionBackstopMap = { [assetId]: {
      ...loaded.redemptionBackstopMap["iusd-infinifi"], stablecoinId: assetId, reserveInput,
      sourceMode: "dynamic", freshnessKind: "same-run-onchain", capacityKind: "live-direct",
      sourceTimestamp, liveHolderEligibility: "any-holder",
    } };
    loaded.redemptionSnapshotProvenance.runMetadata.consumedReserveInputs = { [assetId]: reserveInput };
    mocks.inputs.mockResolvedValue(loaded);
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.redemptionStale).toBe(false);
    expect(input.redemptionBackstopMap[assetId]?.reserveInput?.freshness.freshnessMode).toBe("unverified");
    expect(input.pipelineGapByAssetId?.[assetId]).toBeUndefined();
    expect(input.liveReserveMap[assetId]).toBeUndefined();
  });
});

describe("V9 lender-book capture availability provenance", () => {
  it.each([false, true])("does not count availability markers as reserve observations (real reserve: %s)", async (hasReserve) => {
    const clockSec = RUN + 60;
    const observedAtSec = RUN - 3600;
    fixture(clockSec);
    const loaded = await mocks.inputs();
    if (hasReserve) {
      loaded.liveReserveProvenanceMap.set("kpkusdcprime-kpk", {
        source: "erc4626-single-asset",
        fetchedAt: observedAtSec,
      });
    }
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    const marker = input.liveReserveProvenanceMap["kpkusdcyield-kpk"];
    expect(marker).toMatchObject({
      source: "morpho-lender-book:capture-availability",
      fetchedAt: 0,
      lenderBookObservation: {
        status: "unavailable",
        reason: "missing-observation",
        acquiredAtSec: clockSec,
      },
    });
    if (hasReserve) {
      expect(input.liveReserveProvenanceMap["kpkusdcprime-kpk"]).toMatchObject({
        source: "erc4626-single-asset",
        fetchedAt: observedAtSec,
        lenderBookObservation: { status: "unavailable", reason: "missing-observation" },
      });
    }
    // Exercise the real aggregate source compiler without unrelated asset facts.
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput({
      ...input,
      activeAssetIds: [],
    }, { registryFingerprint: input.registryFingerprint });
    expect(extension.sources.liveReserves.observedAtSec).toBe(hasReserve ? observedAtSec : 0);
    expect(loaded.liveReserveProvenanceMap.has("kpkusdcyield-kpk")).toBe(false);
  });
});
