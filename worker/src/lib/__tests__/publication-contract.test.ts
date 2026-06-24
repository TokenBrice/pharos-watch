import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadPublicationHealth } from "../publication-contract";

const NOW = 1_775_890_000;

function generationRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    generation_id: "generation-a",
    source_state: "published",
    started_at: NOW - 600,
    validated_at: null,
    published_at: NOW - 500,
    failed_at: null,
    candidate_rows: 10,
    published_rows: 10,
    expected_rows: 10,
    failure_reason: null,
    metadata_json: null,
    ...overrides,
  };
}

describe("loadPublicationHealth", () => {
  it("maps existing DEX and yield publication ledgers into shared surface health", async () => {
    const db = mockD1([
      {
        match: "FROM dex_liquidity_publication_generations\n        ORDER BY started_at DESC",
        rows: [],
        first: generationRow({
          generation_id: "dex-candidate",
          source_state: "staged",
          started_at: NOW - 1_200,
          published_at: null,
          candidate_rows: 400,
          published_rows: null,
          expected_rows: 407,
          metadata_json: JSON.stringify({
            inputWatermarks: {
              dexDiscovery: NOW - 2_000,
            },
          }),
        }),
      },
      {
        match: "FROM dex_liquidity_publication_generations\n        WHERE state = 'published'",
        rows: [],
        first: generationRow({
          generation_id: "dex-published",
          started_at: NOW - 3_600,
          published_at: NOW - 3_500,
          candidate_rows: 407,
          published_rows: 407,
          expected_rows: 407,
        }),
      },
      {
        match: "FROM dex_liquidity_publication_generations\n        WHERE state = 'failed'",
        rows: [],
        first: generationRow({
          generation_id: "dex-failed",
          source_state: "failed",
          started_at: NOW - 2_400,
          published_at: null,
          failed_at: NOW - 2_300,
          failure_reason: "candidate-row-count-mismatch",
        }),
      },
      {
        match: "FROM yield_publication_generations\n        ORDER BY started_at DESC",
        rows: [],
        first: generationRow({
          generation_id: "yield-failed",
          source_state: "failed",
          started_at: NOW - 900,
          published_at: null,
          failed_at: NOW - 880,
          candidate_rows: 120,
          published_rows: null,
          expected_rows: 118,
          failure_reason: "cache-newer-than-generation",
        }),
      },
      {
        match: "FROM yield_publication_generations\n        WHERE state = 'published'",
        rows: [],
        first: generationRow({
          generation_id: "yield-published",
          started_at: NOW - 7_200,
          published_at: NOW - 7_100,
          candidate_rows: 118,
          published_rows: 118,
          expected_rows: 118,
        }),
      },
      {
        match: "FROM yield_publication_generations\n        WHERE state = 'failed'",
        rows: [],
        first: generationRow({
          generation_id: "yield-failed",
          source_state: "failed",
          started_at: NOW - 900,
          published_at: null,
          failed_at: NOW - 880,
          failure_reason: "cache-newer-than-generation",
        }),
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.checkedAt).toBe(NOW);
    expect(health.surfaces["dex-liquidity"]).toMatchObject({
      sourceOfTruth: "dex_liquidity_publication_generations",
      candidateAgeSec: 1_200,
      lastFailureReason: "candidate-row-count-mismatch",
      dependencyWatermarks: {
        dexDiscovery: NOW - 2_000,
      },
      lastAttemptedGeneration: {
        generationId: "dex-candidate",
        sourceState: "staged",
        state: "candidate",
        candidateRows: 400,
        expectedRows: 407,
      },
      lastPublishedGeneration: {
        generationId: "dex-published",
        state: "published",
        publishedRows: 407,
      },
    });
    expect(health.surfaces["yield-rankings"]).toMatchObject({
      sourceOfTruth: "yield_publication_generations",
      candidateAgeSec: null,
      lastFailureReason: "cache-newer-than-generation",
      lastAttemptedGeneration: {
        generationId: "yield-failed",
        state: "failed",
        failureReason: "cache-newer-than-generation",
      },
      lastPublishedGeneration: {
        generationId: "yield-published",
        state: "published",
      },
    });
  });

  it("returns present surfaces with null generation details when ledgers are empty", async () => {
    const health = await loadPublicationHealth(mockD1(), NOW);

    expect(health.surfaces["dex-liquidity"]).toMatchObject({
      lastAttemptedGeneration: null,
      lastPublishedGeneration: null,
      lastFailureReason: null,
      candidateAgeSec: null,
    });
    expect(health.surfaces["yield-rankings"]).toMatchObject({
      lastAttemptedGeneration: null,
      lastPublishedGeneration: null,
      lastFailureReason: null,
      candidateAgeSec: null,
    });
  });
});
