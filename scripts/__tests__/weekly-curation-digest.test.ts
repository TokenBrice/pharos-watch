import { describe, expect, it } from "vitest";
import { renderDigest } from "./weekly-curation-digest.test-support";

const coin = (id: string, overrides: Record<string, unknown> = {}) => ({ id, ...overrides });
describe("weekly curation coverage", () => {

  it("reports stale and missing active summaries at the 180-day boundary", () => {
    const report = renderDigest({
      coins: ["fresh", "stale", "undated", "invalid", "missing"].map((id) => coin(id)).concat([
        coin("prelaunch", { status: "pre-launch" }),
      ]),
      summaries: {
        fresh: { text: "Current", updatedAt: "2026-01-02" },
        stale: { text: "Old", updatedAt: "2026-01-01" },
        undated: { text: "No date" },
        invalid: { text: "Invalid date", updatedAt: "invalid" },
      },
    });
    const summary = report.split("## AI summary staleness")[1].split("## Annotation queue health")[0];
    expect(summary).toMatch(/active summaries: 3\. Missing: 1\./);
    expect(summary).toContain("Missing entries: missing");
    expect(summary).toMatch(/- stale .*2026-01-01 \(181d\)/);
    expect(summary).toMatch(/- undated .*\(n\/a\)/);
    expect(summary).toMatch(/- invalid .*\(n\/a\)/);
    expect(summary).not.toMatch(/fresh|prelaunch/);
  });


  it("renders empty cohorts with finite percentages and reports absent queue input", () => {
    const report = renderDigest();
    expect(report).toContain("0/0 active/pre-launch");
    expect(report).toContain("0/0 have an archetype (0.0%)");
    expect(report).toContain("attestorTier: 0/0 (0.0%)");
    expect(report).not.toMatch(/NaN|Infinity|WARN:/);
    expect(report).toContain("Queue file `agents/annotation-candidates.md` not present");
  });
});
