import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

import {
  guardPublishedYieldCoverage,
  summarizeYieldPublicationQualityMix,
} from "../coordinator-guards";
import { pruneYieldTables } from "../publication";
import { repairPublishedYieldGenerationFromCache } from "../publication-lifecycle";
import type { PreviousYieldPublicationSnapshot } from "../publication";

const GENERATION_START_SEC = 1_800_000_000;

function insertYieldGeneration(
  sqlite: DatabaseSync,
  generationId: string,
  state: string,
  startedAt: number,
  publishedAt: number | null,
) {
  sqlite
    .prepare(
      `INSERT INTO yield_publication_generations (
        generation_id, started_at, state, cache_key, ranking_updated_at, ranking_count,
        source_row_count, best_row_count, decision_count, metadata_json, created_at, published_at
      ) VALUES (?, ?, ?, 'yield-rankings', ?, 1, 1, 1, 1, '{}', ?, ?)`,
    )
    .run(generationId, startedAt, state, startedAt, startedAt, publishedAt);
}

describe("Yield publication generation lifecycle", () => {
  it("does not restamp published_at for a generation the cache already proves published", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite
        .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          "yield-rankings",
          JSON.stringify({
            publication: { generationId: "yield-100", status: "published", updatedAt: 100, cutoffAt: 100 },
          }),
          100,
        );
      insertYieldGeneration(sqlite, "yield-100", "published", 100, 100);

      await repairPublishedYieldGenerationFromCache(db, GENERATION_START_SEC);

      expect(
        sqlite
          .prepare("SELECT published_at FROM yield_publication_generations WHERE generation_id = ?")
          .get("yield-100"),
      ).toEqual({ published_at: 100 });
    } finally {
      sqlite.close();
    }
  });

  it("repairs a generation the cache proves published but the row did not", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite
        .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          "yield-rankings",
          JSON.stringify({
            publication: { generationId: "yield-200", status: "published", updatedAt: 200, cutoffAt: 200 },
          }),
          200,
        );
      insertYieldGeneration(sqlite, "yield-200", "staged", 200, null);

      await repairPublishedYieldGenerationFromCache(db, GENERATION_START_SEC);

      expect(
        sqlite
          .prepare("SELECT state, published_at FROM yield_publication_generations WHERE generation_id = ?")
          .get("yield-200"),
      ).toEqual({ state: "published", published_at: GENERATION_START_SEC });
    } finally {
      sqlite.close();
    }
  });

  it("finalizes generations abandoned mid-run and leaves a live staged one alone", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertYieldGeneration(sqlite, "yield-abandoned", "staged", GENERATION_START_SEC - 7200, null);
      insertYieldGeneration(sqlite, "yield-live", "staged", GENERATION_START_SEC - 60, null);

      await pruneYieldTables(db, GENERATION_START_SEC);

      expect(
        sqlite
          .prepare(
            "SELECT generation_id, state, failure_reason FROM yield_publication_generations ORDER BY generation_id",
          )
          .all(),
      ).toEqual([
        { generation_id: "yield-abandoned", state: "failed", failure_reason: "abandoned-staged" },
        { generation_id: "yield-live", state: "staged", failure_reason: null },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

function ranking(
  id: string,
  dataSource: string,
  confidenceTier: "deterministic" | "curated" | "discovered" | "fallback",
) {
  return { id, dataSource, provenance: { confidenceTier } };
}

function directRankings(count: number, prefix = "direct") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "protocol-api", "curated"));
}

function modeledRankings(count: number, prefix = "modeled") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "rate-derived", "deterministic"));
}

function discoveredRankings(count: number, prefix = "discovered") {
  return Array.from({ length: count }, (_, index) => ranking(`${prefix}-${index}`, "defillama-auto", "discovered"));
}

function previousSnapshot(
  rankings: readonly ReturnType<typeof ranking>[],
  status: PreviousYieldPublicationSnapshot["status"] = "ok",
): PreviousYieldPublicationSnapshot {
  return {
    status,
    rankings,
    malformed: status !== "missing" && status !== "ok",
  };
}

describe("Yield publication quality-mix guard", () => {
  it("classifies direct/curated separately from modeled and fallback rows", () => {
    expect(
      summarizeYieldPublicationQualityMix([
        ranking("onchain", "onchain", "deterministic"),
        ranking("curated", "protocol-api", "curated"),
        ranking("modeled", "rate-derived", "deterministic"),
        ranking("fallback", "price-derived", "fallback"),
        ranking("discovered", "defillama-auto", "discovered"),
      ]),
    ).toEqual({
      directCuratedCount: 2,
      fallbackModeledCount: 2,
      unclassifiedCount: 1,
      totalCount: 5,
    });
  });

  it("alarms on quality substitution without holding independent rows", async () => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(directRankings(10)),
      previewRankingsPayload: { rankings: [...directRankings(5), ...modeledRankings(5)] },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });
    expect(guarded.result).toBeNull();
    expect(guarded.qualityReasons).toContain("yield-publication:coverage-regression:total");
  });

  it("publishes 96 independent rows after losing all 57 opportunities", async () => {
    const tracked = directRankings(96);
    const opportunities = discoveredRankings(57);
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot([...tracked, ...opportunities]),
      previewRankingsPayload: { rankings: tracked },
      yieldCoinIdSet: new Set(tracked.map((row) => row.id)),
      opportunityCoinIdSet: new Set(opportunities.map((row) => row.id)),
    });
    expect(guarded.result).toBeNull();
    expect(guarded.currentPublishedRankingCount).toBe(96);
    expect(guarded.qualityReasons).toEqual(["yield-publication:coverage-regression:opportunity"]);
  });

  it.each([0, 3])("holds a total collapse below the hard floor (%s rows)", async (count) => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(directRankings(10)),
      previewRankingsPayload: { rankings: directRankings(count) },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
    });
    expect(guarded.result?.status).toBe("degraded");
    expect(JSON.parse(guarded.result!.metadata!)).toMatchObject({ reason: "rankings-payload-shrunk" });
  });

  it("holds unavailable common safety input even with valid rows", async () => {
    const guarded = await guardPublishedYieldCoverage({
      previousYieldPublicationSnapshot: previousSnapshot(directRankings(10)),
      previewRankingsPayload: { rankings: directRankings(10) },
      yieldCoinIdSet: new Set(),
      opportunityCoinIdSet: new Set(),
      inputDiagnostics: { safetySnapshotAvailable: false },
    });
    expect(JSON.parse(guarded.result!.metadata!)).toMatchObject({ reason: "safety-snapshot-unavailable" });
  });
});
