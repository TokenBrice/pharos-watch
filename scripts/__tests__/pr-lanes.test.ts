import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PR_LANES, buildPrLaneCommandArgs, getPrLane } from "../lib/pr-lanes.mts";
import { buildPrWorkflowMatrix } from "../maintenance/generate-pr-workflow-matrix.ts";

const WORKFLOW = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/pull-request-checks.yml"), "utf8");

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

  it("generates four test and coverage shards for a critical mixed PR", () => {
    const matrix = buildPrWorkflowMatrix({
      criticalCoverageChanged: true,
      docsChanged: true,
      docsOnly: false,
    }).include;
    expect(matrix.filter((entry) => entry.lane === "tests")).toHaveLength(4);
    expect(matrix.filter((entry) => entry.lane === "critical-coverage-shards")).toHaveLength(4);
    expect(matrix.map((entry) => entry.lane)).toContain("static");
    expect(matrix.map((entry) => entry.lane)).toContain("docs");
    expect(matrix.every((entry) => entry.timeout <= 20)).toBe(true);
  });

  it("keeps docs-only PRs out of code lanes", () => {
    expect(buildPrWorkflowMatrix({
      criticalCoverageChanged: false,
      docsChanged: true,
      docsOnly: true,
    })).toEqual({ include: [{ lane: "docs", timeout: 15 }] });
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
  });
});
