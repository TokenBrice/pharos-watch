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

  it("splits flows across the canonical publication's safe and risky cohorts", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle"]);

    await expect(
      computeDigestMintBurnFtqFlows(db, intensities, null),
    ).resolves.toEqual({
      kind: "ok",
      active: false,
      safeNet24h: 40_000_000,
      riskyNet24h: -50_000_000,
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("publishes the verdict when the only unpublished classified coin is pending admission", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle", "swanusd-swan"]);
    // The pending-admission coin is outside the published flow scope: excluding
    // it (and disclosing it) restores the observed, provably inactive verdict.
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: -20_000_000, valuation: COMPLETE, window24hComplete: true },
    ], PENDING_ADMISSION)).resolves.toEqual({
      kind: "ok",
      active: false,
      safeNet24h: 150_000_000,
      riskyNet24h: -20_000_000,
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("names the unpublished cohort member, not valuation, when no admission evidence excludes it", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle", "swanusd-swan"]);
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: -150_000_000, valuation: COMPLETE, window24hComplete: true },
    ], null)).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "cohort-member-unpublished",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("keeps a proven-inactive verdict when an unbounded cohort member cannot reach the threshold", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle", "swanusd-swan"]);
    // Without admission evidence the omitted risky coin stays unbounded, but the
    // safe bound is below +$100M, so no unbounded risky outflow can activate.
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 10_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: -20_000_000, valuation: COMPLETE, window24hComplete: true },
    ], null)).resolves.toEqual({
      kind: "ok",
      active: false,
      safeNet24h: 10_000_000,
      riskyNet24h: -20_000_000,
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("degrades when a coin's 24h flow window is unavailable", async () => {
    classify(["usdt-tether"], ["usdc-circle"]);
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: null, valuation: COMPLETE, window24hComplete: false },
      { id: "usdc-circle", knownNetUsd: -150_000_000, valuation: COMPLETE, window24hComplete: true },
    ], null)).resolves.toMatchObject({ kind: "unavailable", reason: "flow-window-unavailable" });
  });

  it("degrades when a withheld net comes from a publication with no window evidence", async () => {
    classify(["usdt-tether"], ["usdc-circle"]);
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: null, valuation: COMPLETE, window24hComplete: null },
    ], null)).resolves.toMatchObject({ kind: "unavailable", reason: "flow-window-unavailable" });
  });

  it("leaves a complete-window net withheld for missing valuation to the bounded detector", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle"]);
    // The unpriced risky coin could still carry the outflow past the threshold,
    // so the activation is unproven: a valuation quality finding, not a degrade.
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: null, valuation: { ...COMPLETE, mintCompleteness: "partial" }, window24hComplete: true },
    ], null)).resolves.toEqual({
      kind: "unavailable",
      active: false,
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "valuation-incomplete",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("keeps a proven-inactive FTQ when an unpriced complete-window coin cannot reach the threshold", async () => {
    classify(["usdt-tether"], ["usdc-circle"]);
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 10_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: null, valuation: { ...COMPLETE, mintCompleteness: "partial" }, window24hComplete: true },
    ], null)).resolves.toMatchObject({ kind: "ok", active: false });
  });

  it("withholds FTQ when missing valuation could flip it", async () => {
    const snapshot = classify(["usdt-tether"], ["usdc-circle"]);
    // The risky outflow looks decisive, but unpriced risky mints of unknown size can
    // lift it above the -$100M threshold, so the activation itself is unproven.
    await expect(computeDigestMintBurnFtqFlows(db, [
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: -150_000_000, valuation: { ...COMPLETE, mintCompleteness: "partial" }, window24hComplete: true },
    ], null)).resolves.toEqual({
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
      { id: "usdt-tether", knownNetUsd: 150_000_000, valuation: COMPLETE, window24hComplete: true },
      { id: "usdc-circle", knownNetUsd: 10_000_000, valuation: { ...COMPLETE, mintCompleteness: "partial" }, window24hComplete: true },
    ], null)).resolves.toMatchObject({ kind: "ok", active: false });
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
