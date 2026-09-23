import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import {
  normalizeSafetyScoreV9CompilerInput,
  withNormalizedV9JournalProjections,
} from "../safety-score-v9/native-input";
import { buildSafetyScoreV9PublicationFromNormalizedInput } from "../safety-score-v9/candidate";

/**
 * The publication runner skips the full input re-normalization when
 * `prepareFixedInput` reports that it layered the journal projections onto the
 * already-normalized input (the production composition in
 * `computeSafetyScoreV9`). These cases pin the two properties that make the
 * shortcut legitimate: the normalized value and the published cards must stay
 * byte-identical to the full-normalization path, and the journal projections
 * must still be validated.
 */
describe("Safety Score V9 prepared-input normalization", () => {
  it("publishes byte-identical cards to the full re-normalization path", () => {
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

    const publish = (input: typeof journalOnly) => buildSafetyScoreV9PublicationFromNormalizedInput({
      fixedInput: input,
      publishedAtSec: base.clockSec,
      transferMaterialityGeneration: null,
    });
    const fromFullNormalization = publish(fullyRenormalized);
    const fromJournalOnly = publish(journalOnly);

    expect(stableJsonStringifyV1(fromJournalOnly.candidate))
      .toBe(stableJsonStringifyV1(fromFullNormalization.candidate));
    expect(fromJournalOnly.candidate.cards.length).toBe(fromFullNormalization.candidate.cards.length);
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
