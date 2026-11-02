import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertResourceProbeCatalog, buildResourceProbe, buildSafetyScoreV9ContagionProbe, measureV9Resource, readHeavyProbeBuildSettings, runResourceChild, validateResourceSamples } from "../../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import type * as Esbuild from "esbuild";
import { calibrateV9Resource } from "../calibrate-v9-resource";
// Static edge so any change in the contagion closure selects this tripwire.
import { evaluateV9ContagionScenario } from "@shared/lib/safety-score-v9/contagion";
import { GLOBAL_HEAP_BYTES, hasV9ContagionInput, RESOURCE_HARNESS_REVISION, RESOURCE_PHASES, ResourcePolicySchema, loadResourcePolicy, validateResourcePolicy, type ResourceIdentity } from "../lib/v9-resource-policy";

// The lane selector lives with the deploy classifier, whose registry graph the
// Worker type program does not compile (ADR-2). Resolve it by path at runtime so
// this tripwire stays in the suite that owns the bundles it proves.
const CLASSIFIER_MODULE = "../../../scripts/ci/classify-deploy-changes";
const { hasV9ResourceImpact } = await import(CLASSIFIER_MODULE) as {
  hasV9ResourceImpact(files: readonly string[]): boolean;
};

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "v9-resource-protocol-"));
  directories.push(directory);
  return directory;
}

