import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerReportCardsV9Response } from "../../../test-helpers/report-cards-v9";

const mocks = vi.hoisted(() => ({
  loadActiveSafetyScoreSource: vi.fn(),
  buildFlightToQualityClassificationFromV9Snapshot: vi.fn(),
}));

vi.mock("../../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource,
}));
vi.mock("../../../lib/flight-to-quality-classification", () => ({
  buildFlightToQualityClassificationFromV9Snapshot:
    mocks.buildFlightToQualityClassificationFromV9Snapshot,
}));

const { computeDigestMintBurnFtqFlows } = await import("../mint-burn-ftq");

const db = {} as D1Database;
const COMPLETE = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;
const intensities = [
  { id: "usdt-tether", knownNetUsd: 40_000_000, valuation: COMPLETE },
  { id: "usdc-circle", knownNetUsd: -50_000_000, valuation: COMPLETE },
];

describe("digest mint/burn flight-to-quality flows", () => {
  beforeEach(() => {
    mocks.loadActiveSafetyScoreSource.mockReset();
    mocks.buildFlightToQualityClassificationFromV9Snapshot.mockReset();
  });

  function classify(safe: string[], risky: string[]) {
    const snapshot = makeWorkerReportCardsV9Response();
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
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

  it("splits flows across the canonical publication's safe and risky cohorts", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle"]);

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities),
    ).resolves.toEqual({
      kind: "ok",
      active: false,
      safeNet24h: 40_000_000,
      riskyNet24h: -50_000_000,
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("withholds FTQ when missing valuation could flip it", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle"]);
    // The risky outflow looks decisive, but unpriced risky mints of unknown size can
    // lift it above the -$100M threshold, so the activation itself is unproven.
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE },
      { id: "usdc-circle", knownNetUsd: -150_000_000, valuation: { ...COMPLETE, mintCompleteness: "partial" } },
    ])).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "valuation-incomplete",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("keeps a proven-inactive FTQ when unpriced mints can only raise a risky net", async () => {
    classify(["usdt-tether"], ["usdc-circle"]);
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE },
      { id: "usdc-circle", knownNetUsd: 10_000_000, valuation: { ...COMPLETE, mintCompleteness: "partial" } },
    ])).resolves.toMatchObject({ kind: "ok", active: false });
  });

  it("fails closed with zeroed flows when the canonical source is unavailable", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "missing",
      snapshot: null,
    });

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities),
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
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({
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
      computeDigestMintBurnFtqFlows(db, intensities),
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
    mocks.loadActiveSafetyScoreSource.mockRejectedValue(new Error("boom"));

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities),
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
