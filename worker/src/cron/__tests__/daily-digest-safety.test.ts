import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { collectGradeTransitions } from "../daily-digest/collectors-risk";
import type {
  CanonicalSafetyGradeRow,
  CollectorContext,
} from "../daily-digest/collectors-shared";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { DigestInputData } from "@shared/types/digest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { buildDigestSafetyMapCapture } from "../daily-digest/input";
import { buildEditorialCandidates } from "../daily-digest/editorial-candidates";
import { buildUserPrompt } from "../daily-digest/prompt";
import { BASE_DIGEST_INPUT, BASE_SAFETY_CONTEXT, VALID_CAPTURE_MAP_SUMMARY } from "./daily-digest.test-support";

const openDatabases: DatabaseSync[] = [];
const nowSec = 1_785_000_000;
const identity: SafetyScoreV9PublicationIdentity = {
  model: "v9",
  schemaVersion: 1,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: "a".repeat(64),
  evaluationBuildDigest: "b".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:current",
};

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  openDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertHistory(
  sqlite: DatabaseSync,
  overrides: Partial<{
    historyId: string;
    stablecoinId: string;
    grade: string;
    score: number;
    transitionKind: string;
    policyId: string;
    policyDigest: string;
    evaluationBuildDigest: string;
    baseInputGenerationId: string;
    publicationGenerationId: string;
    prevGrade: string | null;
    prevScore: number | null;
  }> = {},
): void {
  sqlite.prepare(
    `INSERT INTO safety_score_history_v2 (
       history_id, stablecoin_id, recorded_at, model, identity_schema_version,
       methodology_version, policy_id, policy_digest, evaluation_build_digest,
       base_input_generation_id, model_publication_generation_id, transition_kind,
       grade, score, prev_grade, prev_score, created_at
     ) VALUES (?, ?, ?, 'v9', 1, '9.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.historyId ?? "organic-current",
    overrides.stablecoinId ?? "usdt-tether",
    nowSec - 60,
    overrides.policyId ?? identity.policyId,
    overrides.policyDigest ?? identity.policyDigest,
    overrides.evaluationBuildDigest ?? identity.evaluationBuildDigest,
    overrides.baseInputGenerationId ?? `report-cards-input:v1:${"d".repeat(64)}`,
    overrides.publicationGenerationId ?? "report-cards:v9:prior",
    overrides.transitionKind ?? "organic-grade-change",
    overrides.grade ?? "A",
    overrides.score ?? 88,
    overrides.prevGrade === undefined ? "B+" : overrides.prevGrade,
    overrides.prevScore === undefined ? 84 : overrides.prevScore,
    nowSec - 60,
  );
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("daily digest Safety Score transitions", () => {
  it("uses comparable V2 organic rows and excludes activation/build/policy boundaries", async () => {
    const { sqlite, db } = createHarness();
    insertHistory(sqlite);
    insertHistory(sqlite, {
      historyId: "activation-boundary",
      transitionKind: "methodology-boundary-baseline",
      prevGrade: null,
      prevScore: null,
    });
    insertHistory(sqlite, {
      historyId: "other-build",
      evaluationBuildDigest: "e".repeat(64),
    });
    insertHistory(sqlite, {
      historyId: "other-policy",
      policyId: "other-policy",
      policyDigest: "f".repeat(64),
    });

    const asset = makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      circulating: { peggedUSD: 100_000_000 },
    });
    const ctx: CollectorContext = {
      db,
      trackedStablecoinAssets: [asset],
      trackedStablecoinIds: new Set([asset.id]),
      coreAggregateStablecoinAssets: [asset],
      coreAggregateStablecoinIds: new Set([asset.id]),
      stablecoinAssetById: new Map([[asset.id, asset]]),
      mcapById: new Map([[asset.id, 100_000_000]]),
      stablecoinsCacheIsFresh: true,
      nowSec,
      todayTs: nowSec - (nowSec % 86_400),
      yesterdayTs: nowSec - (nowSec % 86_400) - 86_400,
    };
    const pillar = {
      score: 88,
      evidenceLevel: "strong",
      freshness: "current",
      reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }],
    };
    const grades: CanonicalSafetyGradeRow[] = [{
      id: asset.id,
      symbol: asset.symbol,
      grade: "A",
      score: 88,
      pillars: { backing: pillar, exit: pillar, control: pillar },
      reasonCodes: ["bounded-mechanism-review"],
      caps: [],
      bindingCap: null,
    }];

    const transitions = await collectGradeTransitions(ctx, grades, identity);

    expect(transitions.value.gradeTransitions).toHaveLength(1);
    expect(transitions.value.gradeTransitions?.[0]).toMatchObject({
      historyId: "organic-current",
      model: "v9",
      symbol: "USDT",
      fromGrade: "B+",
      toGrade: "A",
      safetyScoreIdentity: {
        model: "v9",
        policyId: identity.policyId,
        evaluationBuildDigest: identity.evaluationBuildDigest,
        baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
        publicationGenerationId: "report-cards:v9:prior",
      },
      currentPillars: {
        backing: { score: 88 },
        exit: { score: 88 },
        control: { score: 88 },
      },
    });
  });

  it("does not score an NR baseline as a measured zero-point move", async () => {
    const { sqlite, db } = createHarness();
    // USDT re-entered the rated cohort at B (42) from NR, whose published score is null.
    insertHistory(sqlite, {
      historyId: "usdt-nr-to-b", stablecoinId: "usdt-tether", grade: "B", score: 42,
      prevGrade: "NR", prevScore: null,
    });
    // Control: USDC fell B+ (60) -> B (18), a genuinely measured 42-point drop.
    insertHistory(sqlite, {
      historyId: "usdc-b-plus-to-b", stablecoinId: "usdc-circle", grade: "B", score: 18,
      prevGrade: "B+", prevScore: 60,
    });
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1_000_000_000 } }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 1_000_000_000 } }),
    ];
    const ctx: CollectorContext = {
      db,
      trackedStablecoinAssets: assets,
      trackedStablecoinIds: new Set(assets.map((asset) => asset.id)),
      coreAggregateStablecoinAssets: assets,
      coreAggregateStablecoinIds: new Set(assets.map((asset) => asset.id)),
      stablecoinAssetById: new Map(assets.map((asset) => [asset.id, asset])),
      mcapById: new Map(assets.map((asset) => [asset.id, 1_000_000_000])),
      stablecoinsCacheIsFresh: true,
      nowSec,
      todayTs: nowSec - (nowSec % 86_400),
      yesterdayTs: nowSec - (nowSec % 86_400) - 86_400,
    };
    const pillar = {
      score: 42, evidenceLevel: "strong", freshness: "current",
      reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }],
    };
    const grades: CanonicalSafetyGradeRow[] = [
      { id: "usdt-tether", symbol: "USDT", grade: "B", score: 42, pillars: { backing: pillar, exit: pillar, control: pillar }, reasonCodes: [], caps: [], bindingCap: null },
      { id: "usdc-circle", symbol: "USDC", grade: "B", score: 18, pillars: { backing: pillar, exit: pillar, control: pillar }, reasonCodes: [], caps: [], bindingCap: null },
    ];
    const transitions = await collectGradeTransitions(ctx, grades, identity);
    expect(transitions.degradedReasons).toEqual([]);

    const input: DigestInputData = { ...BASE_DIGEST_INPUT, gradeTransitions: transitions.value.gradeTransitions };
    const candidates = new Map(
      buildEditorialCandidates(input)
        .filter((candidate) => candidate.kind === "grade")
        .map((candidate) => [candidate.id, candidate]),
    );
    expect(candidates.get("grade:usdc:b-:b")?.impactScore).toBe(42);
    const unmeasured = candidates.get("grade:usdt:nr:b");
    expect(unmeasured?.impactScore).toBe(0);
    expect(unmeasured?.title).toBe("USDT grade NR -> B");
    expect(unmeasured?.headlineFacts[0]).toContain("no measured score baseline");
  });

  it("names a failed grade-transition read instead of recording no movers", () => {
    const window = { start: nowSec - 2 * 86_400, end: nowSec };
    const input: DigestInputData = {
      ...BASE_DIGEST_INPUT,
      safetyContext: BASE_SAFETY_CONTEXT,
      gradeTransitionAccounting: { complete: false, window, reason: "grade-transitions-query" },
      degradedSources: ["grade-transitions-query"],
    };
    const moverLine = (prompt: string) =>
      prompt.split("\n").find((line) => line.trimStart().startsWith("Grade movers (last 48h)"));
    const failedLine = moverLine(buildUserPrompt(input));
    expect(failedLine).toBeDefined();
    expect(failedLine).not.toContain("none recorded");
    expect(failedLine).toContain("unavailable (grade-transitions-query)");

    // Positive control: a complete census of zero movers still says none recorded.
    const safetyMap = buildDigestSafetyMapCapture(input, {
      kind: "available",
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30",
      freshness: "carried-forward",
      ageDays: 2,
      manifest: {
        date: "2026-08-30", asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000,
        edition: "daily", bytes: { png: 1_000_000 }, mapSummary: VALID_CAPTURE_MAP_SUMMARY,
      },
    });
    expect(safetyMap).not.toBeNull();
    const observedEmpty = buildUserPrompt({
      ...input,
      safetyMap: safetyMap!,
      gradeTransitionAccounting: {
        complete: true, window, safetyScoreIdentity: BASE_SAFETY_CONTEXT.identity, count: 0, identities: [],
      },
      degradedSources: [],
    });
    expect(moverLine(observedEmpty)).toContain("none recorded");
  });
});
