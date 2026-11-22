import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGeneratedArtifactExecutionUnits,
  GENERATED_ARTIFACTS_MAX_PARALLEL,
  runGeneratedArtifacts,
} from "../maintenance/run-generated-artifacts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import pkg from "../../package.json";
import { withTempRepo } from "./helpers/test-state";
import * as v9 from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";
import * as shock from "../maintenance/generate-safety-score-v9-shock-coverage-registry";
import * as automationRegistry from "../lib/automation-registry.mjs";

describe("PR dataset integrity runner", () => {
  it.each([[[]], [["--bootstrap"]]])("rejects generation %s before children", async (args) => {
    const runCommandImpl = vi.fn(async () => 0);
    await expect(runGeneratedArtifacts({ argv: ["--integrity-only", ...args], runCommandImpl }))
      .rejects.toThrow("--integrity-only requires --check");
    expect(() => buildGeneratedArtifactExecutionUnits({ integrityOnly: true })).toThrow("requires --check");
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])("threads CLI and execution units: integrityOnly=%s", async (integrityOnly) => {
    const units = buildGeneratedArtifactExecutionUnits({ check: true, integrityOnly, only: ["public-datasets"] });
    const runCommandImpl = vi.fn(async (_command: string) => 0);
    await runGeneratedArtifacts({ argv: ["--check", "--only=public-datasets", ...(integrityOnly ? ["--integrity-only"] : [])], log: () => {}, runCommandImpl });
    expect(runCommandImpl.mock.calls.map(([command]) => command)).toEqual(units.flatMap(({ commands }) => commands));
    expect(units.find(({ id }) => id === "public-datasets")?.commands)
      .toEqual([`tsx scripts/maintenance/generate-public-datasets.ts --check${integrityOnly ? " --integrity-only" : ""}`]);
  });
});

describe("contracts workspace generated-artifact inputs", () => {
  it.each(["shared/contracts/api-meta.ts", "scripts/lib/public-api-response-schemas.ts"])(
    "invalidates OpenAPI and its dependent API reference for %s",
    (file) => {
      expect(selectChangedGeneratedArtifactIds([file])).toEqual(expect.arrayContaining(["openapi", "api-reference"]));
    },
  );

  it("retains schema-input selection for the catalog after the package move", () => {
    for (const path of ["shared/contracts/request-source.ts", "shared/types/core.ts"]) {
      expect(selectChangedGeneratedArtifactIds([path])).toContain("stablecoin-catalog");
    }
  });
});

const run = (argv: string[], runCommandImpl: (command: string) => Promise<number>, log = vi.fn()) =>
  runGeneratedArtifacts({ argv, runCommandImpl, log, env: { NODE_ENV: "test" } });

