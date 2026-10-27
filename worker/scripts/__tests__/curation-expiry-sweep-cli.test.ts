import { readFileSync } from "node:fs";

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; run?: string; env?: Record<string, string>; if?: string; "continue-on-error"?: boolean; "timeout-minutes"?: number };
const root = resolve(import.meta.dirname, "../../..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/curation-expiry-sweep.yml"), "utf8"));
const steps: Step[] = workflow.jobs.sweep.steps;

function stepRun(id: string): string {
  const run = steps.find((step) => step.id === id)?.run;
  if (!run) throw new Error(`Missing curation workflow run step: ${id}`);
  return run;
}

describe("curation sweep executable workflow contract", () => {
  it("isolates all five generators and retains failure status after a timed-out report", () => {
    const generators = [
      ["replay", "safety-score-v9:replay", "replay_status"],
      ["worklist", "safety-score-v9:curation-worklist", "worklist_status"],
      ["queue", "safety-score-v9:expiry-queue", "queue_status"],
      ["registry", "safety-score-v9:missing-data-registry", "registry_status"],
      ["live_withheld", "safety-score-v9:live-withheld", "live_withheld_status"],
    ];
    const collect = steps.find((step) => step.id === "generate")!;
    expect(workflow.jobs.sweep["timeout-minutes"]).toBe(25);
    expect(steps.find((step) => step.id === "live_withheld")!["timeout-minutes"]).toBe(15);
    expect(stepRun("live_withheld")).toContain("--workers 3");
    expect(steps.findIndex((step) => step.id === "registry"))
      .toBeLessThan(steps.findIndex((step) => step.id === "live_withheld"));
    for (const [id, command, status] of generators) {
      const step = steps.find((candidate) => candidate.id === id)!;
      expect(step.run).toContain(`npm run ${command} --`);
      expect(step.run).toContain('status=${PIPESTATUS[0]}');
      expect(step.run).toContain('echo "status=$status" >> "$GITHUB_OUTPUT"');
      expect(step.run).toContain('exit "$status"');
      expect(step["continue-on-error"]).toBe(true);
      expect(collect.env?.[status!]).toBe(`\${{ steps.${id}.outputs.status || '1' }}`);
      expect(collect.run).toContain(`echo "${status}=$${status}" >> "$GITHUB_OUTPUT"`);
    }
    expect(collect.if).toContain("!cancelled()");
    const issue = steps.find((step) => step.run?.includes('gh issue edit'))!;
    expect(issue.run).toContain('[ "$LIVE_WITHHELD_STATUS" != 0 ]');
    expect(issue.run).toContain("Curation sweep incomplete");
    expect(issue.run).toContain("exit 1");
  });

  it("opts the scheduled capture into the current-input guard before emitting the replay clock", () => {
    const run = stepRun("capture");
    expect(run).toContain("--exact-cache-export agents/sweep/capture.raw.json");
    expect(run).toContain("--normalized-only --require-current");
    expect(run.indexOf("--require-current")).toBeLessThan(run.indexOf("clock_sec="));
    expect(run).toContain("set -euo pipefail");
    // Acquisition failure stops the job before any report publication, and the
    // replay keeps the capture's original clock as the published-at pin.
    expect(steps.find((step) => step.id === "capture")!["continue-on-error"]).toBeUndefined();
    expect(steps.find((step) => step.id === "replay")!.env?.CLOCK_SEC).toBe("${{ steps.capture.outputs.clock_sec }}");
    expect(stepRun("replay")).toContain('--published-at "$CLOCK_SEC"');
    expect(stepRun("capture")).toContain("SELECT value FROM cache");
  });
});
