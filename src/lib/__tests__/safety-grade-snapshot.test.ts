import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import {
  buildSafetyScoresPreview,
  formatSnapshotSafetyScoreLabel,
  getScoresLatestSnapshotRow,
  getSnapshotSafetyAssessment,
  toScoresLatestSnapshotRow,
  toSnapshotSafetyAssessment,
} from "@/lib/safety-grade-snapshot";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { scoreToGrade } from "@shared/types/safety-score-v9-grade";

describe("toSnapshotSafetyAssessment", () => {
  it("maps rated grades to the shared risk buckets", () => {
    expect(toSnapshotSafetyAssessment("A+", 95)).toEqual({ grade: "A+", score: 95, bucket: "safe" });
    expect(toSnapshotSafetyAssessment("B-", 62)).toEqual({ grade: "B-", score: 62, bucket: "safe" });
    expect(toSnapshotSafetyAssessment("C", 48)).toEqual({ grade: "C", score: 48, bucket: "neutral" });
    expect(toSnapshotSafetyAssessment("D", 30)).toEqual({ grade: "D", score: 30, bucket: "risky" });
    expect(toSnapshotSafetyAssessment("F", 10)).toEqual({ grade: "F", score: 10, bucket: "risky" });
  });

  it("drops unrated or malformed rows and non-finite scores", () => {
    expect(toSnapshotSafetyAssessment(null, 50)).toBeNull();
    expect(toSnapshotSafetyAssessment("NR", 50)).toBeNull();
    expect(toSnapshotSafetyAssessment("Z", 50)).toBeNull();
    expect(toSnapshotSafetyAssessment("B", "62")).toEqual({ grade: "B", score: null, bucket: "safe" });
    expect(toSnapshotSafetyAssessment("B", Number.NaN)).toEqual({ grade: "B", score: null, bucket: "safe" });
  });
});

describe("getSnapshotSafetyAssessment", () => {
  it("indexes the committed scores-latest mirror by stablecoin id", () => {
    // USDT is always rated in any real snapshot; an unknown id returns null.
    const usdt = getSnapshotSafetyAssessment("usdt-tether");
    expect(usdt).not.toBeNull();
    expect(["safe", "neutral", "risky"]).toContain(usdt!.bucket);
    expect(getSnapshotSafetyAssessment("not-a-coin")).toBeNull();
  });
});

describe("toScoresLatestSnapshotRow", () => {
  const AS_OF = "2026-10-22T08:00:50.000Z";

  it("projects a dated row, keeping unavailable values null rather than zero", () => {
    expect(toScoresLatestSnapshotRow({
      safetyGrade: "A-", safetyScore: 81, dewsScore: 17, dewsBand: "WATCH", liquidityScore: null,
    }, AS_OF)).toEqual({
      grade: "A-", score: 81, dewsScore: 17, dewsBand: "WATCH", liquidityScore: null, asOfMs: Date.parse(AS_OF),
    });
    // An unrated coin can still carry its DEWS and liquidity reads.
    expect(toScoresLatestSnapshotRow({ safetyGrade: "NR", liquidityScore: 0 }, AS_OF)).toMatchObject({
      grade: null, score: null, liquidityScore: 0,
    });
  });

  it("refuses undated rows, malformed bands and rows with nothing to show", () => {
    expect(toScoresLatestSnapshotRow({ safetyGrade: "A" }, undefined)).toBeNull();
    expect(toScoresLatestSnapshotRow({ safetyGrade: "A" }, "not-a-date")).toBeNull();
    expect(toScoresLatestSnapshotRow({ safetyGrade: "NR", dewsBand: "PANIC" }, AS_OF)).toBeNull();
  });

  it("indexes the committed mirror with its dataset clock", () => {
    const usdt = getScoresLatestSnapshotRow("usdt-tether");
    expect(usdt?.asOfMs).toBeGreaterThan(0);
    expect(usdt?.grade).toBe(getSnapshotSafetyAssessment("usdt-tether")?.grade);
    expect(getScoresLatestSnapshotRow("not-a-coin")).toBeNull();
  });
});

