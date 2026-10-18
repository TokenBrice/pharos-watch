import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeYieldRanking, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { YieldRankingsResponseSchema, YieldRankingsCoinResponseSchema, type YieldRankingsResponse } from "@shared/types/yield";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { currentInput } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import * as scoreIndex from "../../lib/safety-score-index";
import { handleYieldRankings, handleYieldRankingsCoin } from "../yield-rankings-cache";
import { handleSafetyGrades } from "../safety-grades";
import { projectSafetyGrades } from "@shared/types/report-cards-v9";
import * as opportunitySafety from "@shared/lib/yield-opportunity-risk";

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

  it.each([false, true])("shares exact global ranks and safety coverage across coin URLs (held=%s)", async (held) => {
    const { db } = await fixture(held);
    const fullResponse = await handleYieldRankings(db);
    const full = YieldRankingsResponseSchema.parse(await fullResponse.json());
    const url = (id: string) => new URL(`https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=${id}`);
    const first = await handleYieldRankingsCoin(db, url("usdc-circle"));
    expect(first.status).toBe(200);
    const firstBody = YieldRankingsCoinResponseSchema.parse(await first.json());
    expect(firstBody.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(firstBody.provenance).toEqual(full.provenance);
    expect(firstBody.warnings).toEqual(full.warnings);
    const safety = vi.spyOn(opportunitySafety, "resolveYieldRowSafety");
    const prepare = vi.spyOn(db, "prepare");
    const second = await handleYieldRankingsCoin(db, url("usdt-tether"));
    expect(second.status).toBe(200);
    const secondBody = YieldRankingsCoinResponseSchema.parse(await second.json());
    expect(secondBody.rankings).toEqual(full.rankings.filter((row) => row.id === "usdt-tether"));
    expect(secondBody.projection.totalCount).toBe(2);
    expect(secondBody.provenance).toEqual(full.provenance);
    expect(second.headers.get("Warning")).toBe(fullResponse.headers.get("Warning"));
    // No full ranking read/admission and no unrelated selected/alternate safety
    // hydration on a different coin's cache miss.
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value, updated_at FROM cache WHERE key = ?")).toHaveLength(0);
    expect(safety.mock.calls.every(([input]) => input.yieldType === "lending-opportunity")).toBe(true);
    expect(safety.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("coalesces cold comparator construction before cohort hydration", async () => {
    const { db } = await fixture();
    const prepare = vi.spyOn(db, "prepare");
    const request = (id: string) => handleYieldRankingsCoin(db, new URL(`https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=${id}`));
    const responses = await Promise.all([request("usdc-circle"), request("usdt-tether")]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status === 200 || response.status === 503)).toBe(true);
    for (const response of responses.filter((entry) => entry.status === 503)) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Retry-After")).toBe("1");
    }
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value, updated_at FROM cache WHERE key = ?")).toHaveLength(1);
    expect((await request("usdt-tether")).status).toBe(200);
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value, updated_at FROM cache WHERE key = ?")).toHaveLength(1);
  });

  it("rebuilds the shared comparator only at an evidence transition and keeps row ages current", async () => {
    const { db } = await fixture();
    const url = new URL("https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=usdc-circle");
    const prepare = vi.spyOn(db, "prepare");
    expect((await handleYieldRankingsCoin(db, url)).status).toBe(200);
    vi.setSystemTime((NOW + 30) * 1000);
    let full = YieldRankingsResponseSchema.parse(await (await handleYieldRankings(db)).json());
    let coin = YieldRankingsCoinResponseSchema.parse(await (await handleYieldRankingsCoin(db, url)).json());
    expect(coin.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(coin.rankings[0].provenance?.sourceAgeSeconds).toBe(30);
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value, updated_at FROM cache WHERE key = ?")).toHaveLength(2); // cold cohort + explicit full baseline
    // Protocol-API source aging boundary is five hours; the hourly publisher
    // clock is not a substitute for the independently aging source.
    vi.setSystemTime((NOW + 18_001) * 1000);
    coin = YieldRankingsCoinResponseSchema.parse(await (await handleYieldRankingsCoin(db, url)).json());
    full = YieldRankingsResponseSchema.parse(await (await handleYieldRankings(db)).json());
    expect(coin.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(coin.rankings[0].warningSignals).toContain("aging");
    expect(coin.provenance).toEqual(full.provenance);
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value, updated_at FROM cache WHERE key = ?")).toHaveLength(4);
  });

  it("invalidates comparator coverage on mutable Safety health/index failure without renewing the yield clock", async () => {
    const { db, sqlite } = await fixture();
    const url = new URL("https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=usdc-circle");
    expect((await handleYieldRankingsCoin(db, url)).status).toBe(200);
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    const coin = YieldRankingsCoinResponseSchema.parse(await (await handleYieldRankingsCoin(db, url)).json());
    const full = YieldRankingsResponseSchema.parse(await (await handleYieldRankings(db)).json());
    expect(coin.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(coin.provenance).toEqual(full.provenance);
    expect(coin.provenance?.liveSafetyHydration?.coveredCount).toBe(0);
    expect(coin.projection).toMatchObject({ generationId: `yield-${NOW}`, updatedAt: NOW, totalCount: 2 });
  });

  it.each(["yield", "safety"] as const)("expires the comparator when a future %s clock first admits publish-time fallback", async (clock) => {
    const { db, sqlite } = await fixture(true);
    if (clock === "safety") {
      sqlite.prepare("UPDATE cache SET value = json_set(value, '$.provenance.safetySnapshot.publishedAt', ?) WHERE key = 'yield-rankings'").run(NOW + 5);
    } else {
      sqlite.prepare(`UPDATE cache SET value = json_set(value, '$.updatedAt', ?, '$.publication.updatedAt', ?, '$.publication.cutoffAt', ?),
        updated_at = ? WHERE key = 'yield-rankings'`).run(NOW + 5, NOW + 5, NOW + 5, NOW + 5);
    }
    const url = new URL("https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=usdc-circle");
    const before = YieldRankingsCoinResponseSchema.parse(await (await handleYieldRankingsCoin(db, url)).json());
    expect(before.rankings[0].safetyScore).toBeNull();
    vi.setSystemTime((NOW + 5) * 1000);
    const after = YieldRankingsCoinResponseSchema.parse(await (await handleYieldRankingsCoin(db, url)).json());
    const full = YieldRankingsResponseSchema.parse(await (await handleYieldRankings(db)).json());
    expect(after.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(after.provenance).toEqual(full.provenance);
    expect(after.rankings[0].safetyScore).toBe(80);
    expect(after.provenance?.liveSafetyHydration?.fallback).toBe("publish-time-snapshot");
  });

  it("re-admits a schema-invalid same-generation comparator instead of pinning an unrecoverable miss", async () => {
    const { db, sqlite } = await fixture();
    const url = new URL("https://site-api.pharos.watch/api/yield-rankings-coin?stablecoin=usdc-circle");
    expect((await handleYieldRankingsCoin(db, url)).status).toBe(200);
    sqlite.prepare("UPDATE cache SET value = json_set(value, '$.warnings', 42) WHERE key = 'yield-rankings:coin-cohort:v1'").run();
    const repaired = await handleYieldRankingsCoin(db, url);
    expect(repaired.status).toBe(200);
    const body = YieldRankingsCoinResponseSchema.parse(await repaired.json());
    const full = YieldRankingsResponseSchema.parse(await (await handleYieldRankings(db)).json());
    expect(body.rankings).toEqual(full.rankings.filter((row) => row.id === "usdc-circle"));
    expect(body.provenance).toEqual(full.provenance);
  });
});
