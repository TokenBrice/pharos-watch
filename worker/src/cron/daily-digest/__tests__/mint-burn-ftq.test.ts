import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerReportCardsV9Response } from "../../../test-helpers/report-cards-v9";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreIndex: vi.fn(),
  buildFlightToQualityClassificationFromV9Snapshot: vi.fn(),
}));

vi.mock("../../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: mocks.loadActiveSafetyScoreIndex,
}));
vi.mock("../../../lib/flight-to-quality-classification", () => ({
  buildFlightToQualityClassificationFromV9Snapshot:
    mocks.buildFlightToQualityClassificationFromV9Snapshot,
}));

const { computeDigestMintBurnFtqFlows } = await import("../mint-burn-ftq");

const db = {} as D1Database;
const COMPLETE = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;
const intensities = [
  { id: "usdt-tether", knownNetUsd: 40_000_000, valuation: COMPLETE, window24hComplete: true },
  { id: "usdc-circle", knownNetUsd: -50_000_000, valuation: COMPLETE, window24hComplete: true },
];
// swanUSD's only configured leg has no durable admission proof: outside the published scope.
const PENDING_ADMISSION = {
  legs: [{ stablecoinId: "swanusd-swan", status: "pending-admission" as const }],
};

describe("digest mint/burn flight-to-quality flows", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreIndex.mockReset();
    mocks.buildFlightToQualityClassificationFromV9Snapshot.mockReset();
  });

  function classify(safe: string[], risky: string[]) {
    const snapshot = makeWorkerReportCardsV9Response();
    mocks.loadActiveSafetyScoreIndex.mockResolvedValue({
      kind: "v9",
      snapshot,
    });
    mocks.buildFlightToQualityClassificationFromV9Snapshot.mockReturnValue({
      kind: "ok",
      classification: {
        safeIds: new Set(safe),
        riskyIds: new Set(risky),
        safetyScoreIdentity: snapshot.safetyScoreIdentity,
      },
    });
    return snapshot;
  }

  const complete = (id: string, knownNetUsd: number | null, window24hComplete: boolean | null = true) =>
    ({ id, knownNetUsd, valuation: COMPLETE, window24hComplete });
  const unpriced = (knownNetUsd: number | null) => ({
    ...complete("usdc-circle", knownNetUsd), valuation: { ...COMPLETE, mintCompleteness: "partial" as const },
  });
  const safe = (amount: number | null, window: boolean | null = true) => complete("usdt-tether", amount, window);
  const risky = (amount: number | null, window: boolean | null = true) => complete("usdc-circle", amount, window);

  it.each([
    { name: "splits flows across the canonical publication's safe and risky cohorts",
      flows: intensities, extraMember: false, publication: null, safeNet24h: 40_000_000, riskyNet24h: -50_000_000 },
    { name: "publishes the verdict when the only unpublished classified coin is pending admission",
      flows: [safe(150_000_000), risky(-20_000_000)], extraMember: true, publication: PENDING_ADMISSION,
      safeNet24h: 150_000_000, riskyNet24h: -20_000_000 },
    { name: "names the unpublished cohort member, not valuation, when no admission evidence excludes it",
      flows: [safe(150_000_000), risky(-150_000_000)], extraMember: true, publication: null,
      safeNet24h: 0, riskyNet24h: 0, reason: "cohort-member-unpublished" },
    { name: "keeps a proven-inactive verdict when an unbounded cohort member cannot reach the threshold",
      flows: [safe(10_000_000), risky(-20_000_000)], extraMember: true, publication: null,
      safeNet24h: 10_000_000, riskyNet24h: -20_000_000 },
    { name: "degrades when a coin's 24h flow window is unavailable",
      flows: [safe(null, false), risky(-150_000_000)], extraMember: false, publication: null,
      partialExpected: { kind: "unavailable", reason: "flow-window-unavailable" } },
    { name: "degrades when a withheld net comes from a publication with no window evidence",
      flows: [safe(150_000_000), risky(null, null)], extraMember: false, publication: null,
      partialExpected: { kind: "unavailable", reason: "flow-window-unavailable" } },
    { name: "leaves a complete-window net withheld for missing valuation to the bounded detector",
      flows: [safe(150_000_000), unpriced(null)], extraMember: false, publication: null,
      safeNet24h: 0, riskyNet24h: 0, reason: "valuation-incomplete" },
    { name: "keeps a proven-inactive FTQ when an unpriced complete-window coin cannot reach the threshold",
      flows: [safe(10_000_000), unpriced(null)], extraMember: false, publication: null,
      partialExpected: { kind: "ok", active: false } },
    { name: "withholds FTQ when missing valuation could flip it",
      flows: [safe(150_000_000), unpriced(-150_000_000)], extraMember: false, publication: null,
      safeNet24h: 0, riskyNet24h: 0, reason: "valuation-incomplete" },
    { name: "keeps a proven-inactive FTQ when unpriced mints can only raise a risky net",
      flows: [safe(150_000_000), unpriced(10_000_000)], extraMember: false, publication: null,
      partialExpected: { kind: "ok", active: false } },
  ])("$name", async (scenario) => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle", ...(scenario.extraMember ? ["swanusd-swan"] : [])]);
    const result = await computeDigestMintBurnFtqFlows(db, scenario.flows, scenario.publication);
    if (scenario.partialExpected) expect(result).toMatchObject(scenario.partialExpected);
    else expect(result).toEqual({
      kind: scenario.reason ? "unavailable" : "ok", active: false,
      safeNet24h: scenario.safeNet24h, riskyNet24h: scenario.riskyNet24h,
      ...(scenario.reason ? { reason: scenario.reason } : {}), safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("fails closed with zeroed flows when the canonical source is unavailable", async () => {
    mocks.loadActiveSafetyScoreIndex.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "missing",
      snapshot: null,
    });

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities, null),
    ).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "v9-snapshot-unavailable",
      safetyScoreIdentity: null,
    });
    expect(
      mocks.buildFlightToQualityClassificationFromV9Snapshot,
    ).not.toHaveBeenCalled();
  });

  it("fails closed while the canonical publication is held", async () => {
    const snapshot = makeWorkerReportCardsV9Response();
    mocks.loadActiveSafetyScoreIndex.mockResolvedValue({
      kind: "held",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot,
    });
    mocks.buildFlightToQualityClassificationFromV9Snapshot.mockReturnValue({
      kind: "unavailable",
      reason: "publication-held",
    });

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities, null),
    ).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "publication-held",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("fails closed when the canonical source read throws", async () => {
    mocks.loadActiveSafetyScoreIndex.mockRejectedValue(new Error("boom"));

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities, null),
    ).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "cache-read-failed",
      safetyScoreIdentity: null,
    });
  });
});