describe("formatSnapshotSafetyScoreLabel", () => {
  it("dates the release grade and score, and returns null for unrated ids", () => {
    const usdt = getSnapshotSafetyAssessment("usdt-tether")!;
    const score = usdt.score !== null ? ` (${usdt.score}/100)` : "";
    expect(formatSnapshotSafetyScoreLabel("usdt-tether"))
      .toBe(`Safety Score ${usdt.grade}${score} as of ${PUBLIC_DATASET_CURRENT_DATE}`);
    expect(formatSnapshotSafetyScoreLabel("not-a-coin")).toBeNull();
  });
});

describe("production scores-latest freshness assertion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PHAROS_PAGES_REPLAY", "");
  });

  afterEach(() => {
    vi.doUnmock("@/lib/datasets/public-dataset-current");
    vi.resetModules();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    { date: "2026-10-17", replay: "", allowed: true },
    { date: "2026-10-15", replay: "", allowed: true },
    { date: "2026-10-14", replay: "", allowed: false },
    { date: "2026-10-14", replay: "0", allowed: false },
    { date: "2026-10-14", replay: "true", allowed: false },
    { date: "2026-10-14", replay: "1", allowed: true },
    { date: "2026-10-18", replay: "", allowed: false },
    { date: "2026-10-18", replay: "1", allowed: false },
    { date: "invalid", replay: "", allowed: false },
    { date: "invalid", replay: "1", allowed: false },
  ])("date=$date replay=$replay allowed=$allowed", async ({ date, replay, allowed }) => {
    vi.stubEnv("PHAROS_PAGES_REPLAY", replay);
    vi.doMock("@/lib/datasets/public-dataset-current", () => ({
      PUBLIC_DATASET_CURRENT_DATE: date,
      PUBLIC_DATASET_MAX_AGE_DAYS: 2,
      PUBLIC_DATASET_CURRENT_EXPORTS: { "scores-latest": { rows: [] } },
    }));
    const snapshotModule = import("@/lib/safety-grade-snapshot");
    if (allowed) await expect(snapshotModule).resolves.toHaveProperty("getSnapshotSafetyAssessment");
    else await expect(snapshotModule).rejects.toThrow("Public scores-latest mirror is stale");
  });
});

const PREVIEW_IDENTITY = {
  model: "v9" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "10.34",
  evaluationBuildDigest: "a".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
  publicationGenerationId: "v9-publication-1",
  policyId: "safety-score-v9",
  policyDigest: "c".repeat(64),
};
const PREVIEW_SNAPSHOT_DATE = "2026-10-27";
const PREVIEW_PUBLISHED_AT_SEC = Date.parse("2026-10-27T08:00:00Z") / 1000;
const PREVIEW_ASSESSED_AT_SEC = Date.parse("2026-10-28T12:00:00Z") / 1000;
const PREVIEW_REGISTRY = [
  { id: "asset-a", name: "Asset A", symbol: "AAA" },
  { id: "asset-b", name: "Asset B", symbol: "BBB" },
  { id: "asset-c", name: "Asset C", symbol: "CCC" },
];

interface PreviewTestRow {
  stablecoinId: string;
  safetyScore?: number | null;
  safetyGrade?: string | null;
  ratingStatus?: "rated" | "not-rated" | "pipeline-gap" | null;
  safetyDisplay?: Record<string, unknown> | null;
}

function completenessFor(rows: readonly PreviewTestRow[]) {
  const cardRows = rows.filter((row) => row.ratingStatus != null);
  const notRatedIds = cardRows.filter((row) => row.ratingStatus === "not-rated").map((row) => row.stablecoinId).sort();
  const pipelineGapIds = cardRows.filter((row) => row.ratingStatus === "pipeline-gap").map((row) => row.stablecoinId).sort();
  return {
    expectedCount: cardRows.length,
    ratedCount: cardRows.filter((row) => row.ratingStatus === "rated").length,
    notRatedCount: notRatedIds.length,
    notRatedIds,
    pipelineGapCount: pipelineGapIds.length,
    pipelineGapIds,
  };
}

