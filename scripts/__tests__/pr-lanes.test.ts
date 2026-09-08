import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { execFileSync } from "node:child_process";
import { PR_LANES, buildPrLaneCommandArgs, getPrLane } from "../lib/pr-lanes.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { buildPrWorkflowMatrix } from "../maintenance/generate-pr-workflow-matrix.ts";

const stepSchema = z.object({
  name: z.string().optional(), id: z.string().optional(), uses: z.string().optional(), run: z.string().optional(),
  "continue-on-error": z.boolean().optional(),
  with: z.record(z.string(), z.unknown()).default({}), env: z.record(z.string(), z.string()).default({}),
});
const workflowSchema = z.object({ jobs: z.record(z.string(), z.object({
  steps: z.array(stepSchema),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  strategy: z.object({ matrix: z.string() }).passthrough().optional(),
})) });
const actionSchema = z.object({ runs: z.object({ steps: z.array(stepSchema) }) });
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = workflowSchema.parse(parseYaml(readFileSync(resolve(REPO_ROOT, ".github/workflows/pull-request-checks.yml"), "utf8")));
const SETUP_WORKSPACE = actionSchema.parse(parseYaml(readFileSync(resolve(REPO_ROOT, ".github/actions/setup-workspace/action.yml"), "utf8")));

