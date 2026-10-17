import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSnapshotSafetyAssessment, toSnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";

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