type PreviewProjectionOverrides = {
  snapshotDate?: string;
  publishedAtSec?: number;
  identity?: Record<string, unknown>;
  completeness?: Record<string, unknown>;
  safety?: null;
  safetyUnavailableReason?: "legacy-source-metadata-unavailable" | null;
};

function makePreviewProjection(
  rows: readonly PreviewTestRow[],
  overrides: PreviewProjectionOverrides = {},
) {
  const publishedAtSec = overrides.publishedAtSec ?? PREVIEW_PUBLISHED_AT_SEC;
  const identity = overrides.identity ?? PREVIEW_IDENTITY;
  return {
    version: 1 as const,
    snapshotDate: overrides.snapshotDate ?? PREVIEW_SNAPSHOT_DATE,
    capturedAtSec: publishedAtSec + 300,
    sourceSnapshotPath: `/api/snapshots/${overrides.snapshotDate ?? PREVIEW_SNAPSHOT_DATE}.json`,
    safety: overrides.safety === null ? null : {
      identity,
      asOfSec: publishedAtSec - 60,
      publishedAtSec,
      sourceGenerations: { reportCards: "source-1" },
      publicationHealth: {
        schemaVersion: 2,
        status: "current",
        acceptedPublicationGenerationId: (identity as { publicationGenerationId?: string }).publicationGenerationId,
        acceptedAtSec: publishedAtSec,
        attemptedAtSec: publishedAtSec,
        heldSinceSec: null,
        reasons: [],
      },
      completeness: overrides.completeness ?? completenessFor(rows),
    },
    safetyUnavailableReason: overrides.safetyUnavailableReason ?? null,
  };
}

function makePreviewDataset(
  rows: readonly PreviewTestRow[],
  overrides: PreviewProjectionOverrides & {
    methodologyLabel?: string;
    displayProjection?: unknown;
  } = {},
) {
  const publishedAtSec = overrides.publishedAtSec ?? PREVIEW_PUBLISHED_AT_SEC;
  return {
    _meta: {
      methodologyLabel: overrides.methodologyLabel ?? "safety-score v10.34 | dews v6.38 | liquidity v6.98",
      asOfISO: new Date(publishedAtSec * 1000).toISOString(),
      displayProjection: overrides.displayProjection ?? makePreviewProjection(rows, overrides),
    },
    rows,
  };
}

function ratedRow(id: string, score: number, grade: string, extra: Partial<PreviewTestRow> = {}): PreviewTestRow {
  return {
    stablecoinId: id,
    safetyScore: score,
    safetyGrade: grade,
    ratingStatus: "rated",
    safetyDisplay: { nrReasons: [], reasonCodes: [], partialEvidence: null },
    ...extra,
  };
}

