import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; name?: string; uses?: string; with?: Record<string, string | number>; run?: string; env?: Record<string, string>; if?: string; "continue-on-error"?: boolean; "timeout-minutes"?: number };
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

  it("retains the full expiry queue for 30 days, including an explicitly partial report", () => {
    const upload = steps.find((step) => step.id === "queue_artifact")!;
    const registryUpload = steps.find((step) => step.with?.path === "agents/sweep/missing-data-registry.json")!;
    expect(upload.uses).toBe(registryUpload.uses);
    expect(upload.with).toMatchObject({
      name: "safety-score-v9-expiry-queue-${{ github.run_id }}",
      path: "agents/sweep/expiry-queue.md",
      "if-no-files-found": "error",
      "retention-days": 30,
    });
    // A partial report exits nonzero after writing; upload must not depend on queue_status.
    expect(upload.if).toContain("!cancelled()");
    expect(upload.if).toContain("steps.capture.outcome == 'success'");
    expect(upload.if).toContain("hashFiles('agents/sweep/expiry-queue.md') != ''");
    expect(upload.if).not.toContain("queue_status");
    // The registry artifact stays independent and status-gated.
    expect(registryUpload.if).toBe("steps.generate.outputs.registry_status == '0'");
    const issue = steps.find((step) => step.run?.includes("gh issue edit"))!;
    expect(steps.indexOf(upload)).toBeLessThan(steps.indexOf(issue));
    expect(issue.run).toContain("## Evidence pre-expiry queue");
    expect(issue.run).toContain("safety-score-v9-expiry-queue-${GITHUB_RUN_ID}");
    expect(issue.run).toContain("actions/runs/${GITHUB_RUN_ID}");
  });

  it("writes a labelled partial queue and exits nonzero when a required replay join is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "expiry-queue-cli-"));
    try {
      const replayPath = join(dir, "replay.json");
      const outputPath = join(dir, "expiry-queue.md");
      writeFileSync(replayPath, JSON.stringify({
        pipeline: { fixedInput: { clockSec: 1_793_059_200, liveReserveMap: {}, liveToFallbackCoins: [] }, evaluatedSet: { assets: [] } },
      }));
      const result = spawnSync(resolve(root, "node_modules/.bin/tsx"),
        ["worker/scripts/list-curation-expiry-queue.ts", "--replay", replayPath, "--output", outputPath],
        { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("replay-field-missing:pipeline.compiledFacts.assets");
      expect(existsSync(outputPath)).toBe(true);
      const markdown = readFileSync(outputPath, "utf8");
      expect(markdown).toContain("Report status: **partial**");
      expect(markdown).toContain("## Census diagnostics");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
