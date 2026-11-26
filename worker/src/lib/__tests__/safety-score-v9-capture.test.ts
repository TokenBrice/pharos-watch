import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { sha256Hex } from "@shared/lib/sha256";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  SAFETY_SCORE_V9_CACHE_KEYS,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
} from "@shared/types/safety-score-cache-keys";
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
import { buildNativeSafetyScoreV9Capture } from "./safety-score-v9-capture.test-support";
import {
  CHILD, G5_ANCHOR_ID, G5_R1_QUARANTINED_DEX_ID, G5_R2_ERRATUM_ID, G5_R3_DUST_SUSPENDED_ID,
  G5_R4_FOREIGN_PROVIDER_ID, makeV9CaptureFixtureSources, OBSERVED_REFERENCE, observedParent, pegRow,
  runInheritance, V9_CAPTURE_TEST_RUN, wrapperMeta, type TestMeta,
} from "./fixtures/safety-score-v9-g5-fixtures";
import type { runG5PipelineHarness } from "./safety-score-v9-publication-input.test-support";
import { decodeSafetyScoreCaptureArchiveObject, safetyScoreCaptureArchiveKey } from "../safety-score-v9/capture-archive-contract";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
import { parseNativeV9InputCacheArtifact } from "../safety-score-v9/native-input";
import { parseSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { parseSafetyScoreV9PublicationReplayCapture } from "../safety-score-v9/publication-replay-capture";
const RUN = V9_CAPTURE_TEST_RUN;

function fixture(scoringClock: number, fetchedAt = RUN - 48 * 3600 + 60, metadataValid = true, runAt = RUN) {
  const sources = makeV9CaptureFixtureSources(scoringClock, fetchedAt, metadataValid, runAt);
  mocks.inputs.mockResolvedValue(sources.inputs);
  mocks.peg.mockResolvedValue(sources.peg);
}

beforeEach(() => vi.clearAllMocks());
it.each([
  ["verified at the capture clock", '{"peggedGOLD":4000}', '{"peggedGOLD":4000}', 0, true],
  ["verified one second after capture", '{"peggedGOLD":4000}', '{"peggedGOLD":4000}', 1, false],
  ["digest mismatch", '{"peggedGOLD":4000}', "{}", 0, false],
  ["empty rates with matching digest", "{}", "{}", 0, false],
] as const)("checks independent bullion against the FX generation (%s)", async (_label, rates, digestInput, offset, admitted) => {
  fixture(RUN);
  const updatedAt = RUN + offset;
  const gold = { observation: { pegKey: "peggedGOLD", source: "gold-api.com", cadence: "intraday",
    usdPerUnit: 4_000, observedAtSec: RUN - 60 }, generation: "bullion:fixture", preCloseUsdPerUnit: 3_990 };
  const db = mockD1([{ match: "SELECT key, value, updated_at FROM cache WHERE key IN",
    rows: [
      { key: "fx-rates", value: rates, updated_at: updatedAt },
      { key: "fx-rates-meta", value: JSON.stringify({ ratesSha256: sha256Hex(digestInput),
        directMetalReferences: { peggedGOLD: gold } }), updated_at: updatedAt },
    ],
  }]);
  const { input } = await buildNativeSafetyScoreV9Capture(db);
  expect(input.directMetalReferences).toEqual(admitted ? { peggedGOLD: gold } : {});
});

it("keeps a missing bullion field distinct from a published empty map and an unreadable source", async () => {
  fixture(RUN);
  const rates = '{"peggedGOLD":4000}';
  for (const directMetalReferences of [undefined, {}]) {
    const db = mockD1([{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: [
      { key: "fx-rates", value: rates, updated_at: RUN },
      { key: "fx-rates-meta", value: JSON.stringify({ ratesSha256: sha256Hex(rates), directMetalReferences }), updated_at: RUN },
    ] }]);
    const { input } = await buildNativeSafetyScoreV9Capture(db);
    expect(input.directMetalReferences).toEqual(directMetalReferences);
  }
  const db = mockD1([{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: [], throwError: "read failed" }]);
  expect((await buildNativeSafetyScoreV9Capture(db)).input.directMetalReferences).toEqual({});
});

it.each([false, true])("preserves the EUR summary only on legacy FX generations (admission enabled: %s)", async (enabled) => {
  fixture(RUN);
  const sources = await mocks.inputs();
  if (enabled) sources.stablecoinsCached.payload.fxReferenceObservations = {};
  const id = "eurc-circle";
  const eventClock = RUN - 60;
  const row = pegRow({ id, pegCurrency: "EUR", pegType: "peggedEUR", pegScore: null, currentDeviationBps: -15,
    currentPriceUnavailable: false, priceSource: "coingecko", priceObservedAtMode: "upstream",
    pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: RUN } });
  mocks.peg.mockResolvedValue({ nowSec: RUN, pegDataById: new Map([[id, row]]), eventsByCoin: new Map(),
    admittedPegById: new Map(), lastAffectedAtById: new Map([[id, eventClock]]) });
  const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
  expect(input.pegDataById[id]?.currentDeviationBps).toBe(enabled ? null : row.currentDeviationBps);
  expect(input.pegDataById[id]?.pegReference).toEqual(enabled ? null : row.pegReference);
  expect(input.pegEvidenceById?.[id]).toEqual({ lastAffectedAtSec: eventClock, ...(enabled ? { admittedDeviationBps: null } : {}) });
});