describe("buildSafetyScoresPreview", () => {
  it("selects the top 20 by score with a code-unit id tie-break and reports full counts", () => {
    const rows: PreviewTestRow[] = [];
    for (let index = 0; index < 22; index += 1) {
      rows.push(ratedRow(`asset-${String(index).padStart(2, "0")}`, 90 - index, scoreToGrade(90 - index)));
    }
    const preview = buildSafetyScoresPreview(
      makePreviewDataset(rows),
      PREVIEW_REGISTRY.concat(
        Array.from({ length: 22 }, (_, index) => ({
          id: `asset-${String(index).padStart(2, "0")}`,
          name: `Asset ${index}`,
          symbol: `A${index}`,
        })),
      ),
      PREVIEW_ASSESSED_AT_SEC,
    )!;

    expect(preview.kind).toBe("safety-grade-preview");
    expect(preview.shownCount).toBe(20);
    expect(preview.eligibleRatedCount).toBe(22);
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[0]).toMatchObject({ id: "asset-00", grade: "A+", score: 90 });
    expect(preview.publicationCompleteness).toEqual({
      expectedCount: 22,
      ratedCount: 22,
      notRatedCount: 0,
      pipelineGapCount: 0,
    });
    expect(preview.publishedAtSec).toBe(PREVIEW_PUBLISHED_AT_SEC);
    expect(preview.expiresAtSec).toBe(Date.parse("2026-10-30T00:00:00Z") / 1000);
  });

  it("breaks equal scores by code-unit id rather than registry order", () => {
    const rows = [
      ratedRow("asset-b", 80, "A-"),
      ratedRow("asset-a", 80, "A-"),
      ratedRow("asset-c", 70, "B"),
    ];
    const preview = buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)!;
    expect(preview.rows.map((row) => row.id)).toEqual(["asset-a", "asset-b", "asset-c"]);
  });

  it("keeps zero-valued rated rows and excludes NR and pipeline gaps from the ranking", () => {
    const rows = [
      ratedRow("asset-a", 0, "F"),
      { stablecoinId: "asset-b", safetyScore: null, safetyGrade: "NR", ratingStatus: "not-rated" as const },
      { stablecoinId: "asset-c", safetyScore: null, safetyGrade: null, ratingStatus: "pipeline-gap" as const },
    ];
    const preview = buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)!;
    expect(preview.rows).toEqual([expect.objectContaining({ id: "asset-a", score: 0, grade: "F" })]);
    expect(preview.eligibleRatedCount).toBe(1);
    expect(preview.publicationCompleteness).toMatchObject({ ratedCount: 1, notRatedCount: 1, pipelineGapCount: 1 });
  });

  it("omits unknown or inactive ids and invalid rating invariants without changing publication counts", () => {
    const rows = [
      ratedRow("asset-a", 85, "A"),
      ratedRow("delisted-coin", 84, "A"),
      ratedRow("asset-b", 83, "B+"),
      ratedRow("asset-c", 82, "A-"),
    ];
    const preview = buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)!;
    expect(preview.rows.map((row) => row.id)).toEqual(["asset-a", "asset-c"]);
    expect(preview.eligibleRatedCount).toBe(2);
    expect(preview.publicationCompleteness.ratedCount).toBe(4);
  });

  it("preserves recorded grade-hold facts and rejects an inconsistent held letter", () => {
    const rows = [
      ratedRow("asset-a", 84, "A-", {
        safetyDisplay: {
          nrReasons: [],
          reasonCodes: [],
          partialEvidence: null,
          gradeHold: { rawGrade: "A", heldFromGenerationId: "v9-publication-prior" },
        },
      }),
      ratedRow("asset-b", 84, "A-", {
        safetyDisplay: {
          nrReasons: [],
          reasonCodes: [],
          partialEvidence: null,
          gradeHold: { rawGrade: "B+", heldFromGenerationId: "v9-publication-prior" },
        },
      }),
    ];
    const preview = buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)!;
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({ id: "asset-a", grade: "A-", gradeHoldRawGrade: "A" });
    expect(preview.eligibleRatedCount).toBe(1);
  });

  it("returns null for a legacy projection, missing metadata or a mismatched methodology label", () => {
    const rows = [ratedRow("asset-a", 85, "A")];
    expect(buildSafetyScoresPreview(makePreviewDataset(rows, { safety: null }), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC))
      .toBeNull();
    expect(buildSafetyScoresPreview({ _meta: {}, rows }, PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)).toBeNull();
    expect(buildSafetyScoresPreview(
      makePreviewDataset(rows, { methodologyLabel: "safety-score v9.0 | dews v6.38" }),
      PREVIEW_REGISTRY,
      PREVIEW_ASSESSED_AT_SEC,
    )).toBeNull();
  });

  it("enforces the calendar retention boundary, non-future clocks and the replay waiver", () => {
    const rows = [ratedRow("asset-a", 85, "A")];
    const boundary = Date.parse("2026-10-29T23:59:00Z") / 1000;
    expect(buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, boundary)).not.toBeNull();
    expect(buildSafetyScoresPreview(
      makePreviewDataset(rows),
      PREVIEW_REGISTRY,
      Date.parse("2026-10-30T00:00:00Z") / 1000,
    )).toBeNull();
    expect(buildSafetyScoresPreview(
      makePreviewDataset(rows, { snapshotDate: "2026-10-29" }),
      PREVIEW_REGISTRY,
      PREVIEW_ASSESSED_AT_SEC,
    )).toBeNull();
    expect(buildSafetyScoresPreview(
      makePreviewDataset(rows, { publishedAtSec: PREVIEW_ASSESSED_AT_SEC + 1 }),
      PREVIEW_REGISTRY,
      PREVIEW_ASSESSED_AT_SEC,
    )).toBeNull();

    vi.stubEnv("PHAROS_PAGES_REPLAY", "1");
    try {
      expect(buildSafetyScoresPreview(
        makePreviewDataset(rows),
        PREVIEW_REGISTRY,
        Date.parse("2026-11-05T00:00:00Z") / 1000,
      )).not.toBeNull();
      expect(buildSafetyScoresPreview(
        makePreviewDataset(rows, { snapshotDate: "2026-11-06" }),
        PREVIEW_REGISTRY,
        Date.parse("2026-11-05T00:00:00Z") / 1000,
      )).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a dataset whose completeness does not reconcile with its rows", () => {
    const rows = [ratedRow("asset-a", 85, "A")];
    const completeness = { ...completenessFor(rows), ratedCount: 2 };
    expect(buildSafetyScoresPreview(
      makePreviewDataset(rows, { completeness }),
      PREVIEW_REGISTRY,
      PREVIEW_ASSESSED_AT_SEC,
    )).toBeNull();
  });

  it("rejects NR and pipeline-gap rows that carry rated values", () => {
    const notRated = [{
      stablecoinId: "asset-b",
      safetyScore: 50,
      safetyGrade: "NR",
      ratingStatus: "not-rated" as const,
    }];
    expect(buildSafetyScoresPreview(makePreviewDataset(notRated), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC))
      .toBeNull();
    const pipelineGap = [{
      stablecoinId: "asset-c",
      safetyScore: null,
      safetyGrade: "NR",
      ratingStatus: "pipeline-gap" as const,
    }];
    expect(buildSafetyScoresPreview(makePreviewDataset(pipelineGap), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC))
      .toBeNull();
  });

  it("returns null when no rated row belongs to the active registry", () => {
    const rows = [ratedRow("delisted-coin", 85, "A")];
    expect(buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)).toBeNull();
  });

  it("indexes the committed scores-latest mirror without requiring a display projection", () => {
    // The committed dataset may predate B0; the wrapper must stay fail-closed
    // rather than throw when the projection is absent.
    const usdt = buildSafetyScoresPreview(
      { rows: [{ stablecoinId: "usdt-tether", safetyScore: 80, safetyGrade: "A-", ratingStatus: "rated" }] },
      ACTIVE_STABLECOINS,
      PREVIEW_ASSESSED_AT_SEC,
    );
    expect(usdt).toBeNull();
  });

  it("admits both readable projection versions and refuses an unknown one", () => {
    const score = 85;
    const rows = [ratedRow("asset-a", score, scoreToGrade(score))];

    expect(buildSafetyScoresPreview(makePreviewDataset(rows), PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC))
      .toMatchObject({ eligibleRatedCount: 1, rows: [{ id: "asset-a" }] });

    // v2 adds the open-question counts; the Safety block this preview reads is
    // unchanged, and the counts stay the generator's contract.
    const v2 = makePreviewDataset(rows, {
      displayProjection: {
        ...makePreviewProjection(rows),
        version: 2,
        openEvidence: {
          semantics: "open-question-v1",
          totals: { questions: 2, open: 1, issuer: 1, documentation: 0, obligations: 3 },
        },
        openEvidenceUnavailableReason: null,
      },
    });
    expect(buildSafetyScoresPreview(v2, PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC))
      .toMatchObject({ eligibleRatedCount: 1, rows: [{ id: "asset-a" }] });

    const unknown = makePreviewDataset(rows, {
      displayProjection: { ...makePreviewProjection(rows), version: 3 },
    });
    expect(buildSafetyScoresPreview(unknown, PREVIEW_REGISTRY, PREVIEW_ASSESSED_AT_SEC)).toBeNull();
  });
});
