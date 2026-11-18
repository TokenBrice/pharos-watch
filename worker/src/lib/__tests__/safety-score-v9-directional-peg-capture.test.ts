import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { computePegScore, computePremiumWeightedPegScore } from "@shared/lib/peg-score";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { DepegEvent } from "@shared/types/peg";
import type { PegSummaryCoin } from "@shared/types/peg";
import type * as SnapshotModule from "../report-cards-snapshot";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), peg: vi.fn(), dexGeneration: vi.fn() }));
vi.mock("../report-cards-snapshot-inputs", () => ({ loadReportCardsSnapshotInputs: mocks.inputs }));
vi.mock("../peg-analytics", () => ({ derivePegAnalyticsSnapshot: mocks.peg }));
vi.mock("../peg-analytics-cache", () => ({ publishPegAnalyticsCache: vi.fn(async () => true) }));
vi.mock("../report-card-evidence-journal-store", () => ({ loadReportCardEvidenceJournalByIdV1: vi.fn(async () => ({})) }));
vi.mock("../collateral-drift", () => ({ summarizeCollateralDriftFromLiveReserveMap: () => ({ fallbackCoins: [] }) }));
vi.mock("../report-cards-snapshot", async (original) => ({
  ...(await original<typeof SnapshotModule>()),
  loadExactDexPublicationGeneration: mocks.dexGeneration,
}));
import { buildNativeSafetyScoreV9Capture } from "./safety-score-v9-capture.test-support";

const CLOCK_SEC = Date.UTC(2026, 10, 16, 2) / 1000;
const ASSET_ID = "usdt-tether";
const DAY = 86_400;
const PREMIUM_WEIGHT = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegPremiumWeight;
const TRACKING_START_SEC = CLOCK_SEC - 1_400 * DAY;

function depegEvent(
  overrides: Partial<DepegEvent> & Pick<DepegEvent, "id" | "peakDeviationBps" | "startedAt" | "endedAt">,
): DepegEvent {
  return {
    stablecoinId: ASSET_ID,
    symbol: "USDT",
    pegType: "peggedUSD",
    direction: overrides.peakDeviationBps > 0 ? "above" : "below",
    startPrice: 1,
    peakPrice: 1,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    ...overrides,
  } as DepegEvent;
}

/** A synthetic event set: two audit-eligible opens, two audit-excluded opens, one closed event. */
function events(): DepegEvent[] {
  return [
    // Open premium (+1619) — the any-direction peak, but never a discount.
    depegEvent({ id: 1, peakDeviationBps: 1_619, startedAt: CLOCK_SEC - 3 * DAY, endedAt: null }),
    // Open discount (-1200) — the only audit-eligible below-peg open event.
    depegEvent({ id: 2, peakDeviationBps: -1_200, startedAt: CLOCK_SEC - 10 * DAY, endedAt: null }),
    // Audit-excluded opens must feed neither map, however large.
    depegEvent({ id: 3, peakDeviationBps: 3_000, startedAt: CLOCK_SEC - 20 * DAY, endedAt: null,
      provenance: { auditVerdict: "disputed", pegScoreEligible: false } }),
    depegEvent({ id: 4, peakDeviationBps: -5_000, startedAt: CLOCK_SEC - 30 * DAY, endedAt: null,
      provenance: { auditVerdict: "false_positive", pegScoreEligible: false } }),
    // Closed premium, so premium weighting changes the score.
    depegEvent({ id: 5, peakDeviationBps: 2_000, startedAt: CLOCK_SEC - 61 * DAY, endedAt: CLOCK_SEC - 30 * DAY }),
  ];
}

function pegRow(pegScore: number | null): PegSummaryCoin {
  return {
    id: ASSET_ID,
    symbol: "USDT",
    name: "Tether",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: -8,
    pegScore,
    pegPct: 99.9,
    severityScore: 99.9,
    spreadPenalty: 0,
    eventCount: 5,
    worstDeviationBps: -5_000,
    activeDepeg: true,
    lastEventAt: CLOCK_SEC - 3 * DAY,
    trackingSpanDays: 1_400,
    historyCoverage: { startedAt: TRACKING_START_SEC, source: "audited-replay", status: "verified" },
    methodologyVersion: "6.098",
  };
}

function loadCapture(pegDataById: Map<string, PegSummaryCoin>, eventsByCoin: Map<string, DepegEvent[]>, clockSec = CLOCK_SEC) {
  mocks.dexGeneration.mockResolvedValue({ generationId: `dex-liquidity-${clockSec}`, updatedAt: clockSec });
  mocks.inputs.mockResolvedValue({
    stablecoinsCached: { kind: "ok", updatedAt: clockSec, payload: { peggedAssets: [] } },
    dexLiquiditySnapshot: {
      latestUpdatedAt: clockSec,
      map: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, { methodologyVersion: "1.0" }])),
    },
    redemptionBackstopMap: {},
    redemptionSnapshotProvenance: { runId: undefined, latestUpdatedAt: undefined, methodologyVersion: undefined, runMetadata: {} },
    liveReserveMap: new Map(), liveReserveProvenanceMap: new Map(), liquidityStale: false, redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: clockSec, ageSeconds: 0, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    v9PublicationInputHealth: {
      dex: { state: "current" }, redemption: { state: "unavailable" }, liveReserves: { state: "unavailable", coverageRatio: null },
    },
  });
  mocks.peg.mockResolvedValue({ nowSec: clockSec, pegDataById, eventsByCoin });
  return buildNativeSafetyScoreV9Capture(mockD1());
}

