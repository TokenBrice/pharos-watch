import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertResourceProbeCatalog, measureV9Resource, readHeavyProbeBuildSettings, runResourceChild, validateResourceSamples } from "../../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import type * as Esbuild from "esbuild";
import { calibrateV9Resource } from "../calibrate-v9-resource";
import { GLOBAL_HEAP_BYTES, RESOURCE_HARNESS_REVISION, RESOURCE_PHASES, ResourcePolicySchema, loadResourcePolicy, validateResourcePolicy, type ResourceIdentity } from "../lib/v9-resource-policy";

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

  it("retains a readable report on construction failure and classifies a crashing child", async () => {
    const root = temporary();
    const report = await measureV9Resource(root, "compute", 1, "post-p2");
    expect(report.violations).toContainEqual(expect.objectContaining({ reason: "harness-error" }));
    expect(JSON.parse(readFileSync(join(root, ".tmp/safety-score-v9-resource/report.json"), "utf8"))).toMatchObject({ complete: false });
    const script = join(root, "crash.mjs");
    writeFileSync(script, "process.exit(7)");
    expect(runResourceChild(root, script, {}, [], root, "crash")).toMatchObject({ status: 7, reasons: [{ reason: "child-failed", status: 7 }] });
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

  it("proves alias, minify and keep_names translation through bundled behavior", async () => {
    const root = temporary();
    mkdirSync(join(root, "worker"));
    writeFileSync(join(root, "worker/wrangler.heavy.toml"), 'minify = true\nkeep_names = true\n[alias]\n"#pharos-full-catalog" = "./packed.ts"\n');
    writeFileSync(join(root, "worker/packed.ts"), 'export function PackedWorkerCatalog() { return "packed-worker"; }');
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