describe("generated-artifact runner lifecycle selection", () => {
  const refreshArgv = ["--build-lifecycle=post-refresh"];
  const mockSchedulingPlan = () => vi.spyOn(automationRegistry, "buildGeneratedArtifactPhases").mockReturnValue([
    { phase: 0, artifacts: [{ id: "upstream", command: "fixture:upstream" }, { id: "independent", command: "fixture:independent" }] },
    { phase: 1, artifacts: [{ id: "dependent", command: "fixture:dependent", dependsOn: ["upstream"] }, { id: "independent-later", command: "fixture:independent-later" }] },
    { phase: 2, artifacts: [{ id: "transitive", command: "fixture:transitive", dependsOn: ["dependent"] }] },
  ]);
  const rejectsDownstream = (calls: [string, ...unknown[]][]) => {
    for (const c of ["fixture:dependent", "fixture:transitive"]) expect(calls.some(([cmd]) => cmd === c)).toBe(false);
  };
  it.each(["runbook-index,sitemap-dates"])("rejects CLI request %s without filesystem writes", (ids) => {
    withTempRepo("uncheckable", {}, (cwd) => {
      const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("scripts/maintenance/run-generated-artifacts.ts"), "--check", `--only=${ids}`], { cwd, encoding: "utf8" });
      expect([result.status, result.stderr.includes("bootstrap:generated:history"), readdirSync(cwd)]).toEqual([2, true, []]);
    });
  });

  it.each(["sitemap-dates", "runbook-index,sitemap-dates"])("rejects explicit uncheckable selection %s before any child executes", async (ids) => {
    const child = vi.fn(async () => 0);
    await expect(run(["--check", `--only=${ids}`], child)).rejects.toThrow(/sitemap-dates.*git-history-derived.*bootstrap:generated:history/);
    expect(child).not.toHaveBeenCalled();
  });

  it("reports a legitimate empty intersection without running children", async () => {
    const log = vi.fn(), child = vi.fn(async () => 0);
    expect(await run(["--check", "--only=runbook-index", "--phase=2"], child, log)).toMatchObject({ status: 0, results: [] });
    expect(child).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no checks executed"));
  });

  it("schedules ready DAG nodes without phase barriers and bounds concurrency", async () => {
    using _plan = mockSchedulingPlan();
    const u = Promise.withResolvers<number>(), ue = Promise.withResolvers<void>(), il = Promise.withResolvers<void>(), d = Promise.withResolvers<number>(), de = Promise.withResolvers<void>();
    const child = vi.fn(async (c: string) => c === "fixture:upstream" ? (ue.resolve(), u.promise) : c === "fixture:independent-later" ? (il.resolve(), 0) : c === "fixture:dependent" ? (de.resolve(), d.promise) : 0);
    const pending = run(refreshArgv, child);
    expect(_plan).toHaveBeenCalledWith(expect.objectContaining({ buildLifecycles: ["post-refresh"] }));
    await Promise.all([ue.promise, il.promise]);
    rejectsDownstream(child.mock.calls);
    u.resolve(0); await de.promise;
    expect(child.mock.calls.some(([c]) => c === "fixture:transitive")).toBe(false);
    d.resolve(0);
    const r = await pending;
    expect([r.status, r.results.map((x) => x.id), r.results.every((x) => x.status === 0 && x.statusLabel === "passed" && x.taintedBy.length === 0)])
      .toEqual([0, ["upstream", "independent", "dependent", "independent-later", "transitive"], true]);
  });

  it("bounds DAG concurrency and skips existing transitive deps fail-closed", async () => {
    let cur = 0, peak = 0;
    {
      using _p = vi.spyOn(automationRegistry, "buildGeneratedArtifactPhases").mockReturnValue([
        { phase: 0, artifacts: Array.from({ length: GENERATED_ARTIFACTS_MAX_PARALLEL + 2 }, (_, i) => ({ id: `n${i}`, command: `f:n${i}` })) },
      ]);
      expect([(await run(refreshArgv, async () => { peak = Math.max(peak, ++cur); await new Promise((r) => setTimeout(r, 5)); cur--; return 0; })).status, peak]).toEqual([0, GENERATED_ARTIFACTS_MAX_PARALLEL]);
    }
    const exec = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv = { NODE_ENV: "test" }, out?: string[]) => {
      using _p = vi.spyOn(automationRegistry, "buildGeneratedArtifactPhases").mockReturnValue([
        { phase: 0, artifacts: [{ id: "r", buildLifecycle: "compile-input", command: "f:r", outputPaths: ["o/r"] }] },
        { phase: 1, artifacts: [{ id: "m", buildLifecycle: "compile-input", command: "f:m", dependsOn: ["r"], outputPaths: out ?? ["o/m", "o/d"] }] },
        { phase: 2, artifacts: [{ id: "t", buildLifecycle: "post-refresh", command: "f:t", dependsOn: ["m"], outputPaths: ["o/t"] }] },
      ]);
      const cmds: string[] = [];
      await runGeneratedArtifacts({ argv, cwd, env, log: () => {}, runCommandImpl: async (c) => (cmds.push(c), 0) });
      return cmds;
    };
    await withTempRepo("skip", { "o/r": "1", "o/m": "1", "o/d/a": "1", "o/t": "1" }, async (cwd) => {
      const s = ["--only=t", "--skip-existing-deps"];
      expect(await exec(cwd, s)).toEqual(["f:t"]);
      expect(await exec(cwd, ["--build-lifecycle=post-refresh"], { NODE_ENV: "test", PHAROS_GENERATED_SKIP_EXISTING_DEPS: "1" })).toEqual(["f:t"]);
      expect(await exec(cwd, ["--check", ...s])).toEqual(["f:r", "f:m", "f:t"]);
      for (const bad of [["o/*"], []]) expect(await exec(cwd, s, undefined, bad)).toEqual(["f:m", "f:t"]);
      rmSync(join(cwd, "o/d/a")); expect(await exec(cwd, s)).toEqual(["f:m", "f:t"]);
      rmSync(join(cwd, "o/r")); expect(await exec(cwd, s)).toEqual(["f:r", "f:m", "f:t"]);
    });
  });

  it.each([false, true])("handles upstream failure (continueOnError=%s)", async (continued) => {
    using _p = mockSchedulingPlan();
    const child = vi.fn(async (c: string) => c === "fixture:upstream" ? 7 : 0);
    const r = await run([...refreshArgv, ...(continued ? ["--continue-on-error"] : [])], child);
    expect(r).toMatchObject({ status: 7, failedCmd: "fixture:upstream" });
    if (!continued) { rejectsDownstream(child.mock.calls); expect(r.results.find((x) => x.id === "upstream")).toMatchObject({ status: 7, statusLabel: "failed", taintedBy: [] }); }
    else {
      expect(r.results.map(({ id, statusLabel, taintedBy }) => [id, statusLabel, taintedBy])).toEqual([
        ["upstream", "failed", []], ["independent", "passed", []], ["dependent", "tainted", ["upstream"]],
        ["independent-later", "passed", []], ["transitive", "tainted", ["upstream"]],
      ]);
      expect(r.failures.map(({ unit, status }) => [unit.id, status])).toEqual([["upstream", 7]]);
    }
  });
});