describe("V9 resource diagnostic failure modes", () => {
  it("rejects a retained test allocation against a supplied tiny phase policy", () => {
    const retained = new Array(100_000).fill("retention-probe");
    const memory = process.memoryUsage();
    const samples = [{ type: "phase" as const, cycle: 0, phase: "module-initialized", before: memory, after: memory }];
    expect(validateResourceSamples(samples, ["module-initialized"], { phaseLimitsBytes: { "module-initialized": 1 }, globalPostGcHeapBytes: Number.MAX_SAFE_INTEGER })).toContainEqual(expect.objectContaining({ reason: "phase-budget-exceeded" }));
    expect(retained).toHaveLength(100_000);
    expect(validateResourceSamples([], ["facts-compiled"])).toEqual([
      { reason: "missing-phase", phase: "facts-compiled", cycle: 1 },
      { reason: "missing-phase", phase: "facts-compiled", cycle: 2 },
    ]);
  });

  it("requires only the configured publication cycles", () => {
    const memory = process.memoryUsage();
    const sample = { type: "phase" as const, cycle: 1, phase: "facts-compiled", before: memory, after: memory };
    expect(validateResourceSamples([sample], ["facts-compiled"], undefined, [1])).toEqual([]);
    expect(validateResourceSamples([sample], ["facts-compiled"])).toEqual([{ reason: "missing-phase", phase: "facts-compiled", cycle: 2 }]);
  });

  it("retains a readable report on construction failure and classifies a crashing child", async () => {
    const root = temporary();
    const report = await measureV9Resource(root, "compute", 1, "post-p2");
    expect(report.violations).toContainEqual(expect.objectContaining({ reason: "harness-error" }));
    expect(JSON.parse(readFileSync(join(root, ".tmp/safety-score-v9-resource/report.json"), "utf8"))).toMatchObject({ complete: false });
    const script = join(root, "crash.mjs");
    writeFileSync(script, "process.exit(7)");
    expect(runResourceChild(root, script, {}, [], root, "crash")).toMatchObject({ status: 7, reasons: [{ reason: "child-failed", status: 7 }] });
  });

  it("preloads network denial independently of the workload root", () => {
    const root = temporary();
    const script = join(root, "network.mjs");
    writeFileSync(script, "await fetch('https://example.invalid');");
    expect(runResourceChild(root, script, {}, [], root, "network")).toMatchObject({
      status: 1, reasons: [{ reason: "child-failed", status: 1 }],
    });
    const stderr = readFileSync(join(root, "network.stderr"), "utf8");
    expect(stderr).toContain("worker-memory-network-denied");
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("shares a measurement deadline across children and retains evidence before any build or child", async () => {
    const root = temporary();
    const pending = measureV9Resource(root, "compute", 1, "post-p2", { deadlineMs: 0 });
    const path = join(root, ".tmp/safety-score-v9-resource/report.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ complete: false, runs: [] });
    const report = await pending;
    expect(report.violations).toContainEqual(expect.objectContaining({ reason: "wall-timeout" }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ complete: false, violations: [expect.objectContaining({ reason: "wall-timeout" })] });
    const script = join(root, "hang.mjs");
    // Exercise the real OS spawn timeout/kill path; fake timers cannot interrupt a child.
    writeFileSync(script, 'process.on("SIGTERM", () => {}); while (true) {}');
    const deadline = Date.now() + 100;
    expect(runResourceChild(root, script, {}, [], root, "hang", deadline).reasons).toEqual([{ reason: "wall-timeout" }]);
    const marker = join(root, "should-not-run");
    writeFileSync(script, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
    expect(runResourceChild(root, script, {}, [], root, "expired", deadline).reasons).toEqual([{ reason: "wall-timeout" }]);
    expect(() => readFileSync(marker)).toThrow();
  });

  // Nightly tier: two real wrangler/esbuild builds (~2.6 s on CI). On a selected
  // PR the v9 lane's safety-score-v9-resource-budget harness builds both probes
  // through buildResourceProbe (readHeavyProbeBuildSettings alias plus
  // assertResourceProbeCatalog), and the crash, network-denial and wall-timeout
  // cases above stay on the PR tier. The minify/keep_names effect assertions and
  // the wrong-loader rejection are nightly only.
  it("proves alias, minify and keep_names translation through bundled behavior", { tags: ["nightly"] }, async () => {
    const root = temporary();
    mkdirSync(join(root, "worker"));
    writeFileSync(join(root, "worker/wrangler.heavy.toml"), 'minify = true\nkeep_names = true\n[alias]\n"#pharos-full-catalog" = "./packed.ts"\n');
    writeFileSync(join(root, "worker/packed.ts"), 'import text from "./coins.worker-full.generated.json"; import ordinary from "./ordinary.json"; export function PackedWorkerCatalog() { return JSON.parse(text).value + ordinary.value; }');
    writeFileSync(join(root, "worker/coins.worker-full.generated.json"), '{"value":"packed-"}');
    writeFileSync(join(root, "worker/ordinary.json"), '{"value":"worker"}');
    const { configSha256: _configSha256, ...settings } = readHeavyProbeBuildSettings(root);
    const require = createRequire(resolve("package.json"));
    const esbuild = createRequire(require.resolve("wrangler"))("esbuild") as typeof Esbuild;
    const lengths: number[] = [];
    for (const minify of [settings.minify, false]) {
      const outfile = join(root, `behavior-${minify}.mjs`);
      const built = await esbuild.build({ absWorkingDir: root, stdin: { contents: 'import {PackedWorkerCatalog} from "#pharos-full-catalog"; console.log(JSON.stringify([PackedWorkerCatalog(), PackedWorkerCatalog.name, PackedWorkerCatalog.toString().length]));', resolveDir: root }, outfile, bundle: true, metafile: true, format: "esm", ...settings, minify });
      expect(() => assertResourceProbeCatalog(built.metafile!, "worker/packed.ts")).not.toThrow();
      expect(() => assertResourceProbeCatalog(built.metafile!, "worker/wrong-loader.ts")).toThrow("catalog-alias-not-packed-worker-loader");
      const child = spawnSync(process.execPath, [outfile], { encoding: "utf8", env: {} });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.slice(0, 2)).toEqual(["packed-worker", "PackedWorkerCatalog"]);
      lengths.push(result[2]);
    }
    expect(lengths[0]).toBeLessThan(lengths[1]);
  });
});

describe("V9 contagion input decision", () => {
  it("covers every input the nine-scenario probe bundles", () => {
    expect(typeof evaluateV9ContagionScenario).toBe("function");
    const root = resolve(import.meta.dirname, "../../..");
    const { inputs: bundled } = buildSafetyScoreV9ContagionProbe(root, temporary());
    // Third-party modules are pinned by the lockfiles, themselves contagion
    // inputs; CI checks out node_modules inside the repo, local worktrees may not.
    const inputs = bundled
      .map((input) => relative(root, input).replaceAll("\\", "/"))
      .filter((input) => !input.startsWith("..") && !/(^|\/)node_modules\//.test(input));
    expect(hasV9ContagionInput(["package-lock.json"]) && hasV9ContagionInput(["worker/package-lock.json"])).toBe(true);
    for (const expected of [
      "shared/lib/safety-score-v9/contagion.ts",
      "shared/lib/peg-score.ts",
      "shared/lib/report-card-evidence-journal.ts",
      "shared/data/stablecoins/coins.generated.json",
      "worker/src/test-helpers/v9-fixed-input.ts",
      "worker/src/lib/safety-score-v9/candidate.ts",
    ]) expect(inputs, expected).toContain(expected);
    expect(inputs.filter((input) => !hasV9ContagionInput([input]))).toEqual([]);
  });

  it("matches the probe harness and toolchain while unrelated diffs skip contagion", () => {
    for (const file of ["worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts",
      "worker/scripts/lib/v9-resource-policy.ts", "worker/scripts/measure-v9-resource.ts",
      "shared/lib/peg-score.ts", "shared/lib/report-card-evidence-journal.ts",
      "shared/data/stablecoins/coins.generated.json", "worker/src/test-helpers/v9-fixed-input.ts",
      "package.json", "package-lock.json", "worker/wrangler.heavy.toml", "tsconfig.base.json", ".nvmrc"]) {
      expect(hasV9ContagionInput([file]), file).toBe(true);
    }
    expect(hasV9ContagionInput(["README.md", "src/app/page.tsx", "shared/lib/blacklist.ts"])).toBe(false);
  });
});

describe("V9 resource lane selection", () => {
  // Bundling both real probes takes ~25 s on a CI runner, so this whole-closure
  // proof is nightly-tier; the PR tier keeps the per-path rows in
  // scripts/__tests__/classify-deploy-changes.test.ts and the contagion bundle check above.
  it("selects every input the measured setup and live bundles contain", { tags: ["nightly"], timeout: 120_000 }, async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const directory = temporary();
    const modes = ["setup", "live"] as const;
    const built = await Promise.all(modes.map((mode) => buildResourceProbe(root, directory, mode)));
    for (const [index, mode] of modes.entries()) {
      const bundled = built[index].inputs
        .map((input) => relative(root, input).replaceAll("\\", "/"))
        .filter((input) => !input.startsWith(".."));
      // Vendor packages and builtins are external; the toolchain pattern owns those.
      expect(bundled.length, mode).toBeGreaterThan(100);
      expect(bundled.filter((input) => !hasV9ResourceImpact([input])), mode).toEqual([]);
    }
  });

  it("selects the harness that builds and drives those children", () => {
    for (const file of [
      "worker/scripts/measure-v9-resource.ts",
      "scripts/maintenance/run-v9-resource-lane.ts",
      "worker/src/lib/__tests__/safety-score-v9-resource-fixture.test-support.ts",
      "worker/src/lib/__tests__/safety-score-v9-resource-probe.test-support.ts",
      "worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts",
    ]) expect(hasV9ResourceImpact([file]), file).toBe(true);
  });
});

const policyIdentity: ResourceIdentity = {
  harnessRevision: RESOURCE_HARNESS_REVISION, phaseManifest: "post-p2", node: "v24.0.0", v8: "13.0",
  esbuild: "0.25.0", wrangler: "4.0.0", platform: "linux", arch: "x64",
  runner: { kind: "local", description: "test host", image: "linux", version: "test-kernel" },
  fixture: { kind: "current-full-registry-native", sourceSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
  protocolSha256: "c".repeat(64),
  configSha256: "d".repeat(64),
};
function validPolicy() {
  return { schemaVersion: 1, identity: policyIdentity, globalPostGcHeapBytes: GLOBAL_HEAP_BYTES,
    hardCapOldSpaceMiB: 128, measurementOldSpaceMiB: 256, toleranceBytes: 2097152, roundingBytes: 262144,
    phaseLimitsBytes: Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, 12 * 1024 * 1024])),
    calibration: { revision: "test-revision", reportSha256s: [1, 2, 3, 4, 5].map((n) => n.toString().repeat(64)),
      natural128MiBSuccesses: 5, phaseMaximaBytes: Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, 10 * 1024 * 1024])) } };
}

