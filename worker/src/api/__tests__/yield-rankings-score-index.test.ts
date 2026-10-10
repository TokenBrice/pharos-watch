import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeYieldRanking, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { YieldRankingsResponse } from "@shared/types/yield";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { currentInput } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication, SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-store";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import * as scoreIndex from "../../lib/safety-score-index";
import { handleYieldRankings } from "../yield-rankings-cache";
import { handleSafetyGrades } from "../safety-grades";
import { projectSafetyGrades } from "@shared/types/report-cards-v9";

const NOW = Date.parse("2026-04-23T12:00:00Z") / 1000;
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });

async function fixture(held = false, pipelineGap = false) {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const publication = makeWorkerSafetyScoreV9Publication({ asOfSec: NOW - 30, publishedAtSec: NOW,
    cards: [pipelineGap
      ? makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })
      : makeWorkerV9Card({ id: "usdc-circle", score: 80, grade: "A-" }),
      makeWorkerV9Card({ id: "usdt-tether", score: null, grade: "NR", qualityScore: null, pegMultiplier: null,
        nrReasons: [{ code: "missing-reserve-composition", field: "pillars.backing", origin: "asset", message: "Reserve composition is unavailable." }] })],
  });
  const input = currentInput(publication);
  await persistSafetyScoreV9Publication(db, input);
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") throw new Error(active.detail);
  const benchmark = { key: "USD" as const, label: "USD 3M T-Bill", currency: "USD", rate: 4.25,
    recordDate: "2026-04-23", fetchedAt: NOW, ageSeconds: 0, source: "fred-dgs3mo",
    isFallback: false, fallbackMode: null, isProxy: false };
  const payload: YieldRankingsResponse = {
    rankings: [makeYieldRanking({ safetyScore: 80, safetyGrade: "A-", provenance: makeYieldProvenance({ sourceObservedAt: NOW }) }),
      makeYieldRanking({ id: "usdt-tether", symbol: "USDT", safetyScore: null, safetyGrade: "NR",
        provenance: makeYieldProvenance({ sourceObservedAt: NOW }) })],
    riskFreeRate: 4.25, scalingFactor: 8, medianApy: 5, updatedAt: NOW, benchmarks: { USD: benchmark },
    publication: { generationId: `yield-${NOW}`, updatedAt: NOW, cutoffAt: NOW, schemaVersion: 1, status: "published" },
    provenance: { selectionMethod: "confidence-weighted", benchmark, benchmarks: { USD: benchmark },
      dlPools: { mode: "dex-cache", updatedAt: NOW, ageSeconds: 0, poolCount: 1, fallbackMode: null },
      safetySnapshot: { kind: "ok", coverageRatio: 0.5, coveredCount: 1, trackedCount: 2, reason: null,
        publishedAt: NOW, safetyScoreIdentity: active.snapshot.safetyScoreIdentity } },
  };
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("yield-rankings", JSON.stringify(payload), NOW);
  if (held) await persistSafetyScoreV9Publication(db, {
    publicationClockSec: NOW + 1,
    publicationHealth: { ...input.publicationHealth, status: "held", attemptedAtSec: NOW + 1,
      heldSinceSec: NOW + 1, reasons: [{ code: "dex-stale" }] },
    publicationAttempt: { ...input.publicationAttempt, outcome: "held", publicationGenerationId: null, attemptedAtSec: NOW + 1 },
  });
  return { sqlite, db };
}

describe("rankings score-index hydration", () => {
  it("keeps an asset pipeline gap null rather than substituting default safety or NR", async () => {
    const { db, sqlite } = await fixture(false, true);
    // The hot read cannot fall back to full cards even though the cached
    // yield publication still has a previously rated score.
    sqlite.prepare("UPDATE cache SET value = json_set(value, '$.payload', 'invalid-gzip-payload') WHERE key = ?")
      .run(SAFETY_SCORE_V9_CACHE_KEYS.publication);
    const response = await handleYieldRankings(db);
    expect(response.status).toBe(200);
    const body = await response.json() as YieldRankingsResponse;
    expect(body.rankings.find((row) => row.id === "usdc-circle")).toMatchObject({
      safetyScore: null, safetyGrade: null, pharosYieldScore: null,
      safetyReason: "safety-snapshot-unavailable", yieldToRisk: null,
      provenance: { usedDefaultSafety: false, safetyProvenance: "safety-snapshot-unavailable" },
    });
    expect(body.provenance?.liveSafetyHydration?.coveredCount).toBe(0);
  });

  it.each(["detailed", "summary"])("preserves an explicit NR null score without default substitution in %s", async projection => {
    const { db } = await fixture();
    const url = new URL(`https://api.pharos.watch/api/yield-rankings${projection === "summary" ? "?projection=summary" : ""}`);
    const response = await handleYieldRankings(db, url);
    expect(response.status).toBe(200);
    const body = await response.json() as YieldRankingsResponse | YieldRankingsSummaryResponse;
    expect(body.rankings.find(row => row.id === "usdt-tether")).toMatchObject({
      safetyScore: null, safetyGrade: "NR", pharosYieldScore: null,
      provenance: {
        usedDefaultSafety: false, safetyProvenance: "live-report-card",
        safetyReason: "report-card-grade-not-rated", scoreQualification: "NR",
      },
    });
    expect(body.provenance?.liveSafetyHydration?.coveredCount).toBe(1);
  });
  it.each([false, true])("is byte-identical to full-publication hydration (held=%s)", async held => {
    const { db } = await fixture(held);
    const indexed = await handleYieldRankings(db);
    const indexedBody = await indexed.text();
    expect(indexed.status).toBe(200);
    const parsed = JSON.parse(indexedBody) as YieldRankingsResponse;
    expect(parsed.rankings.find(row => row.id === "usdc-circle")?.safetyScore).toBe(80);
    const full = await loadActiveSafetyScoreSource(db);
    if (full.kind === "error") throw new Error(full.detail);
    const grades = await handleSafetyGrades(db);
    expect(await grades.text()).toBe(JSON.stringify(projectSafetyGrades(full.snapshot)));
    // Exercise the old full parse + public projection, not a copied fixture map.
    vi.spyOn(scoreIndex, "loadActiveSafetyScoreIndex").mockResolvedValue(full);
    const baseline = await handleYieldRankings(db);
    expect(await baseline.text()).toBe(indexedBody);
    expect(baseline.headers.get("Warning")).toBe(indexed.headers.get("Warning"));
  });

  it.each(["missing", "mismatch"])("makes safety unavailable with an explicit %s-index reason, even inside the publish-time window", async failure => {
    const { db, sqlite } = await fixture();
    if (failure === "missing") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    else sqlite.prepare("UPDATE cache SET value = json_set(value, '$.safetyScoreIdentity.publicationGenerationId', ?) WHERE key = ?")
      .run("report-cards:v9:other", SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    const response = await handleYieldRankings(db);
    expect(response.status).toBe(200);
    const body = await response.json() as YieldRankingsResponse;
    const row = body.rankings.find(row => row.id === "usdc-circle")!;
    expect(row.safetyScore).toBeNull();
    expect(row.safetyGrade).toBeNull();
    expect(row.pharosYieldScore).toBeNull();
    const reason = failure === "missing" ? "safety-score-index-missing" : "safety-score-index-publication-mismatch";
    expect(body.provenance?.liveSafetyHydration?.reason).toContain(reason);
    expect(response.headers.get("Warning")).toContain("Yield safety hydration degraded");
    const grades = await handleSafetyGrades(db);
    expect(grades.status).toBe(503);
    expect(await grades.json()).toMatchObject({ reason });
  });
});
