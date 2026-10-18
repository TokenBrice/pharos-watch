import { describe, expect, it } from "vitest";
import { qualificationProbeSource, qualifyWorkerMemory } from "../qualify-worker-memory.mjs";

describe("Worker memory qualification harness", () => {
  it("rejects unknown flags, duplicate options and missing output before filesystem effects", async () => {
    await expect(qualifyWorkerMemory(["--unknown"])).rejects.toThrow();
    await expect(qualifyWorkerMemory(["--runs", "2", "--runs", "3"])).rejects.toThrow();
    await expect(qualifyWorkerMemory([])).rejects.toThrow("--out-dir is required");
  });

  it("rejects invalid repeat counts before creating an output directory", async () => {
    await expect(qualifyWorkerMemory(["--out-dir", "unused", "--runs", "0"])).rejects.toThrow();
    await expect(qualifyWorkerMemory(["--out-dir", "unused", "--runs", "1.5"])).rejects.toThrow();
  });

  it("measures the cold entry before the charts loader and accepted readers", () => {
    const source = qualificationProbeSource();
    expect(source.indexOf("phase('cold-heavy-entry')")).toBeLessThan(source.indexOf("halfHourlyChartsOffset()"));
    expect(source.indexOf("phase('cold-charts-loader')")).toBeLessThan(source.indexOf("loadSafetyScoreV9AcceptedBaselineState(db)"));
    expect(source).toContain("getHeapSpaceStatistics()");
    expect(source).toContain("getHeapCodeStatistics()");
    expect(source).toContain("process.memoryUsage()");
    expect(source).toContain("readOnly: true");
    expect(source).toContain("baseline.kind !== 'accepted'");
    expect(source).toContain("lender.kind !== 'accepted'");
    expect(source).toContain("accepted-readers-co-resident");
    expect(source).not.toContain("public-runners");
  });
});
