import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import {
  normalizeSafetyScoreV9CompilerInput,
  withNormalizedV9JournalProjections,
} from "../safety-score-v9/native-input";

/**
 * The publication runner skips the full input re-normalization when
 * `prepareFixedInput` reports that it layered the journal projections onto the
 * already-normalized input (the production composition in
 * `computeSafetyScoreV9`). The compiler is a deterministic function of its
 * normalized input, so byte-identical normalized input is the equivalence the
 * shortcut needs; the journal projections must still be validated.
 */
describe("Safety Score V9 prepared-input normalization", () => {
  it("yields byte-identical compiler input to the full re-normalization path", () => {
    const base = normalizeSafetyScoreV9CompilerInput(createSafetyScoreV9FullRegistryInput());
    const prepared = {
      ...base,
      evidenceJournalById: { "usdc-circle": [] },
      supplyAttributionJournalById: {},
    };

    const fullyRenormalized = normalizeSafetyScoreV9CompilerInput(prepared);
    const journalOnly = withNormalizedV9JournalProjections(prepared);

    expect(stableJsonStringifyV1(journalOnly)).toBe(stableJsonStringifyV1(fullyRenormalized));
    expect(journalOnly.baseInputGenerationId).toBe(base.baseInputGenerationId);
  });

  it("still rejects a malformed journal projection", () => {
    const base = normalizeSafetyScoreV9CompilerInput(createSafetyScoreV9FullRegistryInput());

    expect(() =>
      withNormalizedV9JournalProjections({
        ...base,
        evidenceJournalById: { "usdc-circle": [{ assetId: "usdc-circle" }] } as never,
      }),
    ).toThrow();
  });

  it("applies the empty-journal default instead of dropping the projections", () => {
    const base = normalizeSafetyScoreV9CompilerInput(createSafetyScoreV9FullRegistryInput());
    const withoutJournals = { ...base } as Record<string, unknown>;
    delete withoutJournals.evidenceJournalById;
    delete withoutJournals.supplyAttributionJournalById;

    const normalized = withNormalizedV9JournalProjections(withoutJournals as never);

    expect(normalized.evidenceJournalById).toEqual({});
    expect(normalized.supplyAttributionJournalById).toEqual({});
  });
});
