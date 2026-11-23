import { readJsonResponse as readJson } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { YieldRankingsResponseSchema as RespSchema, type YieldRanking, type YieldRankingsResponse } from "@shared/types/yield";
import { YieldRankingsSummaryResponseSchema as SumSchema } from "@shared/types/yield-summary";
import { YIELD_METHODOLOGY_VERSION as Y_VER } from "@shared/lib/methodology-versions/constants";
import type { SafetyScoreV9PublicationIdentity as V9Id } from "@shared/types/safety-score-publication";
import { computePYS, yieldStabilityToApyVarianceScore as varScore } from "@shared/lib/yield-scoring";
import { makeAltYieldSource as mkAlt, makeYieldRanking as mkRank, makeYieldProvenance as mkProv } from "@shared/test-utils/yield-ranking-fixtures";
import { SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID as GOLD_GEN, buildSourceRiskGoldenFixture as goldRisk, getSourceRiskGoldenRow as goldRow } from "@shared/test-utils/yield-source-risk-golden-fixtures";
import type { ActiveSafetyScoreIndex, SafetyScoreGradeSnapshot } from "../../lib/safety-score-index";

const mIdx = vi.hoisted(() => vi.fn());
vi.mock("../../lib/safety-score-index", () => ({ loadActiveSafetyScoreIndex: mIdx }));

import { handleYieldRankings as handle } from "../cache-handlers";
import { buildYieldMethodology } from "../../cron/yield-sync/publication-generation";
import { readEdgeCache } from "../../handlers/http/edge-cache";

