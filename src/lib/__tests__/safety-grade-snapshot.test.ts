import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import {
  formatSnapshotSafetyScoreLabel,
  getScoresLatestSnapshotRow,
  getSnapshotSafetyAssessment,
  toScoresLatestSnapshotRow,
  toSnapshotSafetyAssessment,
} from "@/lib/safety-grade-snapshot";

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
