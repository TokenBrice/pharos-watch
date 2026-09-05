import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";

import { type EvaluatedYieldSource } from "../yield-sync/evaluation";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  cleanupFalseLinkedVariantSourceSwitches,
  materializeYieldHistoryDaily,
  pruneYieldTables,
} from "../yield-sync/publication";
import type { PreviousYieldPublicationSnapshot } from "../yield-sync/publication";
import { publishYieldCoordinatorResults } from "../yield-sync/coordinator-persist";
import { publishYieldRowsAtomically } from "../yield-sync/publication-atomic-batch";
import {
  FIXED_NOW,
  buildPayloadWithObservedAt,
  makeBenchmarkMeta,
  makeEvaluatedSource,
  makePublicationViews,
  makeSafetySnapshotMeta,
  makeYieldSourceMeta,
  mockD1,
} from "./yield-publication.test-support";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../test-helpers/migration-fixtures");
const FIXTURES_DIR = path.resolve(__dirname, "../../test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = path.join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : path.join(MIGRATIONS_DIR, file);
}


describe("publishYieldCoordinatorResults", () => {
  function parseJsonBind<T>(entry: { binds: unknown[] } | undefined, index = 0): T {
    return JSON.parse(String(entry?.binds[index] ?? "[]")) as T;
  }

  function makePublicationDb(
    cacheWriteChanges: number,
    options?: { cacheWriteError?: Error; finalizeError?: Error; finalizeDelayMs?: number },
  ) {
    return mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["yield-rankings"], rows: [], first: null },
      { match: "INSERT OR REPLACE INTO yield_publication_generations", rows: [] },
      { match: "INSERT OR REPLACE INTO yield_data", rows: [] },
      { match: "INSERT OR IGNORE INTO yield_history", rows: [] },
      { match: "INSERT OR REPLACE INTO yield_source_decisions", rows: [] },
      { match: "INSERT OR REPLACE INTO yield_source_decision_alternatives", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: cacheWriteChanges },
        throwError: options?.cacheWriteError,
      },
      {
        match: "UPDATE yield_publication_generations",
        rows: [],
        throwError: options?.finalizeError,
        delayMs: options?.finalizeDelayMs,
      },
      { match: "UPDATE yield_data SET publication_state", rows: [] },
      { match: "UPDATE yield_history SET publication_state", rows: [] },
      { match: "DELETE FROM yield_history", rows: [] },
      { match: "DELETE FROM yield_source_decisions", rows: [] },
      { match: "DELETE FROM yield_source_decision_alternatives", rows: [] },
      { match: "pharos:yield-sync:daily-history-materialize", rows: [] },
      { match: "pharos:yield-sync:stale-yield-data-delete", rows: [] },
      { match: "pharos:yield-sync:yield-data-existing-ids", rows: [], first: null },
      { match: "pharos:yield-sync:orphan-yield-data-delete", rows: [] },
      { match: "pharos:yield-sync:history-retention-delete", rows: [] },
      { match: "pharos:yield-sync:daily-history-retention-delete", rows: [] },
      { match: "pharos:yield-sync:decision-retention-delete", rows: [] },
      { match: "ranked_linked_generations", rows: [] },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: cacheWriteChanges } },
    ]);
  }

  function makePublishParams(overrides: {
    db: D1Database;
    signal?: AbortSignal;
    previewRankingsPayload?: ReturnType<typeof buildPayloadWithObservedAt>;
    evaluatedSources?: EvaluatedYieldSource[];
    bestSourceKeyByCoin?: Map<string, string>;
    degradationReasons?: string[];
    previousYieldPublicationSnapshot?: PreviousYieldPublicationSnapshot;
  }) {
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const source = makeEvaluatedSource();
    const evaluatedSources = overrides.evaluatedSources ?? [source];
    return {
      db: overrides.db,
      signal: overrides.signal,
      previewRankingsPayload: overrides.previewRankingsPayload ?? buildPayloadWithObservedAt(startSec),
      evaluatedSources,
      publicationViews: makePublicationViews(
        evaluatedSources,
        overrides.bestSourceKeyByCoin ?? new Map([[source.id, source.sourceKey]]),
        startSec,
      ),
      startSec,
      degradationReasons: overrides.degradationReasons ?? [],
      resolvedCount: 1,
      rowsRejected: 0,
      divergenceFlags: 0,
      sourceSwitches: 0,
      previousYieldPublicationSnapshot: overrides.previousYieldPublicationSnapshot ?? {
        status: "missing",
        rankings: [],
        malformed: false,
      },
    };
  }

  it("stages then fails a generation when cache payload validation fails before row publication", async () => {
    const db = makePublicationDb(1);
    const payload = buildPayloadWithObservedAt(Math.floor(FIXED_NOW.getTime() / 1000));
    payload.rankings = [
      payload.rankings[0]!,
      {
        ...payload.rankings[0]!,
        yieldSource: "Duplicate Source",
      },
    ];

    const result = await publishYieldCoordinatorResults(makePublishParams({ db, previewRankingsPayload: payload }));

    expect(result.ok).toBe(false);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_publication_generations"))).toBe(
      true,
    );
    expect(history.some((entry) => entry.sql.includes("SET state = 'failed'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"))).toBe(false);
  });

  it("does not replace published D1 rows when the rankings cache CAS skips because a newer cache exists", async () => {
    const db = makePublicationDb(0);

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result).toMatchObject({
      ok: true,
      cacheWriteSkipped: true,
      casSkipped: true,
    });
    const history = db.getHistory();
    const yieldDataInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"));
    const yieldHistoryInsert = history.find((entry) => entry.sql.includes("INSERT OR IGNORE INTO yield_history"));
    const decisionInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_source_decisions"));
    expect(yieldDataInsert?.sql).toContain("(SELECT updated_at FROM cache WHERE key = 'yield-rankings') = ?");
    expect(yieldHistoryInsert?.sql).toContain("(SELECT updated_at FROM cache WHERE key = 'yield-rankings') = ?");
    expect(decisionInsert?.sql).toContain("(SELECT updated_at FROM cache WHERE key = 'yield-rankings') = ?");
    const rows = parseJsonBind<Array<{ publication_state: string }>>(yieldDataInsert);
    expect(rows[0]?.publication_state).toBe("published");
    expect(history.some((entry) => entry.sql.includes("SET state = 'failed'"))).toBe(true);
    expect(
      history.some(
        (entry) => entry.sql.includes("UPDATE yield_history SET publication_state = ?") && entry.binds[0] === "failed",
      ),
    ).toBe(true);
  });

  it("returns degraded when the atomic publication transaction throws", async () => {
    const db = makePublicationDb(1, { cacheWriteError: new Error("D1 queue overloaded") });

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const metadata = JSON.parse(result.result.metadata ?? "{}") as { reason?: string; publishFailure?: string };
      expect(metadata.reason).toBe("yield-publication-transaction-failed");
      expect(metadata.publishFailure ?? "").toContain("D1 queue overloaded");
    }

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO cache (key, value, updated_at)"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("SET state = 'failed'"))).toBe(true);
    expect(
      history.some(
        (entry) => entry.sql.includes("UPDATE yield_data SET publication_state = ?") && entry.binds[0] === "failed",
      ),
    ).toBe(true);
  });

  it("returns degraded when atomic publication finalization fails", async () => {
    const db = makePublicationDb(1, { finalizeError: new Error("database locked") });

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const metadata = JSON.parse(result.result.metadata ?? "{}") as { reason?: string; publishFailure?: string };
      expect(metadata.reason).toBe("yield-publication-transaction-failed");
      expect(metadata.publishFailure ?? "").toContain("database locked");
    }
    const history = db.getHistory();
    const yieldDataInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"));
    const rows = parseJsonBind<Array<{ publication_state: string }>>(yieldDataInsert);
    expect(rows[0]?.publication_state).toBe("published");
  });

  it("writes bounded selected-source decision evidence with rejected-source reasons", async () => {
    const db = makePublicationDb(1);
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      currentApy: 5,
      apy30d: 5,
      pharosYieldScore: 35,
      confidenceTier: "curated",
    });
    const rejected = makeEvaluatedSource({
      sourceKey: `defillama-auto:${"x".repeat(800)}`,
      currentApy: 11,
      apy30d: 10,
      pharosYieldScore: 60,
      confidenceTier: "discovered",
      dataSource: "defillama-auto",
      rejected: true,
      anomalies: [
        "diverges-from-canonical",
        ...Array.from({ length: 19 }, (_, index) => `diagnostic-${index}-${"y".repeat(120)}`),
      ],
    });
    const retained = makeEvaluatedSource({
      sourceKey: "price-derived:backup",
      currentApy: 4,
      apy30d: 4,
      pharosYieldScore: 20,
      confidenceTier: "fallback",
      dataSource: "price-derived",
    });

    const result = await publishYieldCoordinatorResults(
      makePublishParams({
        db,
        evaluatedSources: [best, rejected, retained],
        bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
      }),
    );

    expect(result).toMatchObject({ ok: true });
    const decisionInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_source_decisions"));
    const decisionRows = parseJsonBind<Array<{ alternatives_json: string }>>(decisionInsert);
    const alternativesJson = decisionRows[0]?.alternatives_json ?? "";
    expect(new TextEncoder().encode(alternativesJson).length).toBeLessThanOrEqual(4096);
    const alternatives = JSON.parse(alternativesJson) as Array<{ reason?: string; anomalies?: string[] }>;
    expect(
      alternatives.some((alternative) => alternative.reason === "rejected: divergent lower-confidence source"),
    ).toBe(true);
    expect(alternatives.every((alternative) => (alternative.anomalies?.length ?? 0) <= 6)).toBe(true);
  });

  it("publishes generation metadata to cache and current/history rows on a successful generation", async () => {
    const db = makePublicationDb(1);

    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));

    expect(result).toMatchObject({
      ok: true,
      cacheWriteSkipped: false,
      casSkipped: false,
    });
    const history = db.getHistory();
    const yieldDataInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"));
    const yieldHistoryInsert = history.find((entry) => entry.sql.includes("INSERT OR IGNORE INTO yield_history"));
    const cacheWrite = history.find((entry) => entry.sql.includes("INSERT INTO cache (key, value, updated_at)"));
    const yieldRows =
      parseJsonBind<Array<{ publication_generation_id: string; publication_state: string }>>(yieldDataInsert);
    const historyRows =
      parseJsonBind<Array<{ publication_generation_id: string; publication_state: string }>>(yieldHistoryInsert);
    expect(yieldRows[0]).toMatchObject({
      publication_generation_id: "yield-1774526400",
      publication_state: "published",
    });
    expect(historyRows[0]).toMatchObject({
      publication_generation_id: "yield-1774526400",
      publication_state: "published",
    });
    expect(cacheWrite?.binds[0]).toBe("yield-rankings");
    expect(history.findIndex((entry) => entry === cacheWrite)).toBeLessThan(
      history.findIndex((entry) => entry === yieldDataInsert),
    );
    expect(JSON.parse(String(cacheWrite?.binds[1]))).toMatchObject({
      publication: {
        generationId: "yield-1774526400",
        status: "published",
        cutoffAt: 1774526400,
      },
      rankings: [
        {
          publicationGenerationId: "yield-1774526400",
          publishedRank: 1,
        },
      ],
    });
    expect(history.some((entry) => entry.sql.includes("SET state = 'published'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("UPDATE yield_data SET publication_state = ?"))).toBe(false);
  });

  it("does not publish the freshness sentinel when the cron signal aborts after row publication", async () => {
    const db = makePublicationDb(1, { finalizeDelayMs: 20 });
    const controller = new AbortController();

    const resultPromise = publishYieldCoordinatorResults(makePublishParams({ db, signal: controller.signal }));
    setTimeout(() => controller.abort(new Error("cron timeout")), 0);

    await expect(resultPromise).rejects.toThrow("cron timeout");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_data"))).toBe(true);
    expect(history.some((entry) => entry.binds[0] === "freshness:yield-data")).toBe(false);
    expect(history.some((entry) => entry.sql.includes("pharos:yield-sync:history-retention-delete"))).toBe(false);
  });

  it("runs ownership handoff cleanup only after successful non-degraded publication cleanup", async () => {
    const db = makePublicationDb(1);
    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));
    expect(result).toMatchObject({ ok: true, degradationReasons: [] });

    const history = db.getHistory();
    const cacheWriteIndex = history.findIndex((entry) =>
      entry.sql.includes("INSERT INTO cache (key, value, updated_at)"),
    );
    const freshnessIndex = history.findIndex((entry) => entry.binds[0] === "freshness:yield-data");
    const historyRetentionIndex = history.findIndex((entry) =>
      entry.sql.includes("pharos:yield-sync:history-retention-delete"),
    );
    const handoffCleanupIndex = history.findIndex((entry) =>
      entry.sql.includes("pharos:yield-sync:ownership-handoff-delete"),
    );
    expect(cacheWriteIndex).toBeGreaterThanOrEqual(0);
    expect(freshnessIndex).toBeGreaterThan(cacheWriteIndex);
    expect(historyRetentionIndex).toBeGreaterThan(freshnessIndex);
    expect(history[historyRetentionIndex]?.binds[0]).toBe(
      Math.floor(FIXED_NOW.getTime() / 1000) - YIELD_HISTORY_MAX_DAYS * DAY_SECONDS,
    );
    expect(handoffCleanupIndex).toBeGreaterThan(historyRetentionIndex);

    const degradedDb = makePublicationDb(1);
    const degradedResult = await publishYieldCoordinatorResults(
      makePublishParams({
        db: degradedDb,
        degradationReasons: ["safety-snapshot-degraded"],
      }),
    );
    expect(degradedResult).toMatchObject({ ok: true, degradationReasons: ["safety-snapshot-degraded"] });
    expect(
      degradedDb.getHistory().some((entry) => entry.sql.includes("pharos:yield-sync:ownership-handoff-delete")),
    ).toBe(false);
  });

  it("emits a bounded public decisionLedger on the published rankings payload and persists alternatives + retention reason", async () => {
    const db = makePublicationDb(1);
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      currentApy: 5,
      apy30d: 5,
      pharosYieldScore: 35,
      confidenceTier: "curated",
      previousBestSourceKey: "price-derived:legacy",
    });
    const altA = makeEvaluatedSource({
      sourceKey: "defillama-auto:alt-a",
      currentApy: 4,
      apy30d: 3,
      pharosYieldScore: 25,
      confidenceTier: "discovered",
      dataSource: "defillama-auto",
    });
    const altB = makeEvaluatedSource({
      sourceKey: "price-derived:alt-b",
      currentApy: 2,
      apy30d: 2,
      pharosYieldScore: 10,
      confidenceTier: "fallback",
      dataSource: "price-derived",
    });
    const altC = makeEvaluatedSource({
      sourceKey: "defillama-auto:alt-c",
      currentApy: 4.5,
      apy30d: 4.8,
      pharosYieldScore: 22,
      confidenceTier: "discovered",
      dataSource: "defillama-auto",
    });

    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const previewRankingsPayload = buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: [best, altA, altB, altC],
      publicationViews: makePublicationViews(
        [best, altA, altB, altC],
        new Map([[best.id, best.sourceKey]]),
        startSec,
      ),
      rankingProvenanceByKey: new Map(),
      riskFreeRate: makeBenchmarkMeta().rate,
      riskFreeRateMeta: makeBenchmarkMeta(),
      riskFreeRateRegistry: { USD: makeBenchmarkMeta(), EUR: null, CHF: null },
      dlPoolsMeta: makeYieldSourceMeta(),
      safetySnapshot: makeSafetySnapshotMeta(),
      medianApy: 4.5,
      startSec,
    });

    expect(previewRankingsPayload.rankings[0]?.decisionLedger).toBeTruthy();
    const previewLedger = previewRankingsPayload.rankings[0]?.decisionLedger;
    expect(previewLedger?.selectedReasonCode).toMatch(
      /^(best-by-confidence-and-apy|deterministic-preferred|curated-over-discovered|tier-preference|tvl-floor|freshness-tiebreaker|fallback|no-alternatives)$/,
    );
    expect(previewLedger?.alternatives.length).toBeLessThanOrEqual(2);
    expect(previewLedger?.sourceSwitch).toBe(true);

    const result = await publishYieldCoordinatorResults(
      makePublishParams({
        db,
        previewRankingsPayload,
        evaluatedSources: [best, altA, altB, altC],
        bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
      }),
    );
    expect(result).toMatchObject({ ok: true });

    const history = db.getHistory();
    const cacheWrite = history.find((entry) => entry.sql.includes("INSERT INTO cache (key, value, updated_at)"));
    const cacheBody = JSON.parse(String(cacheWrite?.binds[1])) as {
      rankings: Array<{ decisionLedger?: Record<string, unknown> }>;
    };
    expect(cacheBody.rankings[0]?.decisionLedger).toBeTruthy();
    expect((cacheBody.rankings[0]?.decisionLedger?.alternatives as unknown[])?.length).toBeLessThanOrEqual(2);

    const decisionInsert = history.find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_source_decisions"));
    const decisionRows = parseJsonBind<Array<{ retention_reason: string }>>(decisionInsert);
    expect(decisionRows[0]?.retention_reason).toBe("trend");

    const alternativesInsert = history.find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO yield_source_decision_alternatives"),
    );
    const alternativeRows = parseJsonBind<
      Array<{
        alt_source_key: string;
        rejection_reason_code: string;
      }>
    >(alternativesInsert);
    expect(alternativeRows.length).toBeLessThanOrEqual(2);
    expect(alternativeRows.length).toBeGreaterThan(0);
    for (const row of alternativeRows) {
      expect(["thinner", "stale", "lower-confidence", "rewards-only", "smaller", "unspecified"]).toContain(
        row.rejection_reason_code,
      );
    }

    // The total decisionLedger size on the row must stay well under 1 KB.
    const ledgerBytes = new TextEncoder().encode(JSON.stringify(cacheBody.rankings[0]?.decisionLedger)).length;
    expect(ledgerBytes).toBeLessThan(1024);
  });

  it("persists exactly reproducible PYS inputs on yield_history rows", async () => {
    const db = makePublicationDb(1);
    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));
    expect(result).toMatchObject({ ok: true });

    const history = db.getHistory();
    const yieldHistoryInsert = history.find((entry) => entry.sql.includes("INSERT OR IGNORE INTO yield_history"));
    expect(yieldHistoryInsert?.sql).toContain("pys_at_publish");
    expect(yieldHistoryInsert?.sql).toContain("safety_at_publish");
    expect(yieldHistoryInsert?.sql).toContain("variance_at_publish");
    expect(yieldHistoryInsert?.sql).toContain("pys_inputs_at_publish");
    const historyRows = parseJsonBind<
      Array<{
        pys_at_publish: number | null;
        safety_at_publish: number | null;
        variance_at_publish: number | null;
        pys_inputs_at_publish: string;
      }>
    >(yieldHistoryInsert);
    expect(historyRows[0]?.pys_at_publish).toBe(28);
    expect(historyRows[0]?.safety_at_publish).toBe(82);
    expect(historyRows[0]?.variance_at_publish).toBe(0.2);
    expect(JSON.parse(historyRows[0]?.pys_inputs_at_publish ?? "null")).toMatchObject({
      schemaVersion: 1,
      apy30d: 4.6,
      safetyScore: 82,
      varianceScore: 0.1,
      benchmarkRate: 4.2,
      sourceRiskPenalty: 1,
      scoreQualification: "rated",
      benchmarkKey: "USD",
      evidenceClass: "curated-observation",
    });
  });

  it("classifies retention_reason as 'audit' when no switch, no anomalies, and no rejected higher-confidence source", async () => {
    const db = makePublicationDb(1);
    const result = await publishYieldCoordinatorResults(makePublishParams({ db }));
    expect(result).toMatchObject({ ok: true });

    const decisionInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_source_decisions"));
    const decisionRows = parseJsonBind<Array<{ retention_reason: string }>>(decisionInsert);
    expect(decisionRows[0]?.retention_reason).toBe("audit");
  });

  it("classifies anomaly evidence as an episode candidate with a stable fingerprint", async () => {
    const db = makePublicationDb(1);
    const best = makeEvaluatedSource({
      sourceKey: "defillama:best",
      currentApy: 5,
      apy30d: 5,
      pharosYieldScore: 35,
      confidenceTier: "curated",
    });
    const rejected = makeEvaluatedSource({
      sourceKey: "defillama-auto:rejected",
      currentApy: 9,
      apy30d: 8,
      pharosYieldScore: 45,
      confidenceTier: "discovered",
      dataSource: "defillama-auto",
      rejected: true,
      anomalies: ["diverges-from-canonical"],
    });

    const result = await publishYieldCoordinatorResults(
      makePublishParams({
        db,
        evaluatedSources: [best, rejected],
        bestSourceKeyByCoin: new Map([[best.id, best.sourceKey]]),
      }),
    );
    expect(result).toMatchObject({ ok: true });

    const decisionInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO yield_source_decisions"));
    const decisionRows = parseJsonBind<Array<{ retention_reason: string; trend_fingerprint: string }>>(decisionInsert);
    expect(decisionRows[0]?.retention_reason).toBe("episode");
    expect(JSON.parse(decisionRows[0]?.trend_fingerprint ?? "null")).toMatchObject({
      selectedSourceKey: best.sourceKey,
      evidence: [{ sourceKey: rejected.sourceKey, anomalies: ["diverges-from-canonical"] }],
    });
  });
});