describe("PR lane manifest", () => {
  it("is the workflow matrix source of truth", () => {
    expect(PR_LANES.map((lane) => lane.id)).toEqual([
      "preflight",
      "static",
      "tests",
      "critical-coverage-shards",
      "critical-coverage",
      "docs",
      "gate",
    ]);
    const preflight = WORKFLOW.jobs.preflight;
    const validation = WORKFLOW.jobs.validation;
    const generator = preflight.steps.find((step) => step.id === "matrix");
    expect(generator?.run).toMatch(/^echo "matrix=\$\(node [^\n]*generate-pr-workflow-matrix\.ts --matrix\)" >> "\$GITHUB_OUTPUT"$/);
    expect(preflight.outputs?.matrix).toBe("${{ steps.matrix.outputs.matrix }}");
    expect(validation.needs).toEqual(expect.arrayContaining(["preflight", "prepare"]));
    expect(validation.strategy?.matrix).toBe("${{ fromJSON(needs.preflight.outputs.matrix) }}");
    const runner = validation.steps.find((step) => step.env.PR_LANE_ID === "${{ matrix.lane }}");
    expect(runner?.run).toMatch(/^node [^\n]*generate-pr-workflow-matrix\.ts --run$/);
    expect(runner?.env.PR_LANE_SHARD).toBe("${{ matrix.shard }}");
    expect(runner?.env.PR_LANE_SHARD_COUNT).toBe("${{ matrix.shardCount }}");
  });

  it("generates four test shards and the selected number of coverage shards", () => {
    const matrix = buildPrWorkflowMatrix({
      criticalCoverageChanged: true,
      criticalCoverageShards: 2,
      docsChanged: true,
      docsOnly: false,
    }).include;
    expect(matrix.filter((entry) => entry.lane === "tests")).toHaveLength(4);
    expect(matrix.filter((entry) => entry.lane === "critical-coverage-shards")).toEqual([
      { lane: "critical-coverage-shards", shard: 1, shardCount: 2, timeout: 15 },
      { lane: "critical-coverage-shards", shard: 2, shardCount: 2, timeout: 15 },
    ]);
    expect(matrix.map((entry) => entry.lane)).toContain("static");
    expect(matrix.map((entry) => entry.lane)).toContain("docs");
    expect(matrix.every((entry) => entry.timeout <= 20)).toBe(true);
  });

  it("keeps docs-only PRs out of code lanes", () => {
    expect(buildPrWorkflowMatrix({
      criticalCoverageChanged: false,
      criticalCoverageShards: 0,
      docsChanged: true,
      docsOnly: true,
    })).toEqual({ include: [{ lane: "docs", timeout: 15 }] });
  });

  it("gives the docs lane sole doc-sync ownership in the mixed matrix", () => {
    const mixed = buildPrWorkflowMatrix({
      criticalCoverageChanged: false,
      criticalCoverageShards: 0,
      docsChanged: true,
      docsOnly: false,
    }).include;
    expect(mixed.find((entry) => entry.lane === "static")).toMatchObject({ skipDocSync: true });
    expect(mixed.find((entry) => entry.lane === "docs")).toBeDefined();
  });

  it("keeps the static lane owning doc-sync when the docs lane is not selected", () => {
    const sourceOnly = buildPrWorkflowMatrix({
      criticalCoverageChanged: false,
      criticalCoverageShards: 0,
      docsChanged: false,
      docsOnly: false,
    }).include;
    const staticEntry = sourceOnly.find((entry) => entry.lane === "static");
    expect(staticEntry).toBeDefined();
    expect(staticEntry?.skipDocSync).toBeUndefined();
    expect(sourceOnly.some((entry) => entry.lane === "docs")).toBe(false);
  });

  it("forwards skipDocSync to the static lane command only when set", () => {
    const staticCommand = getPrLane("static").commands[0];
    expect(buildPrLaneCommandArgs(staticCommand, { base: "base", head: "HEAD", skipDocSync: true })).toEqual([
      "run", "check:pr:static", "--", "--base=base", "--head=HEAD", "--skip-doc-sync",
    ]);
    expect(buildPrLaneCommandArgs(staticCommand, { base: "base", head: "HEAD" })).toEqual([
      "run", "check:pr:static", "--", "--base=base", "--head=HEAD",
    ]);
  });

  it("uses the same strict commands for local and sharded execution", () => {
    const gitleaks = getPrLane("preflight").commands.find((command) => command.id === "gitleaks");
    const tests = getPrLane("tests").commands[0];
    expect(gitleaks?.args).toContain("--range");
    expect(gitleaks?.args).not.toContain("--lenient-platform");
    expect(buildPrLaneCommandArgs(tests, { base: "base", shard: 2, shardCount: 3 })).toEqual([
      "run", "test:pr", "--", "--base=base", "--shard=2/3",
    ]);
    expect(buildPrLaneCommandArgs(tests, { base: "base" })).toEqual([
      "run", "test:pr", "--", "--base=base",
    ]);
    expect(buildPrLaneCommandArgs(getPrLane("critical-coverage-shards").commands[0], {
      shard: 2,
      shardCount: 3,
    })).toEqual(["run", "coverage:critical:shard", "--", "--shard=2/3"]);
    // npm swallows bare `--base=` flags; the separator is what delivers them.
    expect(buildPrLaneCommandArgs(getPrLane("static").commands[0], { base: "base", head: "HEAD" })).toEqual([
      "run", "check:pr:static", "--", "--base=base", "--head=HEAD",
    ]);
  });

  it("rejects incomplete and out-of-range shard coordinates", () => {
    for (const lane of ["tests", "critical-coverage-shards"] as const) {
      for (const context of [{ shard: 1 }, { shardCount: 2 }, { shard: 0, shardCount: 2 }, { shard: 3, shardCount: 2 }, { shard: 1.5, shardCount: 2 }]) {
        expect(() => buildPrLaneCommandArgs(getPrLane(lane).commands[0], context)).toThrow(/shard/i);
      }
    }
  });

  it("fails closed instead of dropping a selected coverage lane with no shards", () => {
    expect(() => buildPrWorkflowMatrix({
      criticalCoverageChanged: true, criticalCoverageShards: 0, docsChanged: false, docsOnly: false,
    })).toThrow(/shard/);
  });

  it("transports every ignored bootstrap output through the required archive, not optional caches", () => {
    const steps = SETUP_WORKSPACE.runs.steps;
    const packaging = steps.find((step) => step.name === "Package required workspace");
    const cachedPaths = packaging!.env.WORKSPACE_PATHS.trim().split("\n");
    const bootstrapOutputs = GENERATED_ARTIFACT_REGISTRY
      .filter((artifact) => artifact.bootstrap)
      .flatMap((artifact) => artifact.outputPaths)
      .map((pattern) => pattern.replace(/\/\*\*$/, ""));
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...bootstrapOutputs], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).split("\n").filter(Boolean);
    const uncached = ignored.filter((output) =>
      !cachedPaths.some((cached) => output === cached || output.startsWith(`${cached}/`)),
    );
    expect(uncached).toEqual([]);
  });

  it("requires run-scoped publication and restoration independently of optional caches", () => {
    const steps = SETUP_WORKSPACE.runs.steps;
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(upload!.with["if-no-files-found"]).toBe("error");
    expect(download!.with.name).toBe(upload!.with.name);
    expect(upload!.with.name).toContain("github.run_id");
    expect(upload!.with.name).toContain("github.run_attempt");
    expect(upload!.with.name).toContain("github.sha");
    for (const step of [upload, download]) expect(step!["continue-on-error"]).toBeUndefined();
    for (const job of ["validation", "critical-coverage"]) {
      const setup = WORKFLOW.jobs[job].steps.find((step) => step.uses === "./.github/actions/setup-workspace");
      expect(setup!.with["workspace-artifact"]).toBe("restore");
      expect(setup!.with["install-deps"]).toBe("false");
    }
    expect(steps.find((step) => step.id === "static-cache")!.uses).toMatch(/^actions\/cache\/restore@/);
  });

  it("roundtrips executable dependencies without caches and fails on missing transport", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-workspace-transport-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      mkdirSync(source);
      mkdirSync(destination);
      const packaging = SETUP_WORKSPACE.runs.steps.find((step) => step.name === "Package required workspace")!;
      const restoring = SETUP_WORKSPACE.runs.steps.find((step) => step.run?.startsWith("tar -xzf"))!;
      const paths = packaging.env.WORKSPACE_PATHS.trim().split("\n");
      for (const file of paths) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        if (file === "node_modules") mkdirSync(join(source, file));
        else writeFileSync(join(source, file), file);
      }
      writeFileSync(join(source, "node_modules/tool"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(source, "node_modules/tool"), 0o755);
      symlinkSync("tool", join(source, "node_modules/link"));
      const env = { ...process.env, RUNNER_TEMP: root, ...packaging.env };
      execFileSync("bash", ["-e", "-c", packaging.run!], { cwd: source, env, stdio: "pipe" });
      execFileSync("bash", ["-e", "-c", restoring.run!], { cwd: destination, env, stdio: "pipe" });
      expect(readFileSync(join(destination, paths[1]), "utf8")).toBe(paths[1]);
      expect(statSync(join(destination, "node_modules/tool")).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(destination, "node_modules/link"))).toBe("tool");
      rmSync(join(root, "pharos-workspace/workspace.tar.gz"));
      expect(() => execFileSync("bash", ["-e", "-c", restoring.run!], { cwd: destination, env, stdio: "pipe" })).toThrow();
      rmSync(join(source, paths[1]));
      expect(() => execFileSync("bash", ["-e", "-c", packaging.run!], { cwd: source, env, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
