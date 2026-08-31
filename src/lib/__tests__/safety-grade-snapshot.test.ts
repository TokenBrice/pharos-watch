import { describe, expect, it } from "vitest";
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
