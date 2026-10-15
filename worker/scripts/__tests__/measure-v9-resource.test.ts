import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { measureV9Resource, readHeavyProbeBuildSettings, runResourceChild, validateResourceSamples } from "../../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import type * as Esbuild from "esbuild";

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
    const report = await measureV9Resource(root, "compute", 1, "pre-p2");
    expect(report.violations).toContainEqual(expect.objectContaining({ reason: "harness-error" }));
    expect(JSON.parse(readFileSync(join(root, ".tmp/safety-score-v9-resource/report.json"), "utf8"))).toMatchObject({ complete: false });
    const script = join(root, "crash.mjs");
    writeFileSync(script, "process.exit(7)");
    expect(runResourceChild(root, script, {}, [], root, "crash")).toMatchObject({ status: 7, reasons: [{ reason: "child-failed", status: 7 }] });
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
      await esbuild.build({ stdin: { contents: 'import {PackedWorkerCatalog} from "#pharos-full-catalog"; console.log(JSON.stringify([PackedWorkerCatalog(), PackedWorkerCatalog.name, PackedWorkerCatalog.toString().length]));', resolveDir: root }, outfile, bundle: true, format: "esm", ...settings, minify });
      const child = spawnSync(process.execPath, [outfile], { encoding: "utf8", env: {} });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.slice(0, 2)).toEqual(["packed-worker", "PackedWorkerCatalog"]);
      lengths.push(result[2]);
    }
    expect(lengths[0]).toBeLessThan(lengths[1]);
  });
});
