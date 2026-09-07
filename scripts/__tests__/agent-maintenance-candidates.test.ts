import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("maintenance snapshot workflow", () => {
  it("retains full immutable outputs before publishing bounded issue excerpts, including failed generation", () => {
    const workflow = parse(readFileSync(resolve(process.cwd(), ".github/workflows/agent-maintenance-candidates.yml"), "utf8")) as {
      jobs: { candidates: { steps: Array<{ id?: string; name?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }> } };
    };
    const steps = workflow.jobs.candidates.steps;
    const uploadIndex = steps.findIndex((step) => step.id === "snapshots");
    const upload = steps[uploadIndex];
    const issueIndex = steps.findIndex((step) => step.name === "Open or update review issue");
    const issue = steps[issueIndex];
    expect(uploadIndex).toBeGreaterThan(steps.findIndex((step) => step.id === "generate"));
    expect(issueIndex).toBeGreaterThan(uploadIndex);
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload.if).toBe("always()");
    expect(upload.with?.name).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload.with?.["retention-days"]).toBeGreaterThanOrEqual(62);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    const paths = String(upload.with?.path).trim().split("\n");
    expect(paths).toEqual(expect.arrayContaining([
      "agents/annotation-candidates.md", "agents/annotation-candidates.json",
      "agents/ai-summary-candidates.md", "agents/ai-summary-candidates.json",
      "agents/curation-digest-*.md", "agents/*-command.log",
    ]));
    expect(paths).not.toContain("agents/annotation-review.json");
    expect(issue.env?.SNAPSHOT_URL).toBe("${{ steps.snapshots.outputs.artifact-url }}");
    expect(issue.run).toContain("${SNAPSHOT_URL:-artifact upload unavailable}");
    expect(issue.run).toContain("sed -n '1,140p'");
  });
});
