import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { execFileSync } from "node:child_process";
import { PR_DOC_COMMANDS, PR_LANES, buildPrLaneCommandArgs, getPrLane } from "../lib/pr-lanes.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { buildWorkerStablecoinCatalog } from "../build-data/generate-worker-stablecoin-catalog";
import { buildPrWorkflowMatrix, formatPrWorkflowOutputs } from "../maintenance/generate-pr-workflow-matrix.ts";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";

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
      "v9-resource",
      "static-guards",
      "tests",
      "static-compile",
      "pages-artifact",
      "gate",
    ]);
    const prepare = WORKFLOW.jobs.prepare;
    const validation = WORKFLOW.jobs.validation;
    const generator = prepare.steps.find((step) => step.id === "matrix");
    expect(generator?.run).toMatch(/^node [^\n]*generate-pr-workflow-matrix\.ts --matrix$/);
    expect(generator?.env.V9_RESOURCE_REQUIRED).toBe("${{ steps.classify.outputs.v9_resource_required }}");
    expect(prepare.outputs?.matrix).toBe("${{ steps.matrix.outputs.matrix }}");
    expect(Object.keys(WORKFLOW.jobs)).toEqual(["secrets", "prepare", "validation", "pages-artifact", "pr-gate"]);
    expect(WORKFLOW.jobs["pr-gate"].needs).toEqual(["secrets", "prepare", "validation", "pages-artifact"]);
    expect(Object.keys(prepare.outputs ?? {})).toEqual([
      "docs_only", "docs_inline_succeeded", "matrix",
      "playwright_firefox_required", "pages_artifact_required", "workspace_artifact_name",
    ]);
    expect(validation.needs).toBe("prepare");
    expect(validation.strategy?.matrix).toBe("${{ fromJSON(needs.prepare.outputs.matrix) }}");
    const runner = validation.steps.find((step) => step.env.PR_LANE_ID === "${{ matrix.lane }}");
    expect(runner?.run).toMatch(/^node [^\n]*generate-pr-workflow-matrix\.ts --run$/);
    expect(runner?.env.PR_LANE_SHARD).toBe("${{ matrix.shard }}");
    expect(runner?.env.PR_LANE_SHARD_COUNT).toBe("${{ matrix.shardCount }}");
  });

  it("keeps docs-only checks inline without scheduling validation jobs", () => {
    expect(buildPrWorkflowMatrix({ docsOnly: true }).include).toEqual([]);
    const docs = WORKFLOW.jobs.prepare.steps.find((step) => step.id === "docs");
    expect(docs?.env.PR_LANE_ID).toBe("docs-inline");
    expect(PR_DOC_COMMANDS.map((command) => command.id)).toEqual([
      "verified-doc-links", "doc-sync",
      "doc-ownership-invariants",
    ]);
    const invariants = PR_DOC_COMMANDS.find((command) => command.id === "doc-ownership-invariants");
    expect(invariants?.args).toEqual([
      "exec", "--", "vitest", "run",
      "scripts/__tests__/doc-ownership-registry.test.ts",
      "scripts/__tests__/pharos-change-contract.test.ts",
    ]);
  });

  it.each([4, 8])("generates %i planned test shards in the validation matrix", (testShards) => {
    const selection = {
      docsOnly: false, testShards,
    };
    const matrix = buildPrWorkflowMatrix(selection).include;
    expect(matrix.filter((entry) => entry.lane === "tests")).toEqual(
      Array.from({ length: testShards }, (_, index) => ({
        lane: "tests", shard: index + 1, shardCount: testShards, timeout: 15,
      })),
    );
    expect(matrix.filter((entry) => entry.lane === "v9-resource")).toEqual([
      { lane: "v9-resource", timeout: 8 },
    ]);
    // max-parallel: 10 starts matrix jobs in order. The resource lane must be
    // inside the first ten; the shortest lane absorbs the queued slot.
    expect(matrix.slice(0, 2).map((entry) => entry.lane)).toEqual(["v9-resource", "static-guards"]);
    expect(matrix.at(-1)).toEqual({ lane: "static-compile", timeout: 20 });
    expect(matrix.map((entry) => entry.lane)).not.toContain("docs");
    expect(matrix).toHaveLength(testShards + 3);
    expect(buildPrWorkflowMatrix({ ...classifyChangedFiles(["README.md", "src/app/page.tsx"]), testShards }).include
      .map((entry) => entry.lane)).not.toContain("docs");
    const outputs = Object.fromEntries(formatPrWorkflowOutputs(selection).trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
    }));
    expect(outputs).toEqual({ matrix: { include: matrix } });
  });

  it.each([
    { name: "V9-impact", files: ["shared/lib/safety-score-v9/engine.ts"], selected: true },
    { name: "unrelated", files: ["src/components/header.tsx"], selected: false },
  ])("selects the resource lane for $name changes through the classifier", ({ files, selected }) => {
    const classification = classifyChangedFiles(files);
    const matrix = buildPrWorkflowMatrix({ ...classification, testShards: 4 }).include;
    expect(matrix.some((entry) => entry.lane === "v9-resource")).toBe(selected);
  });

  it("selects the resource lane when classification is unavailable", () => {
    const matrix = buildPrWorkflowMatrix({ docsOnly: false, testShards: 4 }).include;
    expect(matrix.filter((entry) => entry.lane === "v9-resource")).toEqual([
      { lane: "v9-resource", timeout: 8 },
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
    // npm swallows bare `--base=` flags; the separator is what delivers them.
    expect(buildPrLaneCommandArgs(getPrLane("static-compile").commands[0], { base: "base", head: "HEAD" })).toEqual([
      "run", "check:pr:static", "--", "--group=compile", "--base=base", "--head=HEAD",
    ]);
  });

  it("rejects invalid test fan-out instead of dropping selected tests", () => {
    const selection = { docsOnly: false };
    for (const shards of [0, -1, 1.5, 9]) {
      expect(() => buildPrWorkflowMatrix({ ...selection, testShards: shards })).toThrow(/shard/);
    }
  });

  it("enforces every selected job and only accepts legitimate skips at the required gate", () => {
    const gate = WORKFLOW.jobs["pr-gate"].steps[0].run!;
    const code = {
      SECRETS_RESULT: "success", PREPARE_RESULT: "success", VALIDATION_RESULT: "success",
      DOCS_ONLY: "false", DOCS_INLINE_SUCCEEDED: "false",
      PAGES_ARTIFACT_REQUIRED: "false", PAGES_ARTIFACT_RESULT: "skipped",
    };
    const docs = { ...code, DOCS_ONLY: "true", DOCS_INLINE_SUCCEEDED: "true", VALIDATION_RESULT: "skipped" };
    const pages = { ...code, PAGES_ARTIFACT_REQUIRED: "true", PAGES_ARTIFACT_RESULT: "success" };
    const run = (env: Record<string, string>) => execFileSync("bash", ["-e", "-c", gate], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: "pipe",
    });
    for (const env of [code, docs, pages]) expect(() => run(env)).not.toThrow();
    for (const key of ["SECRETS_RESULT", "PREPARE_RESULT", "VALIDATION_RESULT"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        expect(() => run({ ...code, [key]: result }), `${key}=${result}`).toThrow();
      }
    }
    expect(() => run({ ...docs, DOCS_INLINE_SUCCEEDED: "false" })).toThrow();
    expect(() => run({ ...docs, VALIDATION_RESULT: "cancelled" })).toThrow();
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(() => run({ ...pages, PAGES_ARTIFACT_RESULT: result })).toThrow();
    }
    for (const required of ["", "unknown", "true"]) {
      expect(() => run({ ...code, PAGES_ARTIFACT_REQUIRED: required })).toThrow();
    }
    expect(() => run({ ...code, PAGES_ARTIFACT_RESULT: "success" })).toThrow();
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

  it("roundtrips executable dependencies without caches and fails on missing transport", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-workspace-transport-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      mkdirSync(source);
      mkdirSync(destination);
      const packaging = SETUP_WORKSPACE.runs.steps.find((step) => step.name === "Package required workspace")!;
      const restoring = SETUP_WORKSPACE.runs.steps.find((step) => step.run?.startsWith("tar --zstd -xf"))!;
      const paths = packaging.env.WORKSPACE_PATHS.trim().split("\n");
      const packedPath = GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "stablecoin-worker-full-catalog")!.outputPaths[0];
      expect(paths).toContain(packedPath);
      const packedBytes = JSON.stringify(buildWorkerStablecoinCatalog([{ id: "ci-transport-fixture", evidence: { controls: ["preserved"] } }]));
      for (const file of paths) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        if (file === "node_modules") mkdirSync(join(source, file));
        else writeFileSync(join(source, file), file);
      }
      writeFileSync(join(source, packedPath), packedBytes);
      writeFileSync(join(source, "node_modules/tool"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(source, "node_modules/tool"), 0o755);
      symlinkSync("tool", join(source, "node_modules/link"));
      const plan = '{"version":1,"base":"base","fileCount":0,"shardCount":4,"shards":[[],[],[],[]]}';
      mkdirSync(join(source, ".tmp"));
      writeFileSync(join(source, ".tmp/pr-test-plan.json"), plan);
      const env = { ...process.env, RUNNER_TEMP: root, ...packaging.env };
      execFileSync("bash", ["-e", "-c", packaging.run!], { cwd: source, env, stdio: "pipe" });
      execFileSync("bash", ["-e", "-c", restoring.run!], { cwd: destination, env, stdio: "pipe" });
      expect(readFileSync(join(destination, packedPath), "utf8")).toBe(packedBytes);
      expect(readFileSync(join(destination, paths[1]), "utf8")).toBe(paths[1]);
      expect(statSync(join(destination, "node_modules/tool")).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(destination, "node_modules/link"))).toBe("tool");
      expect(readFileSync(join(destination, ".tmp/pr-test-plan.json"), "utf8")).toBe(plan);
      rmSync(join(source, packedPath));
      expect(() => execFileSync("bash", ["-e", "-c", packaging.run!], { cwd: source, env, stdio: "pipe" })).toThrow();
      writeFileSync(join(source, packedPath), packedBytes);
      rmSync(join(root, "pharos-workspace/workspace.tar.zst"));
      expect(() => execFileSync("bash", ["-e", "-c", restoring.run!], { cwd: destination, env, stdio: "pipe" })).toThrow();
      rmSync(join(source, paths[1]));
      expect(() => execFileSync("bash", ["-e", "-c", packaging.run!], { cwd: source, env, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