const V748_AT = Date.parse("2026-03-13T15:59:30Z") / 1000, V9_VER = "9.0";
let curId: V9Id | null = null;
const nowS = () => Math.floor(Date.now() / 1000);
const usdBench = (at = V748_AT, ex: Record<string, unknown> = {}) => ({ key: "USD" as const, label: "USD 3M T-Bill", currency: "USD", rate: 4.13, recordDate: "2026-03-12", fetchedAt: at, ageSeconds: 0, source: "fred-dgs3mo", isFallback: false, fallbackMode: null, isProxy: false, ...ex });
const pub = (at: number, generationId = `yield-${at}`) => ({ generationId, updatedAt: at, cutoffAt: at, schemaVersion: 1 as const, status: "published" as const });
const v9Id = (publicationGenerationId: string): V9Id => ({ model: "v9", schemaVersion: 1, methodologyVersion: V9_VER, policyId: "safety-score-v9", policyDigest: "c".repeat(64), evaluationBuildDigest: "a".repeat(64), baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`, publicationGenerationId });
const idxSrc = (entries: ReadonlyArray<readonly [string, number, string]>, identity: V9Id | null, at: number): ActiveSafetyScoreIndex => {
  if (identity === null) return { kind: "error", reason: "safety-identity-missing", detail: "Missing safety identity", snapshot: null };
  const cards: SafetyScoreGradeSnapshot["cards"] = entries.map(([id, s, g]) => ({ id, score: g === "NR" ? null : s, grade: g as SafetyScoreGradeSnapshot["cards"][number]["grade"], ratingStatus: g === "NR" ? "not-rated" : "rated", partialEvidence: null }));
  return { kind: "v9", snapshot: { lifecycle: "active", safetyScoreIdentity: identity, methodology: { version: identity.methodologyVersion }, asOfSec: at, updatedAt: at, publicationHealth: { schemaVersion: 2, status: "current", acceptedPublicationGenerationId: identity.publicationGenerationId, acceptedAtSec: at, attemptedAtSec: at, heldSinceSec: null, reasons: [] }, completeness: { expectedCount: cards.length }, cards } };
};
const failIdx = (once = false) => once ? mIdx.mockRejectedValueOnce(new Error("D1 unavailable")) : mIdx.mockRejectedValue(new Error("D1 unavailable"));

const baseBench = usdBench();
const baseRow = mkRank({
  id: "usdc-circle", symbol: "USDC", name: "USD Coin", currentApy: 4.72, apy7d: 4.69, apy30d: 4.61, apyBase: 4.61, apyReward: null,
  yieldSource: "Aave V3 USDC", yieldSourceUrl: "https://aave.com/", yieldType: "lending-opportunity", dataSource: "protocol-api",
  sourceTvlUsd: 268_000_000, pharosYieldScore: 11, safetyScore: 40, safetyGrade: "NR", yieldToRisk: 0.0756, excessYield: 0.48,
  benchmarkKey: "USD", benchmarkLabel: "USD 3M T-Bill", benchmarkCurrency: "USD", benchmarkRate: 4.13, benchmarkRecordDate: "2026-03-12",
  benchmarkIsFallback: false, benchmarkFallbackMode: null, benchmarkSelectionMode: "native", benchmarkIsProxy: false,
  yieldStability: 0.94, apyVariance30d: 0.06, apyMin30d: 4.4, apyMax30d: 4.9, warningSignals: [],
  altSources: [mkAlt({ sourceKey: "defillama:auto:compound-v3:usdc", yieldSource: "Compound V3 USDC", yieldSourceUrl: "https://compound.finance/", yieldType: "lending-opportunity", currentApy: 4.21, apy30d: 4.1, sourceTvlUsd: 191_000_000, dataSource: "defillama-auto" })],
  provenance: mkProv({ sourceKey: "protocol-api:aave-v3:usdc", sourceObservedAt: V748_AT, sourceAgeSeconds: 0, comparisonAnchorObservedAt: null, comparisonAnchorAgeSeconds: null, confidenceTier: "curated", selectionMethod: "confidence-weighted", selectionReason: "curated source selected by confidence-weighted arbitration", sourceSwitch: false, previousBestSourceKey: "protocol-api:aave-v3:usdc", usedLegacyHistory: false, usedDefaultSafety: true, safetyProvenance: "cached-publish", benchmarkKey: "USD", benchmarkLabel: "USD 3M T-Bill", benchmarkCurrency: "USD", benchmarkRate: 4.13, benchmarkRecordDate: "2026-03-12", benchmarkIsFallback: false, benchmarkFallbackMode: null, benchmarkSelectionMode: "native", benchmarkIsProxy: false, anomalies: [] }),
  publicationGenerationId: `yield-${V748_AT}`, publishedRank: 1,
});
const basePay: YieldRankingsResponse = {
  rankings: [baseRow], riskFreeRate: 4.13, benchmarks: { USD: baseBench }, scalingFactor: 8, medianApy: 3.55, updatedAt: V748_AT, publication: pub(V748_AT),
  provenance: { selectionMethod: "confidence-weighted", benchmark: baseBench, benchmarks: { USD: baseBench }, dlPools: { mode: "dex-cache", updatedAt: V748_AT - 240, ageSeconds: 240, poolCount: 842, fallbackMode: null }, safetySnapshot: { kind: "degraded", coverageRatio: 0.8464, coveredCount: 109, trackedCount: 129, reason: null, publishedAt: V748_AT } },
};
const ratedRow = (ex: Record<string, unknown> = {}) => ({ ...baseRow, id: "rated-coin", symbol: "RATE", name: "Rated Coin", ...ex }) as YieldRanking;
const cacheRows = (value: string, updated_at: number) => [{ match: "cache", rows: [{ key: "yield-rankings", value, updated_at }], first: { key: "yield-rankings", value, updated_at } }];
const mkDb = (val: unknown, at: number) => {
  let p: unknown;
  try { p = typeof val === "string" ? JSON.parse(val) : structuredClone(val); }
  catch { return mockD1(cacheRows(typeof val === "string" ? val : JSON.stringify(val), at)); }
  if (p && typeof p === "object" && "rankings" in p) {
    const r = p as YieldRankingsResponse;
    curId = v9Id(r.provenance?.safetySnapshot.publicationGenerationId ?? `report-cards:v9:${at}`);
    if (r.provenance) r.provenance = { ...r.provenance, safetySnapshot: { ...r.provenance.safetySnapshot, safetyScoreIdentity: curId } };
  }
  return mockD1(cacheRows(JSON.stringify(p), at));
};
const dbWith = (rankings: YieldRanking[], ex: Partial<YieldRankingsResponse> = {}, at = nowS() - 30) => mkDb({ ...basePay, updatedAt: at, rankings, ...ex }, at);
const getJson = async (db: ReturnType<typeof mkDb>, url?: URL) => readJson<YieldRankingsResponse & { _meta: { ageSeconds: number; status: string } }>(await handle(db, url), 200);
const rowOf = async (rankings: YieldRanking[], ex: Partial<YieldRankingsResponse> = {}, at = nowS() - 30) => (await getJson(dbWith(rankings, ex, at))).rankings[0];

describe("handleYieldRankings", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-13T16:00:00Z"));
    mIdx.mockReset().mockImplementation(async () => idxSrc([["rated-coin", 66, "B-"], ["ustbl-spiko", 66, "B-"], ["eutbl-spiko", 66, "B-"]], curId, nowS()));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("hydrates live safety scores from the report-card snapshot and falls back to NR defaults for missing cards", async () => {
    const at = nowS() - 30;
    const db = mkDb({
      rankings: [
        mkRank({ id: "rated-coin", symbol: "RATE", name: "Rated Coin", currentApy: 5.3, apy7d: 5.2, apy30d: 5, apyBase: 5, yieldSource: "Source A", yieldType: "lending-vault", dataSource: "defillama", sourceTvlUsd: 1e6, pharosYieldScore: 8, safetyScore: 40, safetyGrade: "NR", yieldToRisk: 0.08, excessYield: 1, yieldStability: 0.8, apyVariance30d: 0.5, apyMin30d: 4.9, apyMax30d: 5.4, provenance: mkProv({ sourceKey: "pool-a", sourceObservedAt: at, sourceAgeSeconds: 30, previousBestSourceKey: "pool-a", usedDefaultSafety: true, benchmarkRecordDate: "2026-03-12" }) }),
        mkRank({ id: "nr-coin", symbol: "NRC", name: "NR Coin", currentApy: 3.2, apy7d: 3.2, apy30d: 3.1, apyBase: 3.1, yieldSource: "Source B", yieldType: "lending-vault", dataSource: "defillama", sourceTvlUsd: 500_000, pharosYieldScore: 7, safetyScore: 40, safetyGrade: "NR", yieldToRisk: 0.05, excessYield: 0.5, yieldStability: 0.9, apyVariance30d: 0.2, apyMin30d: 3, apyMax30d: 3.3, provenance: mkProv({ sourceKey: "pool-b", sourceObservedAt: at, sourceAgeSeconds: 30, previousBestSourceKey: "pool-b", usedDefaultSafety: false, benchmarkRecordDate: "2026-03-12" }) }),
        mkRank({ id: "orphan-coin", symbol: "ORPH", name: "Orphan Coin", currentApy: 9.9, apy7d: 9.9, apy30d: 9.9, apyBase: 9.9, yieldSource: "Source C", yieldType: "lending-vault", dataSource: "defillama", sourceTvlUsd: 100_000, pharosYieldScore: 99, safetyScore: 99, safetyGrade: "A+", yieldToRisk: 1, excessYield: 5, yieldStability: 1, apyVariance30d: 0, apyMin30d: 9.9, apyMax30d: 9.9, provenance: null }),
      ],
      riskFreeRate: 4.25, scalingFactor: 8, medianApy: 4.2, updatedAt: at, publication: pub(at),
      provenance: { selectionMethod: "confidence-weighted", benchmark: { rate: 4.25, recordDate: "2026-03-12", fetchedAt: at, ageSeconds: 30, source: "fred", isFallback: false, fallbackMode: null }, dlPools: { mode: "dex-cache", updatedAt: at, ageSeconds: 30, poolCount: 10, fallbackMode: null }, safetySnapshot: { kind: "ok", coverageRatio: 0.5, coveredCount: 1, trackedCount: 2, reason: null, source: "safety-score-v9-publication", publicationGenerationId: `report-cards:v9:${at}`, methodologyVersion: V9_VER, publishedAt: at } },
    }, at);
    const res = await handle(db), body = await readJson<YieldRankingsResponse & { _meta: { ageSeconds: number } }>(res, 200);
    expect(body.rankings.map((r) => r.id)).toEqual(["rated-coin", "nr-coin", "orphan-coin"]);
    const byId = new Map(body.rankings.map((r) => [r.id, r]));
    expect(byId.get("orphan-coin")).toMatchObject({ safetyGrade: "NR", safetyScore: 40, safetyReason: "report-card-score-missing" });
    expect(byId.get("orphan-coin")?.provenance?.usedDefaultSafety).toBeUndefined();
    const rated = byId.get("rated-coin");
    expect(rated).toMatchObject({ safetyGrade: "B-", safetyScore: 66, pharosYieldScore: 12, safetyReason: null, provenance: { usedDefaultSafety: false, safetyProvenance: "live-report-card", calculationMode: "market-api", evidenceClass: "curated-observation", evidenceCompleteness: 0.5714, scoreQualification: "partial", scoreQualified: true } });
    expect(rated?.yieldToRisk).toBeCloseTo(5 / 35);
    const unrated = byId.get("nr-coin");
    expect(unrated).toMatchObject({ safetyGrade: "NR", safetyScore: 40, safetyReason: "report-card-score-missing", provenance: { usedDefaultSafety: true, safetyProvenance: "default-safety", safetyReason: "report-card-score-missing", scoreQualification: "estimated", scoreQualified: true } });
    expect(unrated?.pharosYieldScore).toBeGreaterThan(0);
    expect(body.provenance?.safetySnapshot).toMatchObject({ kind: "ok", coverageRatio: 0.5, coveredCount: 1, trackedCount: 2, reason: null, source: "safety-score-v9-publication", publicationGenerationId: `report-cards:v9:${at}`, methodologyVersion: V9_VER, publishedAt: at });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "degraded", coverageRatio: 0.3333, coveredCount: 1, trackedCount: 3, reason: "low-row-safety-coverage", source: "safety-score-v9-publication", publicationGenerationId: `report-cards:v9:${at}`, methodologyVersion: V9_VER, publishedAt: expect.any(Number) });
    expect(body.warnings?.[0]).toMatchObject({ code: "yield-safety-hydration-degraded", reasons: ["low-row-safety-coverage"] });
    expect(res.headers.get("Warning")).toContain("199"); expect(body._meta.ageSeconds).toBe(30);
  });

  it("hydrates across compatible compact publication and base-input generations", async () => {
    const hAt = nowS() - 3_600, snap = { kind: "ok" as const, coverageRatio: 0.8462, coveredCount: 308, trackedCount: 364, reason: null, source: "safety-score-v9-publication" as const, publicationGenerationId: `report-cards:v9:${hAt}`, methodologyVersion: V9_VER, publishedAt: hAt };
    const db = dbWith([ratedRow({ safetyScore: 40, safetyGrade: "NR" })], { provenance: { ...basePay.provenance!, safetySnapshot: snap } }, hAt);
    const liveGen = `report-cards:v9:${hAt + 900}`;
    curId = { ...v9Id(liveGen), baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}` };
    const body = await (await handle(db)).json() as YieldRankingsResponse;
    expect(body.rankings[0]).toMatchObject({ id: "rated-coin", safetyScore: 66, safetyGrade: "B-" });
    expect(body.provenance?.safetySnapshot).toMatchObject(snap);
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "ok", coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null, source: "safety-score-v9-publication", publicationGenerationId: liveGen, methodologyVersion: V9_VER, publishedAt: expect.any(Number) });
    expect(body.rankings[0]?.provenance?.safetyScoreIdentity).toEqual(curId);
  });

  it("hydrates live safety when only the evaluation-build digest rotated", async () => {
    const at = nowS() - 30, db = mkDb(basePay, at);
    mIdx.mockResolvedValueOnce(idxSrc([["usdc-circle", 88, "A"]], { ...v9Id("report-cards:v9:other"), evaluationBuildDigest: "c".repeat(64) }, at));
    const body = await getJson(db);
    expect(body.rankings[0]).toMatchObject({ safetyScore: 88, safetyGrade: "A" });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "ok", reason: null });
  });

  it("serves the coherent publish-time safety snapshot instead of blanking on a compact identity mismatch", async () => {
    const at = nowS() - 30, db = mkDb(basePay, at);
    mIdx.mockResolvedValueOnce(idxSrc([["usdc-circle", 88, "A"]], { ...v9Id("report-cards:v9:other"), policyDigest: "9".repeat(64) }, at));
    const res = await handle(db), body = await readJson<YieldRankingsResponse>(res, 200);
    expect(body.rankings[0]).toMatchObject({ safetyScore: 40, safetyGrade: "NR", pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing" });
    expect(body.rankings[0]?.warningSignals).toContain("opportunity-evidence-missing");
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "degraded", reason: "safety-identity-mismatch", fallback: "publish-time-snapshot", source: "safety-score-v9-publication" });
    expect(body.warnings?.[0]).toMatchObject({ code: "yield-safety-hydration-stale", reasons: ["safety-identity-mismatch"] });
    expect(res.headers.get("Warning")).toBeNull();
  });

  it("keeps unavailable safety null once live and incompatible publish-time snapshots expire", async () => {
    const at = nowS() - (24 * 3600 + 60), db = mkDb(basePay, at);
    mIdx.mockResolvedValueOnce(idxSrc([["usdc-circle", 88, "A"]], { ...v9Id("report-cards:v9:other"), evaluationBuildDigest: "c".repeat(64) }, at));
    const res = await handle(db), body = await readJson<YieldRankingsResponse>(res, 200);
    expect(body.rankings[0]).toMatchObject({ safetyScore: null, safetyGrade: null, safetyReason: "safety-snapshot-unavailable", pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing" });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "degraded", reason: "safety-snapshot-unavailable,safety-publication-clock-out-of-budget", source: "safety-score-v9-publication" });
    expect(body.provenance?.liveSafetyHydration?.fallback).toBeUndefined(); expect(res.headers.get("Warning")).toContain("199");
  });

  it("serves the publish-time snapshot when live safety hydration throws", async () => {
    const db = mkDb(basePay, nowS() - 30); failIdx(true);
    const body = await getJson(db);
    expect(body.rankings[0]).toMatchObject({ safetyScore: 40, pharosYieldScore: null });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "degraded", reason: "safety-hydration-error", fallback: "publish-time-snapshot" });
    expect(body.warnings?.[0]).toMatchObject({ code: "yield-safety-hydration-stale", reasons: ["safety-hydration-error"] });
  });

  it.each([
    ["lack the publication contract", () => { const { publication: _p, ...leg } = basePay; return leg; }, V748_AT],
    ["JSON is malformed", () => "{bad json", null],
    ["JSON fails schema validation", () => ({ rankings: "not-an-array", updatedAt: nowS() - 30 }), null],
  ])("returns 503 when cached rankings %s", async (_l, mkP, at) => {
    const res = await handle(mkDb(mkP(), at ?? nowS() - 30));
    expect(res.status).toBe(503); await expect(res.json()).resolves.toEqual({ error: "Cached yield-rankings payload is malformed" });
    expect(mIdx).not.toHaveBeenCalled();
  });

  it("uses nested sourceRiskPenalty when live safety hydration recomputes PYS", async () => {
    const row = await rowOf([ratedRow({ yieldType: "lending-vault", sourceRisk: { sourceRiskPenalty: 2 } })]);
    expect(row).toMatchObject({ safetyScore: 66, sourceRisk: { sourceRiskPenalty: 2 }, pharosYieldScore: computePYS({ apy30d: baseRow.apy30d, safetyScore: 66, apyVarianceScore: varScore(baseRow.yieldStability), scalingFactor: basePay.scalingFactor, benchmarkRate: baseRow.benchmarkRate ?? null, sourceRiskPenalty: 2 }) });
  });

  it("does not requalify a stale published PYS during live safety hydration", async () => {
    expect(await rowOf([ratedRow({ pharosYieldScore: null, pysNullReason: "source-stale", warningSignals: ["data-stale"], provenance: { ...baseRow.provenance, sourceFreshness: "stale", benchmarkFreshness: "healthy", scoreQualified: false } })]))
      .toMatchObject({ pharosYieldScore: null, pysNullReason: "source-stale", warningSignals: ["data-stale", "opportunity-evidence-missing"] });
  });

  it("keeps unreviewed Royco tranche rows NR during live safety hydration", async () => {
    const sh = { deploymentPlace: "structured-tranche", venueProtocol: "royco-dawn", venueChain: "ethereum", venueRiskTier: "unknown" as const, marketStatus: "normal", marketCoverageRatio: 0.36, marketMinCoverageRatio: 0.15, marketUtilizationRatio: 0.41, marketUtilizationLimitRatio: 0.9, marketDrawdownRatio: 0 };
    const row = await rowOf([ratedRow({
      yieldSource: "Royco Dawn Senior: Rated Coin", yieldType: "structured-tranche", safetyScore: 50, safetyGrade: "C-",
      provenance: { ...baseRow.provenance, sourceKey: "royco-dawn:1:0xabc:senior", safetyProvenance: "cached-publish" },
      sourceRisk: { ...sh, sourceRiskPenalty: 1.2, trancheSide: "senior", trancheTvlUsd: 2_900_000, kycRequired: true, accessRestricted: true, investabilityFlags: ["kyc-required", "us-persons-restricted", "withdrawals-underlying-dependent"] },
      altSources: [{ sourceKey: "royco-dawn:1:0xabc:junior", yieldSource: "Royco Dawn Junior: Rated Coin", yieldType: "structured-tranche", currentApy: 12, apy30d: 11, sourceTvlUsd: 1_500_000, dataSource: "protocol-api", sourceRisk: { ...sh, sourceRiskPenalty: 1.3, trancheSide: "junior", trancheTvlUsd: 1_500_000, underlyingSafetyScore: 50, trancheSafetyScore: 20, trancheSafetyPenalty: 30 } }],
    })]);
    expect(row).toMatchObject({ safetyScore: 66, safetyGrade: "B-", pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing", provenance: { safetyProvenance: "live-report-card", usedDefaultSafety: false, scoreQualification: "NR" }, sourceRisk: { underlyingSafetyScore: 66, trancheSafetyScore: null, trancheSafetyPenalty: null, trancheSide: "senior", opportunityRisk: { missingCriticalEvidence: ["venue-review"] } } });
    expect(row?.altSources[0]?.sourceRisk).toMatchObject({ underlyingSafetyScore: 66, trancheSafetyScore: null, trancheSafetyPenalty: null, trancheSide: "junior", opportunityRisk: { missingCriticalEvidence: ["venue-review"] } });
  });

  it.each([null, undefined])("withholds Royco PYS on hydration when market status is %s", async (marketStatus) => {
    const risk = { venueProtocol: "royco-dawn", venueRiskWeighted: 3, trancheSide: "junior" as const, marketStatus, marketTvlUsd: 2e6, trancheTvlUsd: 1e6, trancheSafetyScore: 47, trancheSafetyPenalty: 33 };
    const row = await rowOf([{ ...baseRow, id: "rated-coin", yieldType: "structured-tranche", sourceRisk: risk, provenance: { ...baseRow.provenance!, sourceKey: "royco-dawn:1:market:junior" }, altSources: [{ ...baseRow.altSources[0], yieldType: "structured-tranche", sourceKey: "royco-dawn:1:other:junior", sourceRisk: risk }] }]);
    expect(row).toMatchObject({ currentApy: baseRow.currentApy, pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing", provenance: { scoreQualification: "NR" }, sourceRisk: { trancheSafetyScore: null, trancheSafetyPenalty: null, opportunityRisk: { opportunitySafetyScore: null, missingCriticalEvidence: ["market-status"] } } });
    expect(row.warningSignals).toContain("opportunity-evidence-missing");
    expect(row.altSources[0].sourceRisk?.opportunityRisk?.missingCriticalEvidence).toEqual(["market-status"]);
  });

  it.each([null, { score: 40, grade: "NR" }])("preserves complete Royco underlying unrating on hydration for %j", async (und) => {
    const at = nowS() - 30;
    const db = dbWith([{ ...baseRow, id: "rated-coin", yieldType: "structured-tranche", sourceTvlUsd: 2e6, sourceRisk: { venueProtocol: "royco-dawn", venueRiskWeighted: 3, trancheSide: "junior", marketStatus: "normal", marketTvlUsd: 2e6 }, provenance: { ...baseRow.provenance!, sourceKey: "royco-dawn:1:market:junior" } }], {}, at);
    mIdx.mockResolvedValue(idxSrc(und ? [["rated-coin", und.score, und.grade]] : [], curId, at));
    const row = (await getJson(db)).rankings[0];
    expect(row).toMatchObject({ safetyGrade: "NR", provenance: { safetyReason: und ? "report-card-grade-not-rated" : "report-card-score-missing" } });
    if (und) { expect(row).toMatchObject({ safetyScore: null, pharosYieldScore: null, pysNullReason: "safety-unrated", provenance: { usedDefaultSafety: false, scoreQualification: "NR" }, sourceRisk: { underlyingSafetyScore: null, trancheSafetyScore: null, trancheSafetyPenalty: null } }); expect(row.sourceRisk?.opportunityRisk).toBeUndefined(); }
    else expect(row.sourceRisk?.opportunityRisk?.opportunitySafetyScore).toBeTypeOf("number");
  });

  it.each(["detailed", "summary"])("keeps healthy fallback-usd selection separate from feed health in %s", async (proj) => {
    const at = nowS() - 30;
    const db = dbWith([{ ...baseRow, id: "rated-coin", benchmarkSelectionMode: "fallback-usd", provenance: { ...baseRow.provenance!, sourceObservedAt: at, benchmarkSelectionMode: "fallback-usd", benchmarkFreshness: "healthy" } }], { benchmarks: { USD: { ...baseBench, fetchedAt: at, maxFetchAgeSec: 172800, maxRecordAgeSec: 432000 } } }, at);
    const body = await getJson(db, new URL(`https://api.pharos.watch/api/yield-rankings${proj === "summary" ? "?projection=summary" : ""}`));
    expect(body.rankings[0].benchmarkSelectionMode).toBe("fallback-usd");
    expect(body.rankings[0].warningSignals).not.toContain("benchmark-degraded");
    expect(body.rankings[0].provenance?.scoreQualification).not.toBe("estimated");
    if (proj === "detailed") expect(body.rankings[0].provenance?.benchmarkFreshness).toBe("healthy");
    expect(body.benchmarks?.USD).toMatchObject({ maxFetchAgeSec: 172800, maxRecordAgeSec: 432000 });
  });

  it("rehydrates generic external opportunities with market-level safety", async () => {
    const row = await rowOf([ratedRow({ safetyScore: 50, safetyGrade: "C-", sourceRisk: { venueRiskWeighted: 3, venueRiskTier: "medium", sourceRiskPenalty: 1.1, opportunityRisk: { opportunityClass: "lending", underlyingSafetyScore: 50, opportunitySafetyScore: 45, opportunitySafetyPenalty: 5, venueReviewed: true, missingCriticalEvidence: [] } } })]);
    expect(row).toMatchObject({ safetyScore: 61, safetyGrade: "C+", provenance: { safetyProvenance: "opportunity-safety" }, sourceRisk: { opportunityRisk: { opportunityClass: "lending", underlyingSafetyScore: 66, opportunitySafetyScore: 61, opportunitySafetyPenalty: 5, missingCriticalEvidence: [] } }, pharosYieldScore: computePYS({ apy30d: baseRow.apy30d, safetyScore: 61, apyVarianceScore: varScore(baseRow.yieldStability), scalingFactor: basePay.scalingFactor, benchmarkRate: baseRow.benchmarkRate ?? null, sourceRiskPenalty: 1.1 }) });
  });

  it("keeps an external opportunity listed as NR when critical market evidence is missing", async () => {
    const row = await rowOf([ratedRow({ sourceTvlUsd: null, pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing", sourceRisk: { venueRiskTier: "unknown", opportunityRisk: { opportunityClass: "lending", underlyingSafetyScore: 50, opportunitySafetyScore: null, opportunitySafetyPenalty: null, venueReviewed: false, missingCriticalEvidence: ["venue-review", "market-size"] } } })]);
    expect(row).toMatchObject({ pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing", provenance: { scoreQualification: "NR" }, sourceRisk: { opportunityRisk: { underlyingSafetyScore: 66, opportunitySafetyScore: null, missingCriticalEvidence: ["venue-review", "market-size"] } } });
    expect(row?.warningSignals).toContain("opportunity-evidence-missing"); expect(row?.warningSignals).not.toContain("safety-unrated");
  });

  it("preserves the explicit publication contract and nested source risk without row synthesis", async () => {
    const at = nowS() - 30, rew = goldRisk("reward-heavy", { sourceRiskScore: 76, sourceDepthRatio: 0.12, venueRiskTier: "medium" }), stale = goldRisk("stale-source-age");
    const { publicationGenerationId: _g, publishedRank: _r, ...stripped } = baseRow;
    const body = await getJson(dbWith([{ ...stripped, id: "rated-coin", symbol: "RATE", name: "Rated Coin", sourceRisk: rew, altSources: [{ ...baseRow.altSources[0], sourceRisk: stale }] }], { publication: pub(at, GOLD_GEN), methodology: { version: Y_VER, versionLabel: `v${Y_VER}`, currentVersion: Y_VER, currentVersionLabel: `v${Y_VER}`, changelogPath: "/methodology/yield-intelligence", asOf: at, isCurrent: true } }, at));
    expect(body.methodology?.version).toBe(Y_VER);
    expect(body.publication).toMatchObject({ generationId: GOLD_GEN, status: "published", cutoffAt: at });
    expect(body.rankings[0]).toMatchObject({ sourceRisk: { sourceRiskPenalty: rew.sourceRiskPenalty, sourceRiskScore: 76, sourceDepthRatio: 0.12, rewardShare: rew.rewardShare, venueRiskTier: "medium" } });
    expect([body.rankings[0]?.publicationGenerationId, body.rankings[0]?.publishedRank]).toEqual([undefined, undefined]);
    expect(body.rankings[0]?.altSources[0]?.sourceRisk).toMatchObject({ sourceRiskPenalty: stale.sourceRiskPenalty, venueRiskTier: "unknown" });
  });

  it("does not treat flattened source-risk shorthand as public rankings evidence", async () => {
    const row = await rowOf([ratedRow({ sourceRiskPenalty: goldRow("reward-heavy").expectedDerivedPenalty })]);
    expect(row?.sourceRisk?.sourceRiskPenalty).toBeUndefined();
    expect(Object.keys(row?.sourceRisk ?? {}).sort()).toEqual(["opportunityRisk", "underlyingSafetyScore"]);
    expect(row?.sourceRisk?.opportunityRisk?.opportunitySafetyScore).toBeNull();
    expect((row as unknown as Record<string, unknown>)?.sourceRiskPenalty).toBeUndefined();
    expect(row).toMatchObject({ pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing" });
  });

  it("preserves publishedRank and assigns liveRank after safety hydration reorders rows", async () => {
    const vr = { ...baseRow, yieldType: "lending-vault" as const };
    const body = await getJson(dbWith([{ ...vr, id: "nr-coin", symbol: "NRC", name: "NR Coin", currentApy: 10, apy7d: 10, apy30d: 10, pharosYieldScore: 15, publishedRank: 1 }, { ...vr, id: "rated-coin", symbol: "RATE", name: "Rated Coin", currentApy: 5, apy7d: 5, apy30d: 5, pharosYieldScore: 8, publishedRank: 2 }]));
    expect(body.rankings.map((r) => r.id)).toEqual(["rated-coin", "nr-coin"]);
    expect(body.rankings[0]).toMatchObject({ id: "rated-coin", publishedRank: 2, liveRank: 1, rankChangeAttribution: { previousRank: 2, rankDelta: 1, previousPys: 8, primaryDriver: "stablecoin-safety" } });
    expect(body.rankings[1]).toMatchObject({ id: "nr-coin", publishedRank: 1, liveRank: 2 });
    const d = computePYS({ apy30d: 5, safetyScore: 66, apyVarianceScore: varScore(vr.yieldStability), scalingFactor: basePay.scalingFactor, benchmarkRate: vr.benchmarkRate ?? null, sourceRiskPenalty: null }) - 8;
    expect(body.rankings[0]?.rankChangeAttribution?.pysDelta).toBe(d);
    expect(body.rankings[0]?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBe(d);
  });

  it("accepts nullable optional publication, source-risk, rank, and attribution scaffolding", () => {
    const parsed = RespSchema.parse({
      ...basePay, publication: { generationId: null, updatedAt: null, cutoffAt: null, schemaVersion: null, status: null },
      rankings: basePay.rankings.map((r) => ({ ...r, publicationGenerationId: null, publishedRank: null, liveRank: 1, sourceRisk: { sourceRiskScore: null, sourceRiskPenalty: null, sourceDepthRatio: null, rewardShare: null, sourceAgeSeconds: null, observationCount30d: null, sourceSwitchCount30d: null, deploymentPlace: null, venueProtocol: null, venueChain: null, venueRiskTier: "unknown", investabilityFlags: [] }, rankChangeAttribution: { previousRank: null, rankDelta: null, previousPys: null, pysDelta: null, primaryDriver: null, driverContributions: { apy: null, sourceRisk: null } }, altSources: r.altSources.map((a) => ({ ...a, sourceRisk: { sourceRiskScore: null, sourceRiskPenalty: null, observationCount30d: null, sourceSwitchCount30d: null, venueRiskTier: null } })) })),
    });
    expect(parsed.publication?.generationId).toBeNull();
    expect(parsed.rankings[0]).toMatchObject({ liveRank: 1, sourceRisk: { venueRiskTier: "unknown" }, rankChangeAttribution: { driverContributions: { sourceRisk: null } } });
    expect(parsed.rankings[0]?.altSources[0]?.sourceRisk?.sourceRiskPenalty).toBeNull();
  });

  it("propagates decisionLedger through the cache round-trip on the public payload", async () => {
    const dl = { selectedReasonCode: "curated-over-discovered" as const, previousBestSourceKey: "defillama-auto:legacy", sourceSwitch: true, apy30dDeltaFromPrevious: null, rejectedCount: 1, alternatives: [{ sourceKey: "defillama-auto:compound-v3:usdc", yieldSource: "Compound V3 USDC", apy30dDelta: -0.51, rejectionReasonCode: "lower-confidence" as const }] };
    expect((await rowOf([{ ...baseRow, decisionLedger: dl }]))?.decisionLedger).toEqual(dl);
  });

  it("returns 503 when cache is empty", async () => {
    expect((await handle(mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key =", matchBinds: ["yield-rankings:v2", "yield-rankings"], rows: [], first: null }]))).status).toBe(503);
  });

  it("keeps the coherent publish-time snapshot when the accepted compact index is held", async () => {
    const at = nowS() - 30, db = mkDb(basePay, at), acc = idxSrc([["usdc-circle", 88, "A"]], curId, at);
    if (acc.kind !== "v9") throw new Error("Missing accepted test identity");
    mIdx.mockResolvedValueOnce({ kind: "held", reason: "v9-publication-held", detail: "The accepted publication is held", snapshot: { ...acc.snapshot, publicationHealth: { ...acc.snapshot.publicationHealth, status: "held", heldSinceSec: at, reasons: [{ code: "dex-stale" }] } } });
    const res = await handle(db), body = await readJson<YieldRankingsResponse & { _meta: { ageSeconds: number } }>(res, 200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(body.warnings?.[0]).toMatchObject({ code: "yield-safety-hydration-stale", reasons: ["safety-snapshot-unavailable", "v9-publication-held"] });
    expect(body.rankings).toHaveLength(1); expect(body.rankings[0]).toMatchObject({ id: "usdc-circle", currentApy: 4.72, safetyScore: 40, safetyGrade: "NR", pharosYieldScore: null });
    expect(body.provenance?.liveSafetyHydration).toMatchObject({ kind: "degraded", reason: "safety-snapshot-unavailable,v9-publication-held", fallback: "publish-time-snapshot", coveredCount: 0, trackedCount: 1, coverageRatio: 0 });
    expect(body._meta.ageSeconds).toBe(30);
  });

  it("keeps post-V9 rankings fresh for snapshots that are under one hour old", async () => {
    const at = nowS() - 3_500, res = await handle(mkDb({ rankings: [], riskFreeRate: 4.25, scalingFactor: 8, medianApy: 4.2, updatedAt: at, publication: pub(at), provenance: null }, at));
    const body = await readJson<{ _meta: { ageSeconds: number; status: string } }>(res, 200);
    expect(res.headers.get("Warning")).toContain("safety-identity-missing"); expect(body._meta).toMatchObject({ ageSeconds: 3_500, status: "fresh" });
  });

  const vRow = (id: string, name: string, pys: number, pr: number, at: number, k = `pool-${id}`) => mkRank({ id, symbol: name.slice(0, 3).toUpperCase(), name, yieldType: "lending-vault", currentApy: 4, apy7d: 4, apy30d: 4, apyBase: 4, safetyScore: 40, safetyGrade: "NR", pharosYieldScore: pys, publishedRank: pr, provenance: mkProv({ sourceKey: k, sourceObservedAt: at, sourceAgeSeconds: 30 }) });

  it("does not report movement for a tie-group reorder the publisher ranked by PYS alone", async () => {
    const at = nowS() - 30, tie = (n: string, r: number) => vRow(n.toLowerCase().replace(/\s+/g, "-"), n, 50, r, at, `pool-${r}`);
    const body = await getJson(dbWith([tie("Charlie Coin", 1), tie("Alpha Coin", 2), tie("Bravo Coin", 3)], {}, at));
    expect(body.rankings.map((r) => r.name)).toEqual(["Alpha Coin", "Bravo Coin", "Charlie Coin"]);
    expect(body.rankings.map((r) => r.publishedRank)).toEqual([2, 3, 1]); expect(body.rankings.map((r) => r.liveRank)).toEqual([1, 2, 3]);
    expect(body.rankings.map((r) => r.rankChangeAttribution)).toEqual([undefined, undefined, undefined]);
  });

  it("attributes stablecoin-safety only to the row whose own safety changed", async () => {
    const at = nowS() - 30, db = dbWith([vRow("mover-coin", "Mover Coin", 10, 1, at), vRow("stable-coin", "Stable Coin", 30, 2, at)], {}, at);
    mIdx.mockResolvedValueOnce(idxSrc([["mover-coin", 88, "A"], ["stable-coin", 40, "NR"]], curId, at));
    const body = await getJson(db), mov = body.rankings.find((e) => e.id === "mover-coin"), st = body.rankings.find((e) => e.id === "stable-coin");
    expect(mov?.rankChangeAttribution).toMatchObject({ previousRank: 2, rankDelta: 1, primaryDriver: "stablecoin-safety" });
    expect(mov?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBe(mov?.rankChangeAttribution?.pysDelta);
    expect(st?.rankChangeAttribution).toMatchObject({ previousRank: 1, rankDelta: -1 });
    expect(st?.rankChangeAttribution?.primaryDriver).not.toBe("stablecoin-safety"); expect(st?.rankChangeAttribution?.driverContributions?.stablecoinSafety).toBeNull();
  });

  it("serves no movement for a payload published under another methodology version", async () => {
    const at = nowS() - 30, pv = Y_VER.replace(/(\d+)$/, (d) => `${Math.max(0, Number(d) - 1)}`);
    const db = dbWith([{ ...baseRow, id: "mover-coin", symbol: "MOV", name: "Mover Coin", pharosYieldScore: 10, publishedRank: 1 }, { ...baseRow, id: "stable-coin", symbol: "STA", name: "Stable Coin", pharosYieldScore: 30, publishedRank: 2 }], { methodology: { version: pv, versionLabel: `v${pv}`, currentVersion: pv, currentVersionLabel: `v${pv}`, changelogPath: "/methodology/yield-intelligence", asOf: at, isCurrent: false } }, at);
    mIdx.mockResolvedValueOnce(idxSrc([["mover-coin", 88, "A"], ["stable-coin", 40, "NR"]], curId, at));
    const body = await getJson(db);
    expect(pv).not.toBe(Y_VER);
    expect([body.rankings.find((e) => e.id === "mover-coin")?.rankChangeAttribution, body.rankings.find((e) => e.id === "stable-coin")?.rankChangeAttribution]).toEqual([undefined, undefined]);
  });

  it("keeps a non-safety pysNullReason through the degraded safety path", async () => {
    const at = nowS() - (24 * 3600 + 60);
    const db = dbWith([{ ...baseRow, id: "stale-coin", symbol: "STA", name: "Stale Coin", pharosYieldScore: null, pysNullReason: "source-stale", warningSignals: ["data-stale"], provenance: { ...baseRow.provenance!, sourceFreshness: "stale", scoreQualified: false } }], {}, at);
    mIdx.mockResolvedValueOnce(idxSrc([["stale-coin", 88, "A"]], { ...v9Id("report-cards:v9:other"), evaluationBuildDigest: "c".repeat(64) }, at));
    const body = await getJson(db);
    expect(body.rankings[0]).toMatchObject({ safetyScore: null, pharosYieldScore: null, pysNullReason: "source-stale", warningSignals: expect.arrayContaining(["data-stale", "safety-unrated"]) });
    expect(body.provenance?.liveSafetyHydration?.fallback).toBeUndefined();
  });

  it("nulls the served score whenever a null reason is published", async () => {
    const body = await getJson(dbWith([{ ...baseRow, id: "zero-apy-coin", symbol: "ZRO", name: "Zero Apy Coin", yieldType: "lending-vault", currentApy: 0, apy7d: 0, apy30d: 0, apyBase: 0, pharosYieldScore: 0 }, ratedRow()]));
    expect(body.rankings.find((e) => e.id === "zero-apy-coin")).toMatchObject({ pharosYieldScore: null, pysNullReason: "apy-non-positive" });
  });

  it("reproduces the served score from the served source-risk penalty", async () => {
    const row = await rowOf([ratedRow({ yieldType: "lending-vault", safetyScore: 50, safetyGrade: "C-", sourceRisk: { sourceRiskPenalty: 1.2, venueRiskTier: "medium", sourceDepthRatio: 0.12 } })]);
    expect(row?.pharosYieldScore).toBe(computePYS({ apy30d: baseRow.apy30d, safetyScore: row?.safetyScore ?? 0, apyVarianceScore: varScore(baseRow.yieldStability), scalingFactor: basePay.scalingFactor, benchmarkRate: baseRow.benchmarkRate ?? null, benchmarkCurrency: baseRow.benchmarkCurrency ?? null, sourceRiskPenalty: row?.sourceRisk?.sourceRiskPenalty ?? null }));
  });

  it.each(["live", "publish-time"] as const)("ages unchanged observations across tiers with %s safety", async (br) => {
    const at = nowS(), db = dbWith([mkRank({ id: "rated-coin", dataSource: "onchain", yieldType: "lending-vault", safetyScore: 66, safetyGrade: "B-", provenance: mkProv({ sourceKey: "onchain:test", sourceObservedAt: at, sourceAgeSeconds: 0, usedDefaultSafety: false, sourceFreshness: "fresh", benchmarkRecordDate: "2026-03-12" }) })], {}, at);
    if (br === "publish-time") failIdx();
    const fresh = (await getJson(db)).rankings[0]; expect(fresh.provenance?.sourceFreshness).toBe("fresh"); expect(fresh.pharosYieldScore).not.toBeNull();
    vi.setSystemTime((at + 4 * 3600 + 1) * 1000);
    const ag = (await getJson(db)).rankings[0]; expect(ag.warningSignals).toContain("aging"); expect(ag.pharosYieldScore).not.toBeNull(); expect(ag.provenance?.sourceAgeSeconds).toBe(4 * 3600 + 1);
    vi.setSystemTime((at + 6 * 3600 + 1) * 1000);
    expect((await getJson(db)).rankings[0]).toMatchObject({ pharosYieldScore: null, pysNullReason: "source-stale", warningSignals: expect.arrayContaining(["data-stale"]), provenance: expect.objectContaining({ sourceFreshness: "stale", sourceMaxAgeSeconds: 6 * 3600 }) });
  });

  it("expires a clockless DeFiLlama score on the original batch clock", async () => {
    const at = nowS();
    const db = dbWith([mkRank({ id: "rated-coin", dataSource: "defillama", yieldType: "lending-vault", warningSignals: ["data-freshness-unknown"], sourceRisk: { sourceAgeSeconds: null }, provenance: mkProv({ sourceObservedAt: null, sourceAgeSeconds: null, sourceFreshness: "unknown" }) })], { methodology: buildYieldMethodology(at), provenance: { ...basePay.provenance!, dlPools: { ...basePay.provenance!.dlPools, updatedAt: at - 6 * 3600 + 30 } } }, at);
    const urls = [new URL("https://api.pharos.watch/api/yield-rankings"), new URL("https://api.pharos.watch/api/yield-rankings?projection=summary")];
    const stored = await Promise.all(urls.map((u) => handle(db, u)));
    vi.stubGlobal("caches", { default: { match: vi.fn(async (k: Request) => stored[urls.findIndex((u) => u.href === k.url)]) } });
    for (const r of stored) { expect(r.headers.get("Cache-Control")).toBe("public, s-maxage=30, max-age=30"); expect((await r.clone().json() as YieldRankingsResponse).rankings[0].pharosYieldScore).toEqual(expect.any(Number)); }
    for (const s of [29, 30]) { vi.setSystemTime((at + s) * 1000); for (const [i, u] of urls.entries()) expect(await readEdgeCache({ cacheKey: new Request(u), skipCache: false })).toBe(s === 29 ? stored[i] : null); }
    const bnd = await handle(db); expect(bnd.headers.get("Cache-Control")).toBe("no-store");
    expect((await readJson<YieldRankingsResponse>(bnd, 200)).rankings[0]).toMatchObject({ pharosYieldScore: expect.any(Number), pysNullReason: null, warningSignals: expect.arrayContaining(["data-freshness-unknown"]), provenance: { sourceObservedAt: null, sourceAgeSeconds: null, sourceFreshness: "unknown", scoreQualification: "partial" }, sourceRisk: { sourceAgeSeconds: null } });
    vi.setSystemTime((at + 31) * 1000); expect((await getJson(db)).rankings[0]).toMatchObject({ pharosYieldScore: null, pysNullReason: "source-stale" });
  });

  it("advances legacy source ages without an observation timestamp", async () => {
    const at = nowS(), db = dbWith([mkRank({ id: "rated-coin", dataSource: "onchain", sourceRisk: goldRisk("stale-source-age", { sourceAgeSeconds: 3600 }), provenance: mkProv({ sourceObservedAt: undefined, sourceAgeSeconds: 3600 }) })], {}, at);
    vi.setSystemTime((at + 5 * 3600 + 1) * 1000);
    expect((await getJson(db)).rankings[0]).toMatchObject({ sourceRisk: { sourceAgeSeconds: 6 * 3600 + 1 }, pysNullReason: "source-stale" });
  });

  it.each(["live", "publish-time"] as const)("keeps rate product evidence independent of healthy EFFR with %s safety", async (br) => {
    const at = nowS(); if (br === "publish-time") failIdx();
    for (const st of ["healthy", "retained", "stale", "hardcoded"] as const) {
      const prod = { ...baseBench, fetchedAt: st === "hardcoded" ? null : st === "stale" ? at - 49 * 3600 : at, ageSeconds: st === "hardcoded" ? null : st === "stale" ? 49 * 3600 : 0, source: st === "hardcoded" ? "hardcoded-fallback" : "fred", isFallback: st === "hardcoded", fallbackMode: st === "retained" ? "retained" : st === "hardcoded" ? "default" : null };
      const row = await rowOf([mkRank({ id: "ustbl-spiko", dataSource: "rate-derived", yieldType: "nav-appreciation", benchmarkKey: "USD_EFFR", safetyScore: 66, safetyGrade: "B-", provenance: mkProv({ sourceKey: "rate-derived", sourceObservedAt: at, sourceAgeSeconds: 0, sourceFreshness: "fresh" }) })], { benchmarks: { USD: prod, USD_EFFR: { ...baseBench, key: "USD_EFFR", fetchedAt: at } } }, at);
      expect(row.provenance?.benchmarkFreshness).toBe("healthy");
      if (st === "stale" || st === "hardcoded") expect(row).toMatchObject({ pysNullReason: "source-stale", pharosYieldScore: null });
      else { expect(row.pharosYieldScore).not.toBeNull(); expect(row.warningSignals.includes("reference-benchmark-degraded")).toBe(st === "retained"); }
    }
  });

  it.each(["live", "publish-time", "degraded"] as const)("honors issuer and fixing clocks with %s safety", async (br) => {
    const sun = Date.parse("2027-01-17T12:00:00Z") / 1000, fri = Date.parse("2027-01-15T00:00:00Z") / 1000;
    const repAt = fri + 11 * 3600 + 45 * 60, expAt = Date.parse("2027-01-19T11:45:00Z") / 1000, stAt = expAt + 2 * 3600;
    if (br !== "live") failIdx();
    for (const [now, fr, ag] of [[sun, "fresh", false], [expAt - 1, "fresh", false], [expAt, "fresh", true], [stAt, "fresh", true], [stAt + 1, "stale", false]] as const) {
      vi.setSystemTime(now * 1000);
      const { rankings } = await getJson(dbWith([
        mkRank({ id: "usyc-hashnote", dataSource: "protocol-api", safetyScore: 66, safetyGrade: "B-", warningSignals: ["aging"], provenance: mkProv({ sourceKey: "protocol-api:hashnote-usyc", sourceObservedAt: repAt }) }),
        mkRank({ id: "ustbl-spiko", dataSource: "rate-derived", benchmarkKey: "USD", safetyScore: 66, safetyGrade: "B-", warningSignals: ["aging"], provenance: mkProv({ sourceKey: "rate-derived", sourceObservedAt: fri, sourceMaxAgeSeconds: 5 * 86400 }) }),
      ], { benchmarks: { USD: { ...baseBench, recordDate: "2027-01-15", fetchedAt: now, maxRecordAgeSec: 5 * 86400 } }, provenance: { ...basePay.provenance!, safetySnapshot: { ...basePay.provenance!.safetySnapshot, publishedAt: br === "degraded" ? fri : now } } }, now));
      const nav = rankings.find((r) => r.dataSource === "protocol-api")!, fix = rankings.find((r) => r.dataSource === "rate-derived")!;
      expect(nav.provenance).toMatchObject({ sourceFreshness: fr, sourceMaxAgeSeconds: stAt - repAt });
      expect(nav.warningSignals.includes("aging")).toBe(ag); if (fr === "stale") expect(nav.pysNullReason).toBe("source-stale");
      expect(fix.provenance).toMatchObject({ sourceFreshness: "fresh", sourceMaxAgeSeconds: 5 * 86400 }); expect(fix.warningSignals).not.toContain("aging");
    }
  });

  it.each(["warning", "legacy-source", "legacy-linked-source"] as const)("withholds the xGLD comparison identified by %s", async (idKind) => {
    const at = nowS(), r = mkRank({ id: idKind === "legacy-linked-source" ? "xaut-tether" : "xgld-unitas", dataSource: "onchain", yieldType: "nav-appreciation", apy30d: 5, yieldStability: 1, excessYield: 1, benchmarkRate: 4, warningSignals: idKind === "warning" ? ["benchmark-unit-mismatch"] : [], provenance: mkProv({ sourceKey: idKind === "legacy-linked-source" ? "linked-variant:xgld-unitas:onchain:xgld-unitas" : idKind === "legacy-source" ? "onchain:xgld-unitas" : "onchain:quoted-in-xaut", sourceObservedAt: at, benchmarkFreshness: "healthy" }) });
    for (const br of ["live", "degraded"] as const) {
      if (br === "degraded") failIdx();
      const row = await rowOf([r], {}, at);
      expect(row).toMatchObject({ apy30d: 5, excessYield: null, pharosYieldScore: null, pysNullReason: "missing-inputs", provenance: { scoreQualification: "NR", scoreQualified: false } });
      expect(row.warningSignals).toContain("benchmark-unit-mismatch"); expect([row.benchmarkRate, row.provenance?.benchmarkFreshness]).toEqual([undefined, undefined]);
    }
  });

  it("hydrates a legacy MXN slot through the Easter-adjusted placement deadline", async () => {
    const dl = Date.parse("2026-04-02T12:00:00Z") / 1000;
    const db = dbWith([mkRank({ id: "rated-coin", yieldType: "nav-appreciation", benchmarkKey: "MXN", benchmarkCurrency: "MXN", provenance: mkProv({ sourceObservedAt: dl - 60 }) })], { benchmarks: { USD: { ...baseBench, recordDate: "2026-04-02", fetchedAt: dl - 60 }, MXN: { ...baseBench, key: undefined, currency: "MXN", recordDate: "2026-03-26", fetchedAt: dl - 60, maxRecordAgeSec: 5 * 86400 } } }, dl);
    for (const now of [dl, dl + 1]) {
      vi.setSystemTime(now * 1000);
      const [row] = (await getJson(db)).rankings;
      expect(row.provenance?.benchmarkFreshness).toBe(now === dl ? "healthy" : "stale"); expect(row.pysNullReason).toBe(now === dl ? null : "benchmark-stale");
    }
  });

  it.each(["live", "publish-time"] as const)("keeps configured dependencies separate with %s safety", async (br) => {
    const at = nowS(); if (br === "publish-time") failIdx();
    for (const id of ["ustbl-spiko", "eutbl-spiko"]) {
      for (const exp of [null, "USD", "USD_EFFR", "EUR"] as const) {
        const benchmarks = { USD: { ...baseBench, fetchedAt: at }, USD_EFFR: { ...baseBench, key: "USD_EFFR" as const, fetchedAt: at }, EUR: { ...baseBench, key: "EUR" as const, currency: "EUR", fetchedAt: at } };
        if (exp) benchmarks[exp].recordDate = "2026-01-01";
        const bk = id === "eutbl-spiko" ? "EUR" : "USD_EFFR", bc = id === "eutbl-spiko" ? "EUR" : "USD";
        const row = await rowOf([mkRank({ id, dataSource: "rate-derived", yieldType: "nav-appreciation", benchmarkKey: bk, benchmarkCurrency: bc, safetyScore: 66, safetyGrade: "B-", provenance: mkProv({ sourceKey: "rate-derived", sourceObservedAt: at, sourceAgeSeconds: 0, sourceFreshness: "fresh", benchmarkKey: bk, benchmarkCurrency: bc }) })], { benchmarks }, at);
        const reason = exp === (id === "ustbl-spiko" ? "USD" : "EUR") ? "source-stale" : exp === bk || (id === "eutbl-spiko" && exp === "USD") ? "benchmark-stale" : null;
        expect(row.pysNullReason, `${id}/${exp}`).toBe(reason);
        expect(row.provenance?.sourceFreshness).toBe(reason === "source-stale" ? "stale" : "fresh");
        if (reason) expect(row.pharosYieldScore).toBeNull(); else expect(row.pharosYieldScore).toBeTypeOf("number");
      }
    }
  });

  it.each(["live", "publish-time"] as const)("reassesses benchmark record dates with %s safety", async (br) => {
    vi.setSystemTime(new Date("2026-03-12T23:00:00Z"));
    const at = nowS(), rd = "2026-03-08";
    const db = dbWith([mkRank({ id: "rated-coin", dataSource: "price-derived", benchmarkKey: "USD", benchmarkRecordDate: rd, provenance: mkProv({ sourceObservedAt: at, sourceAgeSeconds: 0, benchmarkRecordDate: rd, benchmarkFreshness: "healthy" }) })], { benchmarks: { USD: { ...baseBench, fetchedAt: at, recordDate: rd } }, provenance: { ...basePay.provenance!, safetySnapshot: { ...basePay.provenance!.safetySnapshot, publishedAt: at } } }, at);
    if (br === "publish-time") failIdx();
    expect((await getJson(db)).rankings[0].provenance?.benchmarkFreshness).toBe("healthy");
    vi.setSystemTime(new Date("2026-03-13T01:00:01Z"));
    expect((await getJson(db)).rankings[0]).toMatchObject({ pysNullReason: "benchmark-stale", pharosYieldScore: null });
  });

  it.each([null, 23 * 3600])("expires held safety from its own timestamp (age %s)", async (age) => {
    const at = nowS();
    const db = mkDb({ ...basePay, provenance: { ...basePay.provenance!, safetySnapshot: { ...basePay.provenance!.safetySnapshot, publishedAt: age == null ? null : at - age, publicationGenerationId: "safety-original" } } }, at);
    failIdx();
    if (age != null) expect((await getJson(db)).provenance?.liveSafetyHydration).toMatchObject({ fallback: "publish-time-snapshot", publishedAt: at - age, publicationGenerationId: "safety-original" });
    vi.setSystemTime((at + 2 * 3600) * 1000);
    const ex = await getJson(db); expect(ex.rankings[0].safetyScore).toBeNull(); expect(ex.provenance?.liveSafetyHydration?.fallback).toBeUndefined();
  });

  it.each([0, 6 * 3600 + 1, 12 * 3600 + 1])("serves matching strict freshness contracts at age %s", async (age) => {
    const at = nowS(), db = mkDb(basePay, at); vi.setSystemTime((at + age) * 1000);
    const [fRes, sRes] = [await handle(db), await handle(db, new URL("https://example.com/api/yield-rankings?projection=summary"))];
    const full = RespSchema.parse(await fRes.json()), sum = SumSchema.parse(await sRes.json());
    expect(full._meta).toEqual(sum._meta);
    expect(full._meta).toMatchObject({ updatedAt: at, ageSeconds: age, assessedAt: at + age, freshBudgetSec: 6 * 3600, degradedBudgetSec: 12 * 3600, status: age === 0 ? "fresh" : age > 12 * 3600 ? "stale" : "degraded" });
    for (const r of [fRes, sRes]) if (age > 6 * 3600) { expect(full._meta?.reason).toBe("yield-publication-age"); expect(r.headers.get("Cache-Control")).toBe("no-store"); expect(r.headers.get("Warning")).toContain("110"); }
  });

  it.each([
    { label: "falls back to the published benchmark warning when the cached provenance carries no benchmark freshness", signal: "benchmark-stale", yt: undefined, stale: true },
    { label: "keeps a benchmark-degraded row scored while recording the degraded freshness", signal: "benchmark-degraded", yt: "lending-vault" as const, stale: false },
  ])("$label", async ({ signal, yt, stale }) => {
    const at = nowS() - 30;
    const row = await rowOf([ratedRow({ ...(yt ? { yieldType: yt } : {}), warningSignals: [signal], provenance: mkProv({ sourceKey: "pool-a", sourceObservedAt: at, sourceAgeSeconds: 30, previousBestSourceKey: "pool-a", benchmarkRecordDate: "2026-03-12" }) })], {}, at);
    if (stale) expect(row).toMatchObject({ pharosYieldScore: null, pysNullReason: "benchmark-stale", warningSignals: expect.arrayContaining(["benchmark-stale"]), provenance: expect.objectContaining({ benchmarkFreshness: "stale", scoreQualification: "NR", scoreQualified: false }) });
    else { expect(row?.pysNullReason ?? null).toBeNull(); expect(row?.pharosYieldScore).not.toBeNull(); expect(row?.provenance).toMatchObject({ benchmarkFreshness: "degraded", scoreQualification: "estimated" }); }
  });

  it("re-bases a non-USD row on the payload's own reference evidence, not the raw rate (A3)", async () => {
    const at = nowS() - 30, rd = new Date(at * 1000).toISOString().slice(0, 10);
    const pysArgs = { apy30d: 3, safetyScore: 80, apyVarianceScore: varScore(0.9), scalingFactor: 8, benchmarkRate: 2.17, benchmarkCurrency: "EUR", sourceRiskPenalty: null };
    const pubScore = computePYS({ ...pysArgs, usdBenchmarkRate: null });
    const eurRow = mkRank({ id: "eurc-circle", symbol: "EURC", name: "Euro Coin", currentApy: 3, apy7d: 3, apy30d: 3, apyBase: 3, apyReward: null, yieldSource: "EUR holder vault", yieldType: "nav-appreciation", dataSource: "protocol-api", sourceTvlUsd: 1e6, safetyScore: 80, safetyGrade: "B+", yieldStability: 0.9, benchmarkKey: "EUR", benchmarkLabel: "EUR €STR", benchmarkCurrency: "EUR", benchmarkRate: 2.17, benchmarkSelectionMode: "native", pharosYieldScore: pubScore, publishedRank: 1, warningSignals: ["reference-benchmark-degraded"], provenance: mkProv({ sourceKey: "protocol-api:eurc:vault", sourceObservedAt: at, sourceAgeSeconds: 30, previousBestSourceKey: "protocol-api:eurc:vault", benchmarkKey: "EUR", benchmarkLabel: "EUR €STR", benchmarkCurrency: "EUR", benchmarkRate: 2.17, benchmarkSelectionMode: "native", benchmarkRecordDate: "2026-03-12", scoreQualification: "estimated" }) });
    const serve = (benchmarks: NonNullable<YieldRankingsResponse["benchmarks"]>) => rowOf([eurRow], { benchmarks: { ...benchmarks, USD: { ...benchmarks.USD, recordDate: rd, fetchedAt: at, ageSeconds: 30 } } }, at);
    mIdx.mockImplementation(async () => idxSrc([["eurc-circle", 80, "B+"]], curId, at));
    const deg = await serve({ USD: { ...baseBench, isFallback: true, fallbackMode: "retained" } });
    expect(deg).toMatchObject({ pharosYieldScore: pubScore, provenance: { scoreQualification: "estimated" } }); expect(deg?.warningSignals).toContain("reference-benchmark-degraded");
    const ok = await serve({ USD: baseBench }), rebased = computePYS({ ...pysArgs, usdBenchmarkRate: 4.13 });
    expect(ok?.pharosYieldScore).toBe(rebased); expect(rebased).not.toBe(pubScore); expect(ok?.pharosYieldScore ?? 0).toBeGreaterThan(pubScore);
    expect(ok?.provenance?.scoreQualification).toBe("partial"); expect(ok?.warningSignals).not.toContain("reference-benchmark-degraded");
  });

  it("leaves an unmeasurable safety contribution null and names the benchmark for a rebased move (B7)", async () => {
    const at = nowS() - 30, rd = new Date(at * 1000).toISOString().slice(0, 10);
    const anc = mkRank({ id: "rated-coin", symbol: "RATE", name: "Rated Coin", yieldType: "lending-vault", currentApy: 12, apy7d: 12, apy30d: 12, apyBase: 12, safetyScore: 80, safetyGrade: "A", pharosYieldScore: 10, publishedRank: 2, provenance: mkProv({ sourceKey: "pool-anchor", sourceObservedAt: at, sourceAgeSeconds: 30 }) });
    const unsc = mkRank({ ...anc, id: "mover-coin", symbol: "MOVE", name: "Mover Coin", currentApy: 0, apy7d: 0, apy30d: 0, apyBase: 0, pharosYieldScore: 40, publishedRank: 1, provenance: mkProv({ sourceKey: "pool-mover", sourceObservedAt: at, sourceAgeSeconds: 30 }) });
    const reb = mkRank({ ...anc, id: "rebased-coin", symbol: "REB", name: "Rebased Coin", currentApy: 3, apy7d: 3, apy30d: 3, apyBase: 3, benchmarkKey: "EUR", benchmarkLabel: "EUR €STR", benchmarkCurrency: "EUR", benchmarkRate: 2.17, pharosYieldScore: 100, publishedRank: 1, provenance: mkProv({ sourceKey: "pool-rebased", sourceObservedAt: at, sourceAgeSeconds: 30, benchmarkKey: "EUR", benchmarkCurrency: "EUR", benchmarkRate: 2.17 }) });
    mIdx.mockImplementation(async () => idxSrc([["mover-coin", 88, "A"], ["rated-coin", 80, "A"], ["rebased-coin", 80, "A"]], curId, at));
    const run = async (r: YieldRanking) => (await getJson(dbWith([r, anc], { benchmarks: { USD: { ...baseBench, recordDate: rd, fetchedAt: at, ageSeconds: 30 } } }, at))).rankings.find((e) => e.id === r.id);
    expect((await run(unsc))?.rankChangeAttribution).toMatchObject({ primaryDriver: "stablecoin-safety", pysDelta: null, driverContributions: { stablecoinSafety: null } });
    const rm = await run(reb);
    expect(rm?.rankChangeAttribution?.pysDelta).not.toBeNull();
    expect(rm?.rankChangeAttribution).toMatchObject({ primaryDriver: "benchmark", driverContributions: { benchmark: rm?.rankChangeAttribution?.rankDelta, apy: null } });
  });
});

describe("yield rankings pipeline-gap rank attribution", () => {
  const NOW = Date.parse("2026-03-13T16:00:00Z") / 1000;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); mIdx.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("names the lost safety score, not an unchanged APY, as the driver", async () => {
    const at = NOW - 30, id = v9Id(`report-cards:v9:${NOW}`), bm = usdBench(at, { rate: 4.25, ageSeconds: 30 });
    const db = mkDb({
      rankings: [
        mkRank({ id: "rated-coin", symbol: "RATE", name: "Rated Coin", currentApy: 5.3, apy7d: 5.2, apy30d: 5.1, apyBase: 5.1, yieldSource: "Source A", sourceTvlUsd: 1e6, pharosYieldScore: 20, safetyScore: 80, safetyGrade: "A", publishedRank: 1, provenance: mkProv({ sourceKey: "pool-a", sourceObservedAt: at, sourceAgeSeconds: 30, benchmarkRecordDate: "2026-03-12" }) }),
        mkRank({ id: "peer-coin", symbol: "PEER", name: "Peer Coin", currentApy: 6.5, apy7d: 6.4, apy30d: 6.3, apyBase: 6.3, yieldSource: "Source B", sourceTvlUsd: 2e6, pharosYieldScore: 10, safetyScore: 40, safetyGrade: "NR", publishedRank: 2, provenance: mkProv({ sourceKey: "pool-b", sourceObservedAt: at, sourceAgeSeconds: 30, benchmarkRecordDate: "2026-03-12" }) }),
      ],
      riskFreeRate: 4.25, benchmarks: { USD: bm }, scalingFactor: 8, medianApy: 4.2, updatedAt: at, publication: pub(at),
      provenance: { selectionMethod: "confidence-weighted", benchmark: bm, benchmarks: { USD: bm }, dlPools: { mode: "dex-cache", updatedAt: at, ageSeconds: 30, poolCount: 10, fallbackMode: null }, safetySnapshot: { kind: "ok", coverageRatio: 1, coveredCount: 2, trackedCount: 2, reason: null, source: "safety-score-v9-publication", safetyScoreIdentity: id, publicationGenerationId: id.publicationGenerationId, methodologyVersion: id.methodologyVersion, publishedAt: at } },
    } satisfies YieldRankingsResponse, at);
    mIdx.mockResolvedValueOnce({ kind: "v9", snapshot: { lifecycle: "active", safetyScoreIdentity: id, methodology: { version: id.methodologyVersion }, asOfSec: NOW, updatedAt: NOW, publicationHealth: { schemaVersion: 2, status: "current", acceptedPublicationGenerationId: id.publicationGenerationId, acceptedAtSec: NOW, attemptedAtSec: NOW, heldSinceSec: null, reasons: [] }, completeness: { expectedCount: 2 }, cards: [{ id: "rated-coin", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null }, { id: "peer-coin", score: 60, grade: "B", ratingStatus: "rated", partialEvidence: null }] } });
    expect((await getJson(db)).rankings.find((r) => r.id === "rated-coin")).toMatchObject({ currentApy: 5.3, safetyScore: null, safetyGrade: null, safetyReason: "safety-snapshot-unavailable", pharosYieldScore: null, liveRank: 2, provenance: { safetyProvenance: "safety-snapshot-unavailable" }, rankChangeAttribution: { previousRank: 1, rankDelta: -1, primaryDriver: "stablecoin-safety", driverContributions: { apy: null } } });
  });
});

describe("VERITAS-II finding: degraded yield rows retain nested safety numbers", () => {
  it.each(["B+", null] as const)("removes every selected and alternate-source safety derivative when compact safety is unavailable (cached grade %s)", async (safetyGrade) => {
    const at = nowS() - 30;
    const sr = { sourceRiskScore: 72, sourceRiskPenalty: 1.1, underlyingSafetyScore: 80, trancheSafetyScore: 74, trancheSafetyPenalty: 6, opportunityRisk: { opportunityClass: "lending" as const, underlyingSafetyScore: 80, opportunitySafetyScore: 75, opportunitySafetyPenalty: 5, venueReviewed: true, missingCriticalEvidence: [] } };
    const pay: YieldRankingsResponse = {
      rankings: [mkRank({ id: "risk-row", symbol: "RISK", name: "Risk Row", currentApy: 6.2, apy7d: 6.1, apy30d: 6, apyBase: 6, yieldSource: "Reviewed lending market", sourceTvlUsd: 10e6, pharosYieldScore: 42, safetyScore: 75, safetyGrade, yieldToRisk: 0.23, excessYield: 1.5, apyVariance30d: 0.2, apyMin30d: 5.8, apyMax30d: 6.3, sourceRisk: sr, rankChangeAttribution: { previousPys: 42, pysDelta: -3, primaryDriver: "stablecoin-safety", driverContributions: { stablecoinSafety: -3, apy: 1 } }, altSources: [mkAlt({ sourceKey: "alternate-risk-row", yieldSource: "Alternate reviewed market", yieldType: "lending-opportunity", currentApy: 5.9, apy30d: 5.8, sourceTvlUsd: 8e6, dataSource: "protocol-api", sourceRisk: sr })], provenance: null })],
      riskFreeRate: 4.5, scalingFactor: 8, medianApy: 4.8, updatedAt: at, publication: pub(at), provenance: null,
    };
    const db = mockD1(cacheRows(JSON.stringify(pay), at));
    mIdx.mockResolvedValueOnce({ kind: "error", reason: "safety-score-index-missing", detail: "Compact safety index is unavailable", snapshot: null });
    const row = (await getJson(db)).rankings[0]!;
    expect(row).toMatchObject({ safetyScore: null, safetyGrade: null, safetyReason: "safety-snapshot-unavailable", pharosYieldScore: null, pysNullReason: "source-freshness-unknown", yieldToRisk: null });
    for (const r of [row.sourceRisk, row.altSources[0]?.sourceRisk]) for (const f of ["underlyingSafetyScore", "trancheSafetyScore", "trancheSafetyPenalty", "opportunityRisk"] as const) expect(r?.[f] ?? null).toBeNull();
    expect(row.rankChangeAttribution).toBeUndefined();
  });
});
