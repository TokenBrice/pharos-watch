import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it.each(["replay", "worklist", "queue", "registry", "live_withheld"])(
    "preserves %s failure through the successful tee", (id) => {
      const dir = mkdtempSync(join(tmpdir(), "curation-generator-"));
      try {
        mkdirSync(join(dir, "agents/sweep"), { recursive: true });
        const npmPath = join(dir, "npm");
        writeFileSync(npmPath, "#!/bin/bash\necho generator-failed\nexit 17\n");
        chmodSync(npmPath, 0o755);
        const output = join(dir, "outputs");
        const result = spawnSync("bash", ["-c", stepRun(id)], {
          cwd: dir, encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, CLOCK_SEC: "1" },
        });
        expect(result.status).toBe(17);
        expect(readFileSync(output, "utf8")).toBe("status=17\n");
        expect(result.stdout).toContain("generator-failed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

  it("retains every report and command log even when a generator fails", () => {
    const upload = steps.find((step) => step.id === "snapshots")!;
    expect(upload.with).toMatchObject({
      name: "safety-score-v9-curation-sweep-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "agents/sweep/",
      "if-no-files-found": "error",
      "retention-days": 30,
    });
    expect(upload.if).toBe("always()");
    const issue = steps.find((step) => step.run?.includes("gh issue edit"))!;
    expect(steps.indexOf(upload)).toBeLessThan(steps.indexOf(issue));
    expect(issue.if).toBe("always() && steps.generate.outcome == 'success'");
    expect(issue.env?.SNAPSHOT_URL).toBe("${{ steps.snapshots.outputs.artifact-url }}");
    expect(issue.env?.SNAPSHOT_STATUS).toBe("${{ steps.snapshots.outcome }}");
  });

  function publishIssue(report: string, failedStatus?: string): { status: number | null; body: string } {
    const dir = mkdtempSync(join(tmpdir(), "curation-issue-"));
    try {
      mkdirSync(join(dir, "agents/sweep"), { recursive: true });
      for (const file of ["live-withheld.md", "expiry-queue.md", "worklist.md"]) {
        writeFileSync(join(dir, "agents/sweep", file), report);
      }
      writeFileSync(join(dir, "agents/sweep/missing-data-registry.json"), JSON.stringify({ summary: {
        openItemCount: 42, claimGroupCount: 8, compiledFactItemCount: 35,
        supplementalScoreItemCount: 7, affectedStablecoinCount: 6,
      } }));
      for (const name of ["replay", "worklist", "queue", "live-withheld", "missing-data-registry"]) {
        writeFileSync(join(dir, `agents/sweep/${name}-command.log`), `${name} diagnostic`);
      }
      const ghPath = join(dir, "gh");
      writeFileSync(ghPath, '#!/bin/bash\nif [ "$2" = list ]; then echo 945; else cp "$5" "$PUBLISHED_BODY"; fi\n');
      chmodSync(ghPath, 0o755);
      const result = spawnSync("bash", ["-c", steps.find((step) => step.run?.includes("gh issue edit"))!.run!], {
        cwd: dir, encoding: "utf8", env: {
          ...process.env, PATH: `${dir}:${process.env.PATH}`, PUBLISHED_BODY: join(dir, "published.md"),
          GITHUB_SHA: "test-sha", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "example/pharos",
          SNAPSHOT_URL: "https://github.com/example/pharos/actions/runs/1/artifacts/2", SNAPSHOT_STATUS: "success",
          REPLAY_STATUS: "0", WORKLIST_STATUS: "0", QUEUE_STATUS: "0", LIVE_WITHHELD_STATUS: "0", REGISTRY_STATUS: "0",
          ...(failedStatus ? { [failedStatus]: "7" } : {}),
        },
      });
      expect(result.stderr).toBe("");
      return { status: result.status, body: readFileSync(join(dir, "published.md"), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("caps a huge single-line multibyte report at 60,000 UTF-8 bytes including its footer", () => {
    const { status, body } = publishIssue(`## Dependencies\n${"🪙".repeat(40_000)}`);
    expect(status).toBe(0);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
    expect(body).not.toContain("\uFFFD");
    expect(body).toContain("output truncated to fit the 60,000-byte issue body budget");
    expect(body).toContain("Open task rows: **42**");
    expect(body).toContain("Command status: replay=0, worklist=0, expiry queue=0, live-withheld=0, missing-data registry=0.");
    expect(body.indexOf("Open task rows")).toBeLessThan(body.indexOf("Command status:"));
    expect(body.indexOf("Command status:")).toBeLessThan(body.indexOf("Full downloadable reports"));
    expect(body.indexOf("Full downloadable reports")).toBeLessThan(body.indexOf("## Live-withheld"));
    expect(body.endsWith("Run: https://github.com/example/pharos/actions/runs/1\n")).toBe(true);
  });

  it.each(["REPLAY_STATUS", "WORKLIST_STATUS", "QUEUE_STATUS", "LIVE_WITHHELD_STATUS", "REGISTRY_STATUS"])(
    "publishes diagnostics and fails the run when %s failed", (statusName) => {
      const { status, body } = publishIssue("small report", statusName);
      expect(status).toBe(1);
      expect(body).toContain("## Generation failures");
      expect(body).toContain("(status 7)");
      expect(body).toContain("diagnostic");
    },
  );

  it("writes a labelled partial queue and exits nonzero when a required replay join is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "expiry-queue-cli-"));
    try {
      const replayPath = join(dir, "replay.json");
      const outputPath = join(dir, "expiry-queue.md");
      writeFileSync(replayPath, JSON.stringify({
        pipeline: { fixedInput: { clockSec: 1_793_059_200, liveReserveMap: {}, liveToFallbackCoins: [] }, evaluatedSet: { assets: [] } },
      }));
      const result = spawnSync(process.execPath,
        ["--import", "tsx", "worker/scripts/list-curation-expiry-queue.ts", "--replay", replayPath, "--output", outputPath],
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