describe("V9 resource reviewed policy", () => {
  it("accepts only complete matching five-run evidence and never normalizes invalid ceilings", () => {
    expect(() => validateResourcePolicy(validPolicy(), policyIdentity)).not.toThrow();
    for (const invalid of [undefined, null, {}, { ...validPolicy(), schemaVersion: 2 },
      { ...validPolicy(), globalPostGcHeapBytes: GLOBAL_HEAP_BYTES + 1 },
      { ...validPolicy(), phaseLimitsBytes: {} },
      { ...validPolicy(), phaseLimitsBytes: { ...validPolicy().phaseLimitsBytes, "facts-compiled": NaN } },
      { ...validPolicy(), phaseLimitsBytes: { ...validPolicy().phaseLimitsBytes, "facts-compiled": GLOBAL_HEAP_BYTES + 1 } },
      { ...validPolicy(), calibration: { ...validPolicy().calibration, natural128MiBSuccesses: 4 } },
      { ...validPolicy(), calibration: { ...validPolicy().calibration, reportSha256s: Array(5).fill("a".repeat(64)) } },
      { ...validPolicy(), calibration: { ...validPolicy().calibration, phaseMaximaBytes: { ...validPolicy().calibration.phaseMaximaBytes, "facts-compiled": 110 * 1024 * 1024 + 1 } } },
      { ...validPolicy(), phaseLimitsBytes: { ...validPolicy().phaseLimitsBytes, "facts-compiled": 13 * 1024 * 1024 } },
    ]) expect(() => validateResourcePolicy(invalid, policyIdentity)).toThrow();
    for (const key of ["node", "v8", "esbuild", "wrangler", "harnessRevision", "phaseManifest", "platform", "arch", "configSha256"] as const) {
      expect(() => validateResourcePolicy(validPolicy(), { ...policyIdentity, [key]: "mismatch" } as ResourceIdentity)).toThrow();
    }
    expect(() => validateResourcePolicy(validPolicy(), { ...policyIdentity, fixture: { ...policyIdentity.fixture, manifestSha256: "d".repeat(64) } })).toThrow("fixture");
  });


  it("allows only explicitly unqualified absence and automatically enforces a subsequently installed policy", () => {
    const path = join(temporary(), "policy.json");
    expect(() => loadResourcePolicy(path, policyIdentity)).toThrow();
    expect(loadResourcePolicy(path, policyIdentity, true)).toBeNull();
    writeFileSync(path, "{}");
    expect(() => loadResourcePolicy(path, policyIdentity, true)).toThrow();
    writeFileSync(path, JSON.stringify(validPolicy()));
    expect(loadResourcePolicy(path, policyIdentity, true)).toMatchObject(validPolicy());
    expect(() => loadResourcePolicy(path, { ...policyIdentity, node: "different-node" }, true)).toThrow("node");
  });

  it("calibrates only proposed output, preserves .ci bytes, and leaves one-run smoke unqualified", async () => {
    const root = temporary();
    mkdirSync(join(root, ".ci"));
    const checkedIn = join(root, ".ci/safety-score-v9-resource-budget.json");
    const original = `${JSON.stringify(validPolicy())}\n`;
    writeFileSync(checkedIn, original);
    let invocation = 0;
    const measure: typeof measureV9Resource = async (_root, _profile, _runs, _manifest, options) => {
      invocation += 1;
      const report = { identity: { ...policyIdentity, protocolSha256: String(invocation).repeat(64),
        runner: { kind: "github" as const, description: "unknown", image: "unknown", version: `rollover-${invocation}` } },
        sourceHashes: { "package-lock.json": String(invocation).repeat(64) },
        testedSha: "test-revision", invocationId: invocation, complete: true, violations: [],
        runs: [{ run: 1, violations: [],
          live: { status: 0, signal: null, error: null, reasons: [], cycles: [], archives: [],
            phaseMaxima: Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, { samples: 2, postGcHeapBytes: 10 * 1024 * 1024, beforeGcHeapBytes: 11 * 1024 * 1024 }])) },
          "hard-cap": { status: 0, signal: null, error: null, reasons: [], cycles: [], archives: [], phaseMaxima: {} } }] };
      mkdirSync(options!.directory!, { recursive: true });
      writeFileSync(join(options!.directory!, "report.json"), JSON.stringify(report));
      return report;
    };
    const qualified = await calibrateV9Resource(root, 5, measure);
    expect(qualified.qualified).toBe(true);
    expect(() => ResourcePolicySchema.parse(qualified.policy)).not.toThrow();
    expect(readFileSync(checkedIn, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(join(root, ".tmp/safety-score-v9-resource/proposed-policy.json"), "utf8"))).toEqual(qualified.policy);
    const smoke = await calibrateV9Resource(root, 1, measure);
    expect(smoke.qualified).toBe(false);
    expect(() => ResourcePolicySchema.parse(smoke.policy)).toThrow();
    expect(readFileSync(checkedIn, "utf8")).toBe(original);
  });
});