describe("evaluation manifest scheduling", () => {
  const id = "safety-score-v9-evaluation-build", only = `--only=${id}`;
  it.each([["", 0, 7], ["--check", 0, 7], ["--dry-run", 0, 0], ["--check", 1, 6]] as const)(
    "forwards mode %s with prerequisite status %s", async (mode, failure, count) => {
      expect(pkg.scripts[`generate:${id}`]).toBe(`node --import tsx scripts/maintenance/run-generated-artifacts.ts ${only}`);
      const child = vi.fn(async (cmd: string) => {
        if (mode === "--check") expect(cmd).toMatch(/ --check$/);
        return cmd.includes("lane-emitter-descriptors") ? failure : 0;
      });
      expect((await run([only, ...(mode ? [mode] : [])], child)).status).toBe(failure);
      expect(child).toHaveBeenCalledTimes(count);
      if (!failure && count) expect(child.mock.lastCall?.[0]).toBe(["tsx scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts", mode].filter(Boolean).join(" "));
      if (failure) expect(child.mock.calls.some(([cmd]) => cmd.includes("evaluation-build-manifest"))).toBe(false);
    },
  );
  it.each(["missing", "stale", "current"])("converges; %s check preserves bytes", (state) => {
    const source = shock.collectShockCoverageCaptureSources()[0]!,
      files = Object.fromEntries(v9.V9_EVALUATION_BUILD_SOURCE_PATHS.map((p) => [p, "{}"]));
    files[relative(process.cwd(), source.summaryPath)] = JSON.stringify(source.summary);
    withTempRepo("v9", files, (root) => {
      const paths = [shock.SHOCK_COVERAGE_REGISTRY_PATH, "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts"].map((p) => join(root, p)),
        bytes = () => paths.map((p) => existsSync(p) ? readFileSync(p) : null),
        generate = (args: string[]) => { shock.runShockCoverageMeasurementRegistryGenerator(args, root); v9.runV9EvaluationBuildManifestGenerator(args, root); };
      generate([]);
      let before = bytes();
      generate([]);
      expect(bytes()).toEqual(before);
      if (state === "missing") rmSync(paths[0]);
      if (state === "stale") writeFileSync(paths[0], "{}");
      before = bytes();
      using _exit = vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
      if (state === "current") expect(() => generate(["--check"])).not.toThrow();
      else expect(() => generate(["--check"])).toThrow("exit 1");
      expect(bytes()).toEqual(before);
    });
  });
});