/** A row whose public score is exactly what its event set computes at the captured anchor. */
function consistentPegData(captureEvents: DepegEvent[]) {
  const publicScore = computePegScore(captureEvents, TRACKING_START_SEC, CLOCK_SEC).pegScore;
  return {
    pegDataById: new Map([[ASSET_ID, pegRow(publicScore)]]),
    eventsByCoin: new Map([[ASSET_ID, captureEvents]]),
    publicScore,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Safety Score V9 directional peg capture", () => {
  it.each([
    { assetId: "mai-qidao", pegCurrency: "USD", pegType: "peggedUSD", peak: -1917, cap: 49 },
    { assetId: "eurs-stasis", pegCurrency: "EUR", pegType: "peggedEUR", peak: -1200, cap: null },
  ] as const)("carries only an established discount from capture to the cap for $assetId", async ({ assetId, pegCurrency, pegType, peak, cap }) => {
    const openEvent = depegEvent({
      id: cap === null ? 91050 : 90748,
      stablecoinId: assetId, pegType, peakDeviationBps: peak, endedAt: null,
      startedAt: cap === null ? Date.UTC(2026, 10, 14, 12) / 1000 : 1_785_190_593,
      priceCoverage: cap === null ? null : { intervals: [], lastObservationKind: "blind",
        lastTrustedObservationAt: null, gapStartedAt: 1_791_040_635 },
    });
    const score = computePegScore([openEvent], TRACKING_START_SEC, CLOCK_SEC, pegCurrency);
    const row = { ...pegRow(score.pegScore), ...score, id: assetId, pegCurrency, pegType };
    const { input } = await loadCapture(new Map([[assetId, row]]), new Map([[assetId, [openEvent]]]));
    const captured = input.safetyScoreV9DirectionalPeg!;
    expect(captured.activeDiscountPeakBpsById[assetId] ?? null).toBe(cap === null ? null : -peak);
    const fixed = makeV9FixedInput({
      assetId, clockSec: CLOCK_SEC, pegScore: score.pegScore, activeDepeg: score.activeDepeg,
      activeDepegPeakBps: input.activeDepegPeakBpsById[assetId], safetyScoreV9DirectionalPeg: captured,
    });
    const extension = makeV9Extension({ assetId, registryFingerprint: fixed.registryFingerprint, clockSec: CLOCK_SEC });
    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, extension), V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets[0]!.trace.caps.find((item) => item.source === "active-depeg")?.limit ?? null).toBe(cap);
  });

  it.each([true, false])("witnesses a same-second metals cap only with explicit admission (%s)", async (admitted) => {
    const clockSec = Date.UTC(2026, 10, 13, 22) / 1000;
    const assetId = "paxg-paxos";
    const point = depegEvent({ id: 1, stablecoinId: assetId, pegType: "peggedGOLD", startedAt: clockSec,
      endedAt: null, peakDeviationBps: -1500,
      ...(admitted ? { admittedCoverage: [{ fromSec: clockSec, toSec: clockSec + 1 }] }
        : { priceCoverage: { intervals: [[clockSec, clockSec]], lastTrustedObservationAt: clockSec, gapStartedAt: null } }),
    });
    const score = computePegScore([point], TRACKING_START_SEC, clockSec, "GOLD");
    const row = { ...pegRow(score.pegScore), ...score, id: assetId, pegCurrency: "GOLD", pegType: "peggedGOLD" };
    const { input } = await loadCapture(new Map([[assetId, row]]), new Map([[assetId, [point]]]), clockSec);
    const peak = admitted ? 1500 : undefined;
    expect(input.activeDepegPeakBpsById[assetId]).toBe(peak);
    expect(input.safetyScoreV9DirectionalPeg?.activeDiscountPeakBpsById[assetId]).toBe(peak);
    const fixed = makeV9FixedInput({ assetId, clockSec, pegScore: score.pegScore, activeDepeg: score.activeDepeg,
      activeDepegPeakBps: input.activeDepegPeakBpsById[assetId], safetyScoreV9DirectionalPeg: input.safetyScoreV9DirectionalPeg });
    const extension = makeV9Extension({ assetId, registryFingerprint: fixed.registryFingerprint, clockSec });
    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, extension), V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets[0]!.trace.caps.find((item) => item.source === "active-depeg")?.limit).toBe(admitted ? 49 : undefined);
  });

  it("splits the any-direction witness from the discount-only cap input", async () => {
    const captureEvents = events();
    const fixture = consistentPegData(captureEvents);
    const { input } = await loadCapture(fixture.pegDataById, fixture.eventsByCoin);

    // Audit-excluded opens (3000/5000 bps) are neither witnesses nor caps.
    expect(input.activeDepegPeakBpsById[ASSET_ID]).toBe(1_619);
    expect(input.safetyScoreV9DirectionalPeg).toBeDefined();
    const directionalPeg = input.safetyScoreV9DirectionalPeg!;
    expect(directionalPeg.premiumWeight).toBe(PREMIUM_WEIGHT);
    // The open premium appears only in the any-direction map.
    expect(directionalPeg.activeDiscountPeakBpsById[ASSET_ID]).toBe(1_200);
    expect(directionalPeg.pegScoreById[ASSET_ID]).toBe(
      computePremiumWeightedPegScore(captureEvents, TRACKING_START_SEC, CLOCK_SEC, PREMIUM_WEIGHT),
    );
    expect(directionalPeg.pegScoreById[ASSET_ID]).not.toBe(fixture.publicScore);
  });

  it("classifies a discount by sign only, never by the direction label", async () => {
    const captureEvents = [
      // bean-beanstalk precedent: "above" with a negative peak is a discount.
      depegEvent({ id: 1, direction: "above", peakDeviationBps: -900, startedAt: CLOCK_SEC - 2 * DAY, endedAt: null }),
      // "below" with a positive peak is a premium and must not cap.
      depegEvent({ id: 2, direction: "below", peakDeviationBps: 1_300, startedAt: CLOCK_SEC - 3 * DAY, endedAt: null }),
    ];
    const fixture = consistentPegData(captureEvents);
    const { input } = await loadCapture(fixture.pegDataById, fixture.eventsByCoin);

    expect(input.activeDepegPeakBpsById[ASSET_ID]).toBe(1_300);
    expect(input.safetyScoreV9DirectionalPeg!.activeDiscountPeakBpsById[ASSET_ID]).toBe(900);
  });

  it("maps an open premium only to a null discount entry", async () => {
    const captureEvents = [
      depegEvent({ id: 1, peakDeviationBps: 1_619, startedAt: CLOCK_SEC - 3 * DAY, endedAt: null }),
    ];
    const fixture = consistentPegData(captureEvents);
    const { input } = await loadCapture(fixture.pegDataById, fixture.eventsByCoin);

    expect(input.activeDepegPeakBpsById[ASSET_ID]).toBe(1_619);
    expect(input.safetyScoreV9DirectionalPeg!.activeDiscountPeakBpsById).toEqual({ [ASSET_ID]: null });
  });

  it("keys the discount map by every witness id, including assets outside the peg rows", async () => {
    // A configured-reference parent needs no scored peg row of its own, and a
    // premium-only asset still records the observed "no discount" as null.
    const captureEvents = [
      depegEvent({ id: 1, peakDeviationBps: -1_200, startedAt: CLOCK_SEC - 10 * DAY, endedAt: null }),
    ];
    const fixture = consistentPegData(captureEvents);
    const eventsByCoin = new Map(fixture.eventsByCoin);
    eventsByCoin.set("extra-parent", [
      depegEvent({ id: 2, stablecoinId: "extra-parent", peakDeviationBps: -800, startedAt: CLOCK_SEC - 5 * DAY, endedAt: null }),
    ]);
    eventsByCoin.set("extra-premium", [
      depegEvent({ id: 3, stablecoinId: "extra-premium", peakDeviationBps: 900, startedAt: CLOCK_SEC - 5 * DAY, endedAt: null }),
    ]);
    const { input } = await loadCapture(fixture.pegDataById, eventsByCoin);

    expect(input.activeDepegPeakBpsById).toEqual({ [ASSET_ID]: 1_200, "extra-parent": 800, "extra-premium": 900 });
    const discounts = input.safetyScoreV9DirectionalPeg!.activeDiscountPeakBpsById;
    expect(Object.keys(discounts).sort()).toEqual(Object.keys(input.activeDepegPeakBpsById).sort());
    expect(discounts).toEqual({ [ASSET_ID]: 1_200, "extra-parent": 800, "extra-premium": null });
    // The extra assets are not captured peg rows, so they carry no score entry.
    expect(Object.keys(input.safetyScoreV9DirectionalPeg!.pegScoreById)).toEqual([ASSET_ID]);
  });

  it("fails closed when the captured row does not reproduce the public score", async () => {
    const captureEvents = events();
    const tampered = new Map([[ASSET_ID, pegRow(42)]]);
    await expect(loadCapture(tampered, new Map([[ASSET_ID, captureEvents]]))).rejects.toThrow(
      /recomputes peg score .* the captured peg row reports 42/,
    );
  });
});