describe("pruneYieldTables", () => {
  it("retries transient retention overload without dropping cleanup", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const prepare = db.prepare.bind(db);
    let retentionAttempts = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("pharos:yield-sync:daily-history-retention-delete") && ++retentionAttempts === 1) {
        throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
      }
      return prepare(sql);
    });
    try {
      await pruneYieldTables(db, Math.floor(FIXED_NOW.getTime() / 1000));
      expect(retentionAttempts).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("surfaces a missing mandatory daily-history table during materialization", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.exec("DROP TABLE yield_history_daily");
      await expect(
        materializeYieldHistoryDaily(db, Math.floor(FIXED_NOW.getTime() / 1000)),
      ).rejects.toThrow("no such table: yield_history_daily");
    } finally {
      sqlite.close();
    }
  });

  it("surfaces a missing mandatory decision column during cleanup", async () => {
    const db = mockD1([
      {
        match: "ranked_linked_generations",
        rows: [],
        throwError: new Error("D1_ERROR: no such column: retention_reason"),
      },
    ]);

    await expect(cleanupFalseLinkedVariantSourceSwitches(db)).rejects.toThrow(
      "D1_ERROR: no such column: retention_reason",
    );
  });

  it("surfaces a missing mandatory daily-history table during retention", async () => {
    const db = mockD1([
      {
        match: "pharos:yield-sync:daily-history-retention-delete",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: yield_history_daily"),
      },
    ]);

    await expect(
      pruneYieldTables(db, Math.floor(FIXED_NOW.getTime() / 1000), { allowDestructiveCleanup: false }),
    ).rejects.toThrow("D1_ERROR: no such table: yield_history_daily");
  });

  it("materializes the last published source point for the daily history tier", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const snapshotDate = Math.floor((startSec - 31 * DAY_SECONDS) / DAY_SECONDS) * DAY_SECONDS;
    try {
      const insert = sqlite.prepare(
        `INSERT INTO yield_history (
          stablecoin_id, source_key, recorded_at, is_best, apy, data_source, publication_state
        ) VALUES ('coin-a', 'source-a', ?, 1, ?, 'test', 'published')`,
      );
      insert.run(snapshotDate + 60, 4.1);
      insert.run(snapshotDate + 3_600, 4.4);

      await expect(materializeYieldHistoryDaily(db, startSec)).resolves.toBe(1);
      expect(
        sqlite
          .prepare(
            `SELECT snapshot_date, recorded_at, apy
               FROM yield_history_daily
              WHERE stablecoin_id = 'coin-a' AND source_key = 'source-a'`,
          )
          .get(),
      ).toEqual({ snapshot_date: snapshotDate, recorded_at: snapshotDate + 3_600, apy: 4.4 });
    } finally {
      sqlite.close();
    }
  });

  it("reclassifies false linked switches only after two clean published generations", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE yield_publication_generations (
          generation_id TEXT PRIMARY KEY,
          state TEXT NOT NULL
        );
        CREATE TABLE yield_source_decisions (
          generation_id TEXT NOT NULL,
          stablecoin_id TEXT NOT NULL,
          selected_source_key TEXT NOT NULL,
          previous_best_source_key TEXT,
          source_switch INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          retention_reason TEXT
        );
      `);
      const generation = sqlite.prepare(
        "INSERT INTO yield_publication_generations (generation_id, state) VALUES (?, 'published')",
      );
      const decision = sqlite.prepare(`
        INSERT INTO yield_source_decisions (
          generation_id, stablecoin_id, selected_source_key, previous_best_source_key,
          source_switch, created_at, retention_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const linkedKey = "linked-variant:child:onchain:child";
      generation.run("old-false");
      generation.run("clean-1");
      decision.run("old-false", "verified-parent", linkedKey, "onchain:verified-parent", 1, 100, "trend");
      decision.run("clean-1", "verified-parent", linkedKey, linkedKey, 0, 200, "audit");

      expect(await cleanupFalseLinkedVariantSourceSwitches(createSqliteD1(sqlite))).toBe(0);

      generation.run("clean-2");
      decision.run("clean-2", "verified-parent", linkedKey, linkedKey, 0, 300, "audit");
      expect(await cleanupFalseLinkedVariantSourceSwitches(createSqliteD1(sqlite))).toBe(1);
      expect(
        sqlite
          .prepare(
            "SELECT source_switch, retention_reason FROM yield_source_decisions WHERE generation_id = 'old-false'",
          )
          .get(),
      ).toEqual({ source_switch: 0, retention_reason: "audit" });
    } finally {
      sqlite.close();
    }
  });

  it("chunks stale yield_data cleanup below the D1 bind-variable ceiling while preserving frozen rows", async () => {
    const db = mockD1();
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);

    await pruneYieldTables(db, startSec);

    const staleDeletes = db
      .getHistory()
      .filter((entry) => entry.sql.includes("pharos:yield-sync:stale-yield-data-delete"));
    expect(staleDeletes.length).toBeGreaterThan(1);
    expect(Math.max(...staleDeletes.map((entry) => entry.binds.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it("deletes old null rollout audit rows while retaining inferable trend rows", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const oldSec = startSec - 31 * 24 * 60 * 60;
    const recentSec = startSec - 5 * 24 * 60 * 60;
    try {
      const insertDecision = sqlite.prepare(
        `INSERT INTO yield_source_decisions (
          generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
          selected_data_source, selected_apy_30d, selected_reason, source_switch,
          alternatives_json, created_at, retention_reason
        ) VALUES (?, ?, 'source', ?, 'test', 4.2, 'test', ?, ?, ?, ?)`,
      );
      insertDecision.run("g-null-audit", "coin-a", "curated", 0, "[]", oldSec, null);
      insertDecision.run("g-null-switch", "coin-b", "curated", 1, "[]", oldSec, null);
      insertDecision.run(
        "g-null-anomaly",
        "coin-c",
        "curated",
        0,
        JSON.stringify([{ confidenceTier: "discovered", rejected: true, anomalies: ["diverges-from-canonical"] }]),
        oldSec,
        null,
      );
      insertDecision.run(
        "g-null-higher",
        "coin-d",
        "discovered",
        0,
        JSON.stringify([{ confidenceTier: "curated", rejected: true, anomalies: [] }]),
        oldSec,
        null,
      );
      insertDecision.run("g-old-audit", "coin-e", "curated", 0, "[]", oldSec, "audit");
      insertDecision.run("g-old-trend", "coin-f", "curated", 0, "[]", oldSec, "trend");
      insertDecision.run("g-recent-null", "coin-g", "curated", 0, "[]", recentSec, null);
      const insertAlternative = sqlite.prepare(
        `INSERT INTO yield_source_decision_alternatives (
          generation_id, stablecoin_id, alt_source_key, alt_yield_source,
          rejection_reason_code, recorded_at
        ) VALUES (?, ?, 'alt', 'test', 'lower-confidence', ?)`,
      );
      insertAlternative.run("g-null-audit", "coin-a", oldSec);
      insertAlternative.run("g-null-switch", "coin-b", oldSec);

      await pruneYieldTables(db, startSec);

      const generations = sqlite
        .prepare("SELECT generation_id FROM yield_source_decisions ORDER BY generation_id ASC")
        .all()
        .map((row) => (row as { generation_id: string }).generation_id);
      expect(generations).toEqual(["g-null-anomaly", "g-null-higher", "g-null-switch", "g-old-trend", "g-recent-null"]);
      const alternatives = sqlite
        .prepare("SELECT generation_id FROM yield_source_decision_alternatives ORDER BY generation_id ASC")
        .all()
        .map((row) => (row as { generation_id: string }).generation_id);
      expect(alternatives).toEqual(["g-null-switch"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("yield publication migration compatibility", () => {
  it("retains only anomaly episode boundaries as permanent trend decisions", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const publish = (generationId: string, startSec: number, fingerprint: string) =>
      publishYieldRowsAtomically(db, {
        rankingsPayload: { rankings: [] },
        startSec,
        generationId,
        yieldDataRows: [],
        historyRows: [],
        decisionRows: [{
          generation_id: generationId,
          stablecoin_id: "coin-a",
          selected_source_key: "source-a",
          selected_confidence_tier: "curated",
          selected_data_source: "test",
          selected_apy_30d: 4.2,
          selected_score: 50,
          selected_reason: "test",
          previous_best_source_key: "source-a",
          source_switch: 0,
          rejected_count: 1,
          alternatives_json: "[]",
          created_at: startSec,
          retention_reason: "episode",
          trend_fingerprint: fingerprint,
        }],
        decisionAlternativeRows: [],
      });
    try {
      await publish("g-1", 100, "episode-a");
      await publish("g-2", 200, "episode-a");
      await publish("g-3", 300, "episode-b");
      expect(
        sqlite
          .prepare(
            `SELECT generation_id, retention_reason
               FROM yield_source_decisions
              ORDER BY created_at`,
          )
          .all(),
      ).toEqual([
        { generation_id: "g-1", retention_reason: "trend" },
        { generation_id: "g-2", retention_reason: "audit" },
        { generation_id: "g-3", retention_reason: "trend" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("surfaces a missing mandatory atomic-publication column", async () => {
    const db = mockD1([
      {
        match: "pys_at_publish, safety_at_publish",
        rows: [],
        throwError: new Error("D1_ERROR: table yield_history has no column named pys_at_publish"),
      },
    ]);

    await expect(
      publishYieldRowsAtomically(db, {
        rankingsPayload: { stablecoins: [] },
        startSec: 1_774_526_400,
        generationId: "yield-1774526400",
        yieldDataRows: [],
        historyRows: [],
        decisionRows: [],
        decisionAlternativeRows: [],
      }),
    ).rejects.toThrow("D1_ERROR: table yield_history has no column named pys_at_publish");
  });

  it("keeps old-worker yield_data and yield_history inserts valid after the additive migration", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
      sqlite.exec(readFileSync(resolveMigrationPath("0000_baseline.sql"), "utf8"));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
      sqlite.exec(readFileSync(resolveMigrationPath("0125_yield_publication_generations.sql"), "utf8"));

      sqlite
        .prepare(
          `INSERT INTO yield_data (
            stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d,
            yield_source, yield_type, data_source, is_best, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("usdt-tether", "legacy-best", "USDT", 4.2, 4.1, 4, "Legacy", "staking", "defillama", 1, 1_774_526_400);
      sqlite
        .prepare(
          `INSERT INTO yield_history (
            stablecoin_id, source_key, recorded_at, is_best, apy, data_source
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("usdt-tether", "legacy-best", 1_774_526_400, 1, 4.2, "defillama");

      const current = sqlite
        .prepare("SELECT publication_generation_id, publication_state FROM yield_data WHERE stablecoin_id = ?")
        .get("usdt-tether") as { publication_generation_id: string | null; publication_state: string | null };
      const history = sqlite
        .prepare("SELECT publication_generation_id, publication_state FROM yield_history WHERE stablecoin_id = ?")
        .get("usdt-tether") as { publication_generation_id: string | null; publication_state: string | null };

      expect(current).toEqual({ publication_generation_id: null, publication_state: null });
      expect(history).toEqual({ publication_generation_id: null, publication_state: null });
    } finally {
      sqlite.close();
    }
  });
});
