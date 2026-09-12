import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { YIELD_HISTORY_MAX_DAYS, YIELD_HISTORY_RAW_DAYS } from "@shared/lib/yield-history-policy";
import { computePYS } from "@shared/lib/yield-scoring";
import {
  YIELD_BENCHMARK_KEY_CURRENCY,
  YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
  type YieldPysInputsAtPublish,
} from "@shared/types/yield";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";

import { type EvaluatedYieldSource } from "../yield-sync/evaluation";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  cleanupFalseLinkedVariantSourceSwitches,
  loadPreviousYieldPublicationSnapshot,
  materializeYieldHistoryDaily,
  pruneYieldTables,
} from "../yield-sync/publication";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/yield-methodology";
import { buildPreviewYieldRankingsArtifacts } from "../yield-sync/coordinator-persist";
import type { PreviousYieldPublicationSnapshot } from "../yield-sync/publication";
import { publishYieldCoordinatorResults } from "../yield-sync/coordinator-persist";
import { publishYieldRowsAtomically, YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS } from "../yield-sync/publication-atomic-batch";
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
  return existsSync(fixture) ? fixture : path.join(MIGRATIONS_DIR, file);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}


describe("publishYieldCoordinatorResults", () => {
  function parseJsonBind<T>(entry: { binds: unknown[] } | undefined, index = 0): T {
    return JSON.parse(String(entry?.binds[index] ?? "[]")) as T;
  }

  function makePublicationDb(
    cacheWriteChanges: number,
    options?: { cacheWriteError?: Error; finalizeError?: Error },
  ) {
    return mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["yield-rankings"], rows: [], first: null },
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
      },
      { match: "UPDATE yield_data SET publication_state", rows: [] },
      { match: "UPDATE yield_history SET publication_state", rows: [] },
      { match: "DELETE FROM yield_history", rows: [] },
      { match: "DELETE FROM yield_source_decisions", rows: [] },
      { match: "DELETE FROM yield_source_decision_alternatives", rows: [] },
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
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const source = makeEvaluatedSource({ id: "usdc-circle" });
      const params = makePublishParams({
        db, evaluatedSources: [source],
        bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]),
        previewRankingsPayload: buildPayloadWithObservedAt(startSec, { id: source.id }),
      });
      expect(await publishYieldCoordinatorResults({ ...params, startSec: startSec + 1 })).toMatchObject({ ok: true });
      const tables = ["yield_data", "yield_history", "yield_source_decisions"];
      const before = tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all());
      for (const rows of before) expect(rows).toHaveLength(1);
      const cache = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();

      const result = await publishYieldCoordinatorResults({
        ...params, evaluatedSources: [{ ...source, currentApy: 99, apy30d: 99 }],
      });

      expect(result).toMatchObject({ ok: true, cacheWriteSkipped: true, casSkipped: true });
      expect(tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(cache);
      expect(sqlite.prepare("SELECT state FROM yield_publication_generations WHERE generation_id = ?")
        .get(`yield-${startSec}`)).toEqual({ state: "failed" });
    } finally {
      sqlite.close();
    }
  });

  it("publishes rank-change attribution from the previous cached payload", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const benchmark = makeBenchmarkMeta();
      const riskFreeRates = {
        USD: benchmark,
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: null,
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      };
      // The cached publication ranked three coins; the run below re-ranks them so
      // the served comparator sees a real move for two and no move for one.
      const previousRanking = (id: string, name: string, publishedRank: number, pys: number, currentApy: number) => ({
        id,
        name,
        currentApy,
        pharosYieldScore: pys,
        publishedRank,
        safetyScore: 80,
      });
      sqlite
        .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          "yield-rankings",
          JSON.stringify({
            updatedAt: startSec - 3600,
            methodology: { version: YIELD_METHODOLOGY_VERSION },
            rankings: [
              previousRanking("coin-a", "Coin A", 2, 60, 5),
              previousRanking("coin-b", "Coin B", 1, 90, 9),
              previousRanking("coin-c", "Coin C", 3, 20, 2),
            ],
          }),
          startSec - 3600,
        );

      const sources: EvaluatedYieldSource[] = [
        makeEvaluatedSource({ id: "coin-a", symbol: "A", sourceKey: "defillama:coin-a:now", currentApy: 6, pharosYieldScore: 95 }),
        makeEvaluatedSource({ id: "coin-b", symbol: "B", sourceKey: "defillama:coin-b:now", currentApy: 7, pharosYieldScore: 50 }),
        makeEvaluatedSource({ id: "coin-c", symbol: "C", sourceKey: "defillama:coin-c:now", currentApy: 2, pharosYieldScore: 20 }),
      ];
      const previousYieldPublicationSnapshot = await loadPreviousYieldPublicationSnapshot(db);
      expect(previousYieldPublicationSnapshot.methodologyVersion).toBe(YIELD_METHODOLOGY_VERSION);

      const { previewRankingsPayload, publicationViews } = buildPreviewYieldRankingsArtifacts({
        evaluatedSources: sources,
        bestSourceKeyByCoin: new Map(sources.map((source) => [source.id, source.sourceKey])),
        riskFreeRate: benchmark.rate,
        riskFreeRateMeta: benchmark,
        riskFreeRates,
        dlPoolsMeta: makeYieldSourceMeta(),
        safetySnapshot: makeSafetySnapshotMeta(),
        medianApy: 4.5,
        startSec,
        previousPublication: {
          rankings: previousYieldPublicationSnapshot.rankings,
          methodologyVersion: previousYieldPublicationSnapshot.methodologyVersion ?? null,
        },
      });

      const result = await publishYieldCoordinatorResults({
        db,
        previewRankingsPayload,
        evaluatedSources: sources,
        publicationViews,
        startSec,
        degradationReasons: [],
        resolvedCount: sources.length,
        rowsRejected: 0,
        divergenceFlags: 0,
        sourceSwitches: 0,
        previousYieldPublicationSnapshot,
      });
      expect(result).toMatchObject({ ok: true });

      const cacheRow = sqlite
        .prepare("SELECT value FROM cache WHERE key = ?")
        .get("yield-rankings") as { value: string } | undefined;
      const published = JSON.parse(cacheRow?.value ?? "{}") as {
        rankings: Array<{ id: string; rankChangeAttribution: unknown }>;
      };
      const attributionById = new Map(published.rankings.map((row) => [row.id, row.rankChangeAttribution]));
      // coin-a rose 2 -> 1 and coin-b fell 1 -> 2 under the served comparator.
      expect(attributionById.get("coin-a")).toMatchObject({ previousRank: 2, rankDelta: 1 });
      expect(attributionById.get("coin-b")).toMatchObject({ previousRank: 1, rankDelta: -1 });
      // coin-c did not move, so nothing is attributed.
      expect(attributionById.get("coin-c") ?? null).toBeNull();
    } finally {
      sqlite.close();
    }
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
    const db = makePublicationDb(1);
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const prepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("UPDATE yield_publication_generations")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          entered.resolve();
          await release.promise;
          return run();
        };
        return bound;
      };
      return statement;
    });
    const resultPromise = publishYieldCoordinatorResults(makePublishParams({ db, signal: controller.signal }));
    const rejected = expect(resultPromise).rejects.toThrow("cron timeout");
    try {
      await entered.promise;
      controller.abort(new Error("cron timeout"));
    } finally {
      release.resolve();
      await rejected;
      prepareSpy.mockRestore();
    }
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
      Math.floor(FIXED_NOW.getTime() / 1000) - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS,
    );
    const dailyRetentionIndex = history.findIndex((entry) =>
      entry.sql.includes("pharos:yield-sync:daily-history-retention-delete"),
    );
    expect(history[dailyRetentionIndex]?.binds[0]).toBe(
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
      schemaVersion: YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
      apy30d: 4.6,
      safetyScore: 82,
      varianceScore: 0.1,
      benchmarkRate: 4.2,
      sourceRiskPenalty: 1,
      scoreQualification: "rated",
      benchmarkKey: "USD",
      evidenceClass: "curated-observation",
      // A same-currency USD benchmark stores the reference rate but no re-base (B24).
      usdBenchmarkRate: 4.2,
      hurdleRebase: 0,
    });
  });

  it("stores the v8.43 hurdle re-base so a non-USD row replays to its published PYS", async () => {
    const TRY_BENCHMARK_RATE = 36.86;
    const USD_BENCHMARK_RATE = 3.95;
    const tryBenchmark = makeBenchmarkMeta({
      key: "TRY",
      label: "TRY BIST TLREF",
      currency: "TRY",
      rate: TRY_BENCHMARK_RATE,
      lastMarketRate: TRY_BENCHMARK_RATE,
    });
    // wiTRY-shaped row: 1.27pp over its own hurdle, so the v8.43 re-base (not the
    // 25% spread slice) decides the score. Replay of the stored inputs is 44;
    // without the stored re-base inputs the same inputs replay to 100.
    const source = makeEvaluatedSource({
      id: "witry-brix",
      symbol: "wiTRY",
      benchmarkKey: "TRY",
      benchmarkLabel: tryBenchmark.label!,
      benchmarkCurrency: "TRY",
      benchmarkRate: TRY_BENCHMARK_RATE,
      benchmarkMeta: tryBenchmark,
      usdBenchmarkRate: USD_BENCHMARK_RATE,
      hurdleRebase: USD_BENCHMARK_RATE - TRY_BENCHMARK_RATE,
      currentApy: 38.13,
      apy7d: 38.1,
      apy30d: 38.13,
      pharosYieldScore: 44,
    });
    const db = makePublicationDb(1);
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const result = await publishYieldCoordinatorResults(
      makePublishParams({
        db,
        evaluatedSources: [source],
        bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]),
        previewRankingsPayload: buildPayloadWithObservedAt(startSec, source),
      }),
    );
    expect(result).toMatchObject({ ok: true });

    const yieldHistoryInsert = db.getHistory().find((entry) => entry.sql.includes("INSERT OR IGNORE INTO yield_history"));
    const historyRows = parseJsonBind<
      Array<{ pys_at_publish: number | null; pys_inputs_at_publish: string }>
    >(yieldHistoryInsert);
    const published = historyRows[0]?.pys_at_publish;
    expect(published).toBe(44);

    const snapshot = JSON.parse(historyRows[0]?.pys_inputs_at_publish ?? "null") as YieldPysInputsAtPublish;
    expect(snapshot.schemaVersion).toBe(YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION);
    expect(snapshot.benchmarkKey).toBe("TRY");
    expect(snapshot.usdBenchmarkRate).toBe(USD_BENCHMARK_RATE);
    expect(snapshot.hurdleRebase).toBeCloseTo(USD_BENCHMARK_RATE - TRY_BENCHMARK_RATE, 6);

    const replayed = computePYS({
      apy30d: snapshot.apy30d,
      safetyScore: snapshot.safetyScore,
      apyVarianceScore: snapshot.varianceScore,
      scalingFactor: snapshot.scalingFactor,
      benchmarkRate: snapshot.benchmarkRate,
      benchmarkCurrency: YIELD_BENCHMARK_KEY_CURRENCY[snapshot.benchmarkKey],
      usdBenchmarkRate: snapshot.usdBenchmarkRate ?? null,
      sourceRiskPenalty: snapshot.sourceRiskPenalty,
    });
    expect(replayed).toBe(published);
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

  it("chunks stale cleanup below the bind ceiling and preserves frozen and current rows", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const startSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const bindCounts: number[] = [];
    const prepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("pharos:yield-sync:stale-yield-data-delete")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => { bindCounts.push(values.length); return bind(...values); };
      }
      return statement;
    });
    try {
      const insert = sqlite.prepare(`INSERT INTO yield_data
        (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d,
         yield_source, yield_type, data_source, updated_at)
        VALUES (?, ?, 'TEST', 5, 5, 5, 'Test', 'lending-vault', 'defillama', ?)`);
      insert.run("usdc-circle", "stale", startSec - 1);
      insert.run("usdc-circle", "current", startSec);
      insert.run("usr-resolv", "frozen", startSec - 1);
      insert.run("not-tracked", "orphan", startSec);
      await pruneYieldTables(db, startSec);
      expect(sqlite.prepare("SELECT stablecoin_id, source_key FROM yield_data ORDER BY stablecoin_id").all()).toEqual([
        { stablecoin_id: "usdc-circle", source_key: "current" },
        { stablecoin_id: "usr-resolv", source_key: "frozen" },
      ]);
      expect(bindCounts.length).toBeGreaterThan(1);
      expect(Math.max(...bindCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      prepareSpy.mockRestore();
      sqlite.close();
    }
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

  it("measures the published payload and warns before the D1 statement cap", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await publishYieldRowsAtomically(db, {
        rankingsPayload: {
          rankings: [],
          blob: "x".repeat(YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS + 1),
        },
        startSec: 1_774_526_400,
        generationId: "yield-1774526400",
        yieldDataRows: [],
        historyRows: [
          {
            stablecoin_id: "coin-a",
            source_key: "source-a",
            recorded_at: 1_774_526_400,
            is_best: 1,
            apy: 4.2,
            data_source: "test",
            publication_generation_id: "yield-1774526400",
            publication_state: "published",
            pys_inputs_at_publish: null,
          },
          {
            stablecoin_id: "coin-b",
            source_key: "source-b",
            recorded_at: 1_774_526_400,
            is_best: 1,
            apy: 4.4,
            data_source: "test",
            publication_generation_id: "yield-1774526400",
            publication_state: "published",
            pys_inputs_at_publish: JSON.stringify({ schemaVersion: YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION }),
          },
        ],
        decisionRows: [],
        decisionAlternativeRows: [],
      });

      expect(result.written).toBe(true);
      expect(result.publicationStats.cacheValueChars).toBeGreaterThan(YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS);
      expect(result.publicationStats.oversize).toBe(true);
      // The replay-evidence counters follow the rows actually bound to the write.
      expect(result.publicationStats.pysInputsPersistedCount).toBe(1);
      expect(result.publicationStats.pysInputsNullCount).toBe(1);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("yield-publication-payload-oversize")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
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
      sqlite.exec(readFileSync(resolveMigrationPath("0000_baseline.sql"), "utf8"));
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

describe("buildYieldRankingsPayloadFromEvaluatedSources benchmark projection", () => {
  it("projects a non-USD row's own rate and excess alongside the published registry", () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const eurBenchmark = makeBenchmarkMeta({
      key: "EUR",
      label: "EUR ESTR",
      currency: "EUR",
      rate: 2.17,
      source: "ecb-estr",
    });
    const payload = buildPayloadWithObservedAt(
      nowSec,
      {
        benchmarkKey: "EUR",
        benchmarkLabel: eurBenchmark.label!,
        benchmarkCurrency: "EUR",
        benchmarkRate: eurBenchmark.rate,
        benchmarkMeta: eurBenchmark,
        excessYield: 2.43,
      },
      { benchmarkRegistry: { EUR: eurBenchmark } },
    );

    expect(payload.rankings[0]).toMatchObject({
      benchmarkKey: "EUR",
      benchmarkCurrency: "EUR",
      benchmarkRate: 2.17,
      excessYield: 2.43,
      pharosYieldScore: 28,
    });
    // The published registry is the run's reference registry (EUR entry included),
    // while the row's hurdle stays its own rate rather than the USD reference.
    expect(payload.benchmarks?.EUR?.rate).toBe(2.17);
    expect(payload.provenance?.benchmarks?.EUR?.rate).toBe(2.17);
    expect(payload.riskFreeRate).toBe(4.2);
  });

  it("keeps a row whose benchmark key has no registry entry on its own evaluated rate", () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const gbpBenchmark = makeBenchmarkMeta({
      key: "GBP",
      label: "GBP SONIA",
      currency: "GBP",
      rate: 4.35,
      source: "boe-sonia",
    });
    const payload = buildPayloadWithObservedAt(nowSec, {
      benchmarkKey: "GBP",
      benchmarkLabel: gbpBenchmark.label!,
      benchmarkCurrency: "GBP",
      benchmarkRate: gbpBenchmark.rate,
      benchmarkMeta: gbpBenchmark,
      excessYield: 0.25,
    });

    expect(payload.rankings[0]).toMatchObject({
      benchmarkKey: "GBP",
      benchmarkCurrency: "GBP",
      benchmarkRate: 4.35,
      excessYield: 0.25,
      pharosYieldScore: 28,
    });
    // GBP is a null registry slot: the payload must neither fabricate an entry nor
    // re-base the row onto the USD reference.
    expect(payload.benchmarks?.GBP).toBeNull();
    expect(payload.riskFreeRate).toBe(4.2);
  });

  it("publishes each registry entry's own record bound and publication-time record age", () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
    const cadBenchmark = makeBenchmarkMeta({
      key: "CAD",
      label: "CAD Bank of Canada Bank Rate",
      currency: "CAD",
      rate: 2.75,
      // A monthly series: far past the 5-day daily bound, inside its own 45-day one.
      recordDate: "2026-03-01",
      source: "boc-policy-rate",
    });
    const payload = buildPayloadWithObservedAt(
      nowSec,
      {},
      { benchmarkRegistry: { CAD: cadBenchmark } },
    );

    // USD's observation is 36h old at publication; the 2x-daily fallback bound
    // amber-tints it without the 5-day daily bound travelling with the rate.
    expect(payload.benchmarks?.USD).toMatchObject({
      recordAgeSec: 36 * 3600,
      maxRecordAgeSec: 5 * DAY_SECONDS,
    });
    expect(payload.benchmarks?.CAD).toMatchObject({
      recordAgeSec: 25 * DAY_SECONDS + 12 * 3600,
      maxRecordAgeSec: 45 * DAY_SECONDS,
    });
    expect(payload.provenance?.benchmarks?.CAD?.maxRecordAgeSec).toBe(45 * DAY_SECONDS);
  });
});