describe("V9 consumed reserve scoring-clock admission", () => {
  // 10.26: evidence fresh at the run's assessment is carried until the run's
  // own output budget (8h, covered below), so 61s past its fetch budget stays current.
  it("rechecks Mento capacity at the Safety clock after a market reopening", async () => {
    const id = "chfm-mento";
    const reopened = Date.parse("2026-11-15T23:00:00Z") / 1000;
    const observed = reopened - 60;
    fixture(reopened, observed, true, observed);
    const { loadExactDexPublicationGeneration } = await import("../report-cards-snapshot");
    vi.mocked(loadExactDexPublicationGeneration).mockResolvedValueOnce({ generationId: `dex-liquidity-${observed}`, updatedAt: observed });
    const loaded = await mocks.inputs();
    // The producer assessed these reserves in the last minute of the closure.
    const entry = { ...makeRedemptionWriteRecord(), stablecoinId: id, updatedAt: observed,
      routeStatus: "open", routeStatusSource: "onchain", freshnessKind: "same-run-onchain",
      sourceTimestamp: observed, settlementDelaySec: 60, capacityKind: "documented-bound",
      resolutionState: "resolved", immediateCapacityUsd: null, immediateCapacityRatio: null };
    loaded.redemptionBackstopMap[id] = entry;
    const { input } = await buildNativeSafetyScoreV9Capture(mockD1());
    expect(input.redemptionBackstopMap[id]).toMatchObject({
      score: null, routeStatus: "unknown", resolutionState: "missing-capacity", updatedAt: observed,
    });
    expect(input.redemptionBackstopMap["iusd-infinifi"]).toBeDefined();
  });
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

describe("Safety Score V9 capture — reviewed 1:1 wrapper peg observation inheritance", () => {
  it("retains the legacy wrapper summary until an explicit clock or reference rejection withholds it", () => {
    const legacyParent = observedParent({ priceObservedAt: undefined, priceObservedAtMode: undefined });
    const child = runInheritance([pegRow(), legacyParent]).get(CHILD)!;
    expect(child).toMatchObject({ currentDeviationBps: -5, priceSource: "protocol-redeem", priceObservedAtMode: "upstream" });
    expect(child).not.toHaveProperty("priceObservedAt");
    expect(runInheritance([pegRow(), observedParent({ priceObservedAt: null })]).get(CHILD)?.currentDeviationBps).toBeNull();
    expect(runInheritance([pegRow({ priceObservedAt: null }), legacyParent]).get(CHILD)?.currentDeviationBps).toBeNull();
    expect(runInheritance([pegRow({ admittedDeviationBps: null }), observedParent()]).get(CHILD)?.currentDeviationBps).toBeNull();
  });
  it("publishes the parent's admitted observation for a nominal pure-wrapper row", () => {
    const result = runInheritance([pegRow(), observedParent()]);
    const child = result.get(CHILD)!;
    expect(child.currentDeviationBps).toBe(-5);
    expect(child.pegReference).toEqual(OBSERVED_REFERENCE);
    expect(child.priceSource).toBe("coingecko");
    expect(child.priceObservedAt).toBe(1_774_651_720);
    expect(child.priceObservedAtMode).toBe("upstream");
    expect(child).not.toHaveProperty("currentPriceUnavailable");
    expect(child).not.toHaveProperty("nominalPriceReference");
    // The fact-set admission gate (`isObservedPrice`) now admits the row, so a
    // current peg fact exists instead of the cause-A nominal rejection.
    expect(isObservedPrice(child)).toBe(true);
    // The wrapper's own adverse history is retained, never overwritten.
    expect(child.eventCount).toBe(2);
    expect(child.worstDeviationBps).toBe(-189);
  });

  it("leaves the row nominal when the tracked parent has no admitted observation", () => {
    const nominalParent = observedParent({
      currentDeviationBps: null,
      currentPriceUnavailable: true,
      pegReference: null,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
    });
    const child = runInheritance([pegRow(), nominalParent]).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
    expect(child.priceSource).toBe("protocol-par");
    expect(isObservedPrice(child)).toBe(false);
  });

  it("does not inherit across an unobserved intermediate wrapper (one hop only)", () => {
    const bridgeNominal = observedParent({ id: "wm-m0", currentDeviationBps: null, currentPriceUnavailable: true, pegReference: null });
    const result = runInheritance(
      [pegRow(), bridgeNominal, observedParent({ id: "grandparent" })],
      { [CHILD]: wrapperMeta({ variantOf: "wm-m0", pegReferenceId: "wm-m0" }) },
    );
    expect(result.get(CHILD)!.currentDeviationBps).toBeNull();
    expect(result.get(CHILD)!.currentPriceUnavailable).toBe(true);
  });

  it.each([
    ["an asset without a reviewed wrapper relationship", { [CHILD]: wrapperMeta({ variantOf: undefined, pegReferenceId: undefined }) }],
    ["a non-pure wrapper", { [CHILD]: wrapperMeta({ variantKind: "savings-passthrough" }) }],
    ["a self-referencing parent", { [CHILD]: wrapperMeta({ variantOf: CHILD, pegReferenceId: CHILD }) }],
    ["a mismatched variantOf", { [CHILD]: wrapperMeta({ variantOf: "other-parent" }) }],
  ])("leaves a nominal row untouched for %s", (_label, meta) => {
    const child = runInheritance([pegRow(), observedParent()], meta as Record<string, TestMeta>).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
    expect(child.priceSource).toBe("protocol-par");
  });

  it("requires the same non-blank peg type and currency", () => {
    const child = runInheritance([pegRow({ pegType: "peggedPHP", pegCurrency: "PHP" }), observedParent()]).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
  });

  it("keeps an already observed child row as published", () => {
    const observedChild = pegRow({
      currentDeviationBps: -12,
      currentPriceUnavailable: undefined,
      priceSource: "coingecko",
      priceObservedAtMode: "upstream",
      nominalPriceReference: undefined,
    });
    const child = runInheritance([observedChild, observedParent()]).get(CHILD)!;
    expect(child).toEqual(observedChild);
  });

  it("does not rewrite pure-NAV rows", () => {
    const child = runInheritance([pegRow(), observedParent()], {
      [CHILD]: wrapperMeta({
        flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: true },
      }),
    }).get(CHILD)!;
    expect(child.currentPriceUnavailable).toBe(true);
  });
});

// Stubbed upstream capture loaders (snapshot-inputs, peg-analytics, journals, DEX gen)
// plus one injected foreign provider review; real downstream capture -> peg-provenance
// seed -> full-cohort normalizeNativeV9Input -> subset compile -> schema -> R2 archive decode.
describe("G5 Safety Score V9 runtime guard (#2305)", () => {
  let g5: Awaited<ReturnType<typeof runG5PipelineHarness>>;

  beforeAll(async () => {
    // Scope the injected foreign provider review strictly to G5 so earlier tests read the real runtime asset.
    vi.resetModules();
    vi.doMock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json", async (original) => {
      const mod = await original<{ default: { negativeReviews?: unknown[] } }>();
      return {
        default: {
          ...mod.default,
          negativeReviews: [...(mod.default.negativeReviews ?? []), {
            reviewId: "g5-foreign-unreadable-ccip", assetId: "zz-foreign-ccip",
            scope: { kind: "provider", providerKey: "chainlink-ccip", surface: "dvn-set", coveredRoutes: [{ assetId: "zz-foreign-ccip", routeId: "ethereum:0x0" }] },
            reviewedAt: "2026-10-01", windowStartSec: 1_700_000_000, windowEndSec: 1_790_000_000, sources: [["a".repeat(64), "https://example.com/foreign"]],
          }],
        },
      };
    });
    const { loadExactDexPublicationGeneration } = await import("../report-cards-snapshot");
    const { runG5PipelineHarness: runG5 } = await import("./safety-score-v9-publication-input.test-support");
    g5 = await runG5({
      db: mockD1(),
      setSources: (sources, dexAt) => {
        vi.mocked(loadExactDexPublicationGeneration).mockResolvedValueOnce({ generationId: `dex-liquidity-${dexAt}`, updatedAt: dexAt });
        mocks.inputs.mockResolvedValueOnce(sources.inputs);
        mocks.peg.mockResolvedValueOnce(sources.peg);
      },
    });
  });

  afterAll(() => {
    vi.doUnmock("@shared/data/safety-score-v9/incident-runtime-v1.generated.json");
    vi.resetModules();
  });

  it.each([
    ["R1: quarantined DEX row yields excluded unavailable exit while cohort stays complete and anchor scores", () => {
      // R8/ADR-35 + R1/R2: the quarantined DEX row keeps an evidence-free slot so
      // the cohort stays complete and exit reads unavailable evidence, not zero liquidity.
      const { dexAt, captureOut, fullNormalized, pipeline, parsedPub } = g5;
      expect(fullNormalized.activeAssetIds.length).toBe(ACTIVE_STABLECOINS.length);
      expect(fullNormalized.baseInputGenerationId).toBe(captureOut.input.baseInputGenerationId);
      expect(Object.keys(fullNormalized.dexLiqMap).sort()).toEqual(fullNormalized.activeAssetIds);
      expect(fullNormalized.dexLiqMap[G5_R1_QUARANTINED_DEX_ID]).toEqual({ updatedAt: dexAt });
      expect(fullNormalized.pipelineGapByAssetId?.[G5_R1_QUARANTINED_DEX_ID]?.[0]?.verdict.proof.rejectionCode).toMatch(/dex|coverage/i);
      const r1Ev = pipeline.evaluatedSet.assets.find((a) => a.assetId === G5_R1_QUARANTINED_DEX_ID)!;
      const r1Card = parsedPub.cards.find((c) => c.id === G5_R1_QUARANTINED_DEX_ID)!;
      expect(r1Ev.exit).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", primaryRouteKey: null });
      expect(r1Ev.exit.reasons.length).toBeGreaterThan(0);
      expect(r1Card.pillars.exit).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", evidenceLevel: "insufficient" });
      expect(r1Card.breakdowns?.exit).toMatchObject({ evaluatedScore: null, primaryRoute: null });
      expect(r1Card.partialEvidence?.excludedPillars).toContain("exit");
      expect(parsedPub.cards.find((c) => c.id === G5_ANCHOR_ID)!.pillars.exit.score).toBeGreaterThan(0);
    }],
    ["R2: clockless disputed erratum propagates through peg-provenance enrichment into compiled fact set and card", () => {
      const { fullNormalized, pipeline, parsedPub } = g5;
      expect(fullNormalized.pegProvenanceById[G5_R2_ERRATUM_ID]).toMatchObject({
        classes: { "audit-excluded": { eventCount: 1 } },
        legacyInclusive: { result: { scoredEventCount: 0, excludedEventCount: 1, pegScore: 100 } },
      });
      expect(pipeline.fixedInput.pegProvenanceById[G5_R2_ERRATUM_ID]?.classes["audit-excluded"].eventCount).toBe(1);
      expect(pipeline.compiledFacts.assets.find((a) => a.assetId === G5_R2_ERRATUM_ID)!.peg).toMatchObject({
        status: { observationState: "known" }, pegScore: 100, activeDepeg: false,
      });
      expect(parsedPub.cards.find((c) => c.id === G5_R2_ERRATUM_ID)!.pegMultiplier).toBe(1);
    }],
    ["R3: dust DEX beside a reviewed suspended channel scores exit 0, not unknown", () => {
      const r3Ev = g5.pipeline.evaluatedSet.assets.find((a) => a.assetId === G5_R3_DUST_SUSPENDED_ID)!;
      expect(r3Ev.exit.score).toBe(0);
      expect(r3Ev.exit.reasons).toContain("no-viable-exit-path");
      expect(r3Ev.exit.routes.some((r) => r.routeSuspension !== undefined)).toBe(true);
    }],
    ["R4: foreign unreadable provider review isolates lane without quarantining asset", () => {
      expect(g5.pipeline.quarantines.some((q) => q.assetId === G5_R4_FOREIGN_PROVIDER_ID)).toBe(false);
      expect(g5.pipeline.bridgeJoinDiagnostics.find((d) => d.assetId === G5_R4_FOREIGN_PROVIDER_ID)?.incidentClosureFailures).toContainEqual(
        expect.objectContaining({ providerKey: "chainlink-ccip", code: "provider-incident-disclosures-unreadable", foreignAssetIds: ["zz-foreign-ccip"] }),
      );
    }],
    ["R5: accepted capture archive object round-trips through decodeSafetyScoreCaptureArchiveObject and recovers cards and delta", async () => {
      const { archive, parsedPub } = g5;
      expect(archive.archiveResult.status).toBe("written");
      expect(archive.key).toBe(safetyScoreCaptureArchiveKey(parsedPub.publishedAtSec, parsedPub.publicationGenerationId));
      const decoded = decodeSafetyScoreCaptureArchiveObject(archive.index, archive.bytes);
      expect(decoded).toMatchObject({
        schemaVersion: 1, generationId: parsedPub.publicationGenerationId, publishedAt: parsedPub.publishedAtSec,
        methodologyVersion: parsedPub.policyVersion, policyDigest: parsedPub.policy.semanticDigest,
        evaluationBuildDigest: parsedPub.evaluationBuildDigest,
        base: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY },
        delta: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY },
        cards: { key: SAFETY_SCORE_V9_CACHE_KEYS.publication },
      });
      expect(await parseSafetyScoreV9Publication(decoded.cards.value)).toEqual(parsedPub);
      const recoveredBase = await parseNativeV9InputCacheArtifact(decoded.base.value);
      expect(recoveredBase.input.baseInputGenerationId).toBe(parsedPub.baseInputGenerationId);
      const replayedDelta = await parseSafetyScoreV9PublicationReplayCapture(decoded.delta.value, recoveredBase.input);
      expect(replayedDelta.publicationGenerationId).toBe(parsedPub.publicationGenerationId);
      expect(replayedDelta.fixedInput.pegProvenanceById[G5_R2_ERRATUM_ID]?.classes["audit-excluded"].eventCount).toBe(1);
      expect(() => decodeSafetyScoreCaptureArchiveObject({ ...archive.index, object_sha256: "0".repeat(64) }, archive.bytes))
        .toThrow(/capture-archive-sha256-mismatch/);
      expect(() => decodeSafetyScoreCaptureArchiveObject({ ...archive.index, r2_key: "captures/safety-score-v9-accepted/wrong.json" }, archive.bytes))
        .toThrow(/capture-archive-index-identity-mismatch/);
    }],
  ] as const)("%s", async (_label, run) => { await run(); });
});
