import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import {
  normalizeSafetyScoreV9CompilerInput,
  withNormalizedV9JournalProjections,
} from "../safety-score-v9/native-input";
import { createRuntimeGapVerdict } from "../safety-score-v9/fact-set-context";

/**
 * The publication runner skips the full input re-normalization when
 * `prepareFixedInput` reports that it layered the journal projections onto the
 * already-normalized input (the production composition in
 * `computeSafetyScoreV9`). The compiler is a deterministic function of its
 * normalized input, so byte-identical normalized input is the equivalence the
 * shortcut needs; the journal projections must still be validated.
 */
describe("Safety Score V9 prepared-input normalization", () => {
  it("v10.01 preserves generation-bound reader proofs through journal-only preparation", () => {
    const base = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());
    const failure = createRuntimeGapVerdict({
      assetId: "alpha", scope: { pillar: "backing", componentKey: "reserve-composition",
        factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture-reserves", sourceGenerationId: "attempt:prepared-base",
      observedAtSec: base.clockSec, asOfSec: base.clockSec, producerState: "producer-failed",
      rejectionCode: "read-failed", reason: "The captured reader failed.",
    });
    const captured = normalizeSafetyScoreV9CompilerInput({
      ...base, baseInputGenerationId: undefined, pipelineGapByAssetId: { "alpha": [failure] },
    });
    const prepared = withNormalizedV9JournalProjections({ ...captured, evidenceJournalById: {} });
    expect(prepared.pipelineGapByAssetId).toEqual(captured.pipelineGapByAssetId);
    expect(prepared.baseInputGenerationId).toBe(captured.baseInputGenerationId);
    expect(prepared.baseInputGenerationId).not.toBe(base.baseInputGenerationId);
    expect(normalizeSafetyScoreV9CompilerInput(prepared)).toEqual(prepared);
  });
  it("yields byte-identical compiler input to the full re-normalization path", () => {
    const base = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());
    const prepared = {
      ...base,
      evidenceJournalById: { "alpha": [] },
      supplyAttributionJournalById: {},
    };

    const fullyRenormalized = normalizeSafetyScoreV9CompilerInput(prepared);
    const journalOnly = withNormalizedV9JournalProjections(prepared);

    expect(stableJsonStringifyV1(journalOnly)).toBe(stableJsonStringifyV1(fullyRenormalized));
    expect(journalOnly.baseInputGenerationId).toBe(base.baseInputGenerationId);
  });

  it("still rejects a malformed journal projection", () => {
    const base = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());

    expect(() =>
      withNormalizedV9JournalProjections({
        ...base,
        evidenceJournalById: { "alpha": [{ assetId: "alpha" }] } as never,
      }),
    ).toThrow();
  });

  it("applies the empty-journal default instead of dropping the projections", () => {
    const base = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());
    const withoutJournals = { ...base } as Record<string, unknown>;
    delete withoutJournals.evidenceJournalById;
    delete withoutJournals.supplyAttributionJournalById;

    const normalized = withNormalizedV9JournalProjections(withoutJournals as never);

    expect(normalized.evidenceJournalById).toEqual({});
    expect(normalized.supplyAttributionJournalById).toEqual({});
  });
});
