import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import {
  buildReportCardsSnapshotFromFixedInput,
  normalizeFixedInput,
  serializeNormalizedReportCardsReplay,
} from "../report-cards-fixed-input";

function fixedInput() {
  return {
    schemaVersion: 1 as const,
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: "fixture-generation",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: 1_783_891_200,
    updatedAt: 1_783_891_200,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: 1_783_891_100, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: 1_783_891_000, ageSeconds: 200, stale: false },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {},
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: {
      "usdt-tether": true,
      "usdc-circle": true,
    },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  };
}

describe("fixed report-card input replay", () => {
  it("replays byte-stably without network, D1, or wall-clock reads", () => {
    const input = fixedInput();
    const first = serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input));
    const second = serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input));
    expect(first).toBe(second);
    expect(JSON.parse(first).cards.length).toBeGreaterThan(300);
  });

  it("normalizes equivalent record insertion orders", () => {
    const input = fixedInput();
    const permuted = {
      ...input,
      resolvedBlacklistStatuses: Object.fromEntries(Object.entries(input.resolvedBlacklistStatuses).reverse()),
    };
    expect(JSON.stringify(normalizeFixedInput(permuted))).toBe(JSON.stringify(normalizeFixedInput(input)));
    expect(serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(permuted))).toBe(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input)),
    );
  });

  it("rejects malformed inputs and unapproved methodology mismatches", () => {
    expect(() => buildReportCardsSnapshotFromFixedInput({ ...fixedInput(), clockSec: Number.NaN })).toThrow(
      "Malformed fixed report-card input",
    );
    const mismatched = { ...fixedInput(), methodologyVersion: "0.0" };
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched)).toThrow("does not match current");
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched, { allowMethodologyMismatch: true })).not.toThrow();
  });
});
