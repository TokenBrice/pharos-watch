import { SAFETY_SCORE_COHORT_MAX_BYTES } from "@shared/types/safety-score-cohort";
import { describe, expect, it, vi } from "vitest";
import * as structuredLog from "../structured-log";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { admitAndSerializeSafetyScoreV9Publication, parseSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment";
import {
  buildSafetyScoreV9AcceptedBaselineProjection, buildSafetyScoreV9AcceptedProjections,
  buildSafetyScoreV9LenderCollateralProjection,
  parseSafetyScoreV9AcceptedBaselineProjection, parseSafetyScoreV9LenderCollateralProjection,
  serializeSafetyScoreV9AcceptedBaselineProjection, serializeSafetyScoreV9LenderCollateralProjection,
  SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES, SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
} from "../safety-score-v9/accepted-projections";

describe("Safety Score V9 accepted projection writers", () => {
  it("preserves the complete comparison baseline deeply and as canonical bytes", async () => {
    const { publication } = await admitAndSerializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication());
    const projection = buildSafetyScoreV9AcceptedBaselineProjection(publication);
    const expected = buildSafetyScoreV9AcceptedPublicationBaseline(publication);
    expect(projection.baseline).toEqual(expected);
    expect(stableJsonStringifyV1(projection.baseline)).toBe(stableJsonStringifyV1(expected));
    const value = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
    expect(parseSafetyScoreV9AcceptedBaselineProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
    expect(projection).toMatchObject({ publicationResultDigest: publication.resultDigest,
      safetyScoreIdentity: { publicationGenerationId: publication.publicationGenerationId },
      expectedCount: publication.cards.length });
  });

  it("retains every eligible card, canonical card SHA and stable local/foreign gaps with D > C > U precedence", () => {
    const cards = ["adverse", "curated", "unreferenced", "unknown"].map(id => makeWorkerV9Card({ id }));
    cards[0]!.pillars.backing.limitedEvidenceCauses = ["C", "D", "U"];
    cards[1]!.pillars.backing.limitedEvidenceCauses = ["C", "U"];
    cards[3]!.pillars.backing.limitedEvidenceCauses = ["U"];
    for (const card of cards) {
      card.localCauseGaps = ["z", "a"];
      card.foreignCauseGapRefs = [0, 1];
      card.pillars.backing.causeGapRefs = [0, 1, 2, 3];
    }
    const publication = makeWorkerSafetyScoreV9Publication({ cards,
      foreignCauseGaps: ["foreign:gap:a", "foreign:gap:z"] });
    const projection = buildSafetyScoreV9LenderCollateralProjection(publication);
    expect(Object.keys(projection.byAssetId)).toEqual(["adverse", "curated", "unknown", "unreferenced"]);
    expect(cards.map(card => projection.byAssetId[card.id]!.sourceCause)).toEqual(["D", "C", null, "U"]);
    for (const card of cards) {
      expect(projection.byAssetId[card.id]).toEqual({ assetId: card.id, backingScore: card.pillars.backing.score,
        cardSha256: sha256Hex(stableJsonStringifyV1(card)),
        sourceCause: projection.byAssetId[card.id]!.sourceCause,
        sourceGapIds: [`${card.id}:gap:a`, `${card.id}:gap:z`, "foreign:gap:a", "foreign:gap:z"].sort() });
    }
    const value = serializeSafetyScoreV9LenderCollateralProjection(projection);
    expect(parseSafetyScoreV9LenderCollateralProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
  });

  it.each(["not-rated", "pipeline-gap", "excluded", "null", "nan", "negative", "over-100", "C-empty", "U-empty"] as const)(
    "omits ineligible %s cards without inventing a zero score", scenario => {
      const card = makeWorkerV9Card();
      if (scenario === "not-rated" || scenario === "pipeline-gap") card.ratingStatus = scenario;
      if (scenario === "excluded") card.pillars.backing.aggregationDisposition = "excluded-a-b";
      if (scenario === "null") card.pillars.backing.score = null;
      if (scenario === "nan") card.pillars.backing.score = NaN;
      if (scenario === "negative") card.pillars.backing.score = -1;
      if (scenario === "over-100") card.pillars.backing.score = 101;
      if (scenario === "C-empty" || scenario === "U-empty") card.pillars.backing.limitedEvidenceCauses = [scenario === "C-empty" ? "C" : "U"];
      expect(buildSafetyScoreV9LenderCollateralProjection(makeWorkerSafetyScoreV9Publication({ cards: [card] })).byAssetId).toEqual({});
    },
  );

  it("hashes the admitted transformed card identically after publication transport round-trip", async () => {
    const input = makeWorkerSafetyScoreV9Publication();
    input.cards[0]!.pillars.backing.supportedComponentKeys = ["z-normalized", "a-normalized"];
    const { publication, stored } = await admitAndSerializeSafetyScoreV9Publication(input);
    expect(publication.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["a-normalized", "z-normalized"]);
    expect(input.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["z-normalized", "a-normalized"]);
    const decoded = await parseSafetyScoreV9Publication(stored);
    const written = buildSafetyScoreV9LenderCollateralProjection(publication);
    expect(written.byAssetId[publication.cards[0]!.id]!.cardSha256).toBe(sha256Hex(stableJsonStringifyV1(decoded.cards[0])));
    expect(buildSafetyScoreV9LenderCollateralProjection(decoded)).toEqual(written);
  });

  it.each(["baseline", "lender"] as const)("enforces %s canonical bytes, row clocks and inclusive UTF-8 byte cap", kind => {
    const publication = makeWorkerSafetyScoreV9Publication();
    if (kind === "baseline") {
      const projection = buildSafetyScoreV9AcceptedBaselineProjection(publication);
      const initial = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
      projection.baseline.dexGenerationId = "x".repeat(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES - Buffer.byteLength(initial) + 2);
      const value = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
      expect(Buffer.byteLength(value)).toBe(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
      expect(parseSafetyScoreV9AcceptedBaselineProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
      projection.baseline.dexGenerationId += "x";
      expect(() => serializeSafetyScoreV9AcceptedBaselineProjection(projection)).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: value + " ", updatedAt: publication.publishedAtSec })).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: initial + " ", updatedAt: publication.publishedAtSec })).toThrow(/canonical/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: initial, updatedAt: publication.publishedAtSec + 1 })).toThrow(/clock/);
    } else {
      const projection = buildSafetyScoreV9LenderCollateralProjection(publication);
      const initial = serializeSafetyScoreV9LenderCollateralProjection(projection);
      projection.byAssetId[publication.cards[0]!.id]!.sourceGapIds = ["x".repeat(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES - Buffer.byteLength(initial) - 2)];
      const value = serializeSafetyScoreV9LenderCollateralProjection(projection);
      expect(Buffer.byteLength(value)).toBe(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES);
      expect(parseSafetyScoreV9LenderCollateralProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
      projection.byAssetId[publication.cards[0]!.id]!.sourceGapIds[0] += "x";
      expect(() => serializeSafetyScoreV9LenderCollateralProjection(projection)).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: value + " ", updatedAt: publication.publishedAtSec })).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: initial + " ", updatedAt: publication.publishedAtSec })).toThrow(/canonical/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: initial, updatedAt: publication.publishedAtSec + 1 })).toThrow(/clock/);
    }
  });

  it("rejects invalid nested baseline identity, membership, clocks, scores and capacity", () => {
    const projection = buildSafetyScoreV9AcceptedBaselineProjection(makeWorkerSafetyScoreV9Publication());
    for (const mutate of [
      (value: typeof projection) => { value.baseline.policyDigest = "f".repeat(64); },
      (value: typeof projection) => { value.baseline.cards.push(value.baseline.cards[0]!); value.expectedCount++; },
      (value: typeof projection) => { value.asOfSec = value.publishedAtSec + 1; },
      (value: typeof projection) => { value.baseline.cards[0]!.score = Infinity; },
      (value: typeof projection) => { value.baseline.cards[0]!.primaryRouteCapacityUsd = -1; },
      (value: typeof projection) => { value.expectedCount++; },
    ]) {
      const invalid = structuredClone(projection);
      mutate(invalid);
      expect(() => serializeSafetyScoreV9AcceptedBaselineProjection(invalid)).toThrow();
    }
  });

  it("warns once before writing a projection above half its byte cap", () => {
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    try {
      // Card shape sets the per-row cost, so 1,400 accepted cards push the
      // baseline past half its 458,752-byte cap without crossing the cap itself.
      const cards = Array.from({ length: 1_400 }, (_, index) =>
        makeWorkerV9Card({ id: `fixture-bulk-${String(index).padStart(4, "0")}` }));
      const publication = makeWorkerSafetyScoreV9Publication({ cards });
      const projections = buildSafetyScoreV9AcceptedProjections(publication);
      const encoder = new TextEncoder();
      const cohortBytes = encoder.encode(projections.cohort).byteLength;
      const baselineBytes = encoder.encode(projections.baseline).byteLength;
      const lenderBytes = encoder.encode(projections.lender).byteLength;
      expect(baselineBytes).toBeGreaterThan(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES / 2);
      expect(baselineBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
      expect(lenderBytes).toBeLessThan(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES / 2);
      const warnings = logger.mock.calls.filter(([event]) => event.event === "safety_score_v9_accepted_projection_size_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toEqual({
        scope: "lib", level: "warn", event: "safety_score_v9_accepted_projection_size_warning",
        message: "Accepted Safety Score v9 projection exceeds half its byte cap",
        metadata: {
          cohortBytes, cohortMaxBytes: SAFETY_SCORE_COHORT_MAX_BYTES,
          baselineBytes, baselineMaxBytes: SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES,
          lenderBytes, lenderMaxBytes: SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
        },
      });
      expect(parseSafetyScoreV9AcceptedBaselineProjection({
        value: projections.baseline, updatedAt: publication.publishedAtSec,
      }).expectedCount).toBe(cards.length);
    } finally {
      logger.mockRestore();
    }
  });

  it("rejects a lender inventory larger than the accepted card count or keyed by another asset", () => {
    const projection = buildSafetyScoreV9LenderCollateralProjection(makeWorkerSafetyScoreV9Publication());
    const [assetId, row] = Object.entries(projection.byAssetId)[0]!;
    const overCount = structuredClone(projection);
    overCount.expectedCount = Object.keys(overCount.byAssetId).length - 1;
    expect(() => serializeSafetyScoreV9LenderCollateralProjection(overCount)).toThrow(/exceeds accepted card count/);
    const rekeyed = structuredClone(projection);
    delete rekeyed.byAssetId[assetId];
    rekeyed.byAssetId[`${assetId}-other`] = row;
    expect(() => serializeSafetyScoreV9LenderCollateralProjection(rekeyed)).toThrow(/key must match asset ID/);
  });

});
