import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { PR_LANES, buildPrLaneCommandArgs, getPrLane } from "../lib/pr-lanes.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { buildPrWorkflowMatrix } from "../maintenance/generate-pr-workflow-matrix.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github/workflows/pull-request-checks.yml"), "utf8");
const SETUP_WORKSPACE = readFileSync(resolve(REPO_ROOT, ".github/actions/setup-workspace/action.yml"), "utf8");

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
    expect(WORKFLOW).toContain("generate-pr-workflow-matrix.ts --matrix");
    expect(WORKFLOW).toContain("generate-pr-workflow-matrix.ts --run");
    expect(WORKFLOW).not.toContain("npm run check:pr:static");
    expect(WORKFLOW).not.toContain("npm run test:pr");
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
    expect(buildPrLaneCommandArgs(tests, { base: "base", shard: 2 })).toEqual([
      "run", "test:pr", "--", "--base=base", "--shard=2/4",
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

  it("caches every gitignored bootstrap output so matrix jobs see what prepare generated", () => {
    // Collect every `path: |` block's entries (ten-space indented lines) from the action.
    const cachedPaths: string[] = [];
    let inPathBlock = false;
    for (const line of SETUP_WORKSPACE.split("\n")) {
      if (line.trim() === "path: |") { inPathBlock = true; continue; }
      if (inPathBlock && line.startsWith("          ") && line.trim()) cachedPaths.push(line.trim());
      else inPathBlock = false;
    }
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
});
