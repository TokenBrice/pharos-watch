#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCliUsage, parseCliInteger, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { parseAssignments, unquote } from "../lib/wrangler-toml.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const usage = "Usage: node scripts/maintenance/qualify-worker-memory.mjs --out-dir <new-directory> [--runs 5]\nOffline diagnostic only: cold heavy entry/charts loader, warm compute/store/archive, accepted readers. No cap or qualification policy changes; no remote calls.";

export async function assertQualificationHeavyEntry(worker) {
  if (typeof worker?.scheduled !== "function") throw new Error("invalid-heavy-entry");
  if (worker.fetch === undefined) return;
  if (typeof worker.fetch !== "function") throw new Error("invalid-heavy-fetch");
  // The only permitted fetch surface is the private placed executor. Probe
  // without credentials: no D1 or productive execution is admitted.
  const response = await worker.fetch(new Request("https://memory-qualification.invalid/"), {});
  const body = await response.json();
  if (response.status !== 401 || body?.error !== "placed-executor-unauthorized") {
    throw new Error("invalid-heavy-fetch");
  }
}

export function assertQualificationHeavyGraph(inputs) {
  for (const input of inputs) {
    const path = input.replaceAll("\\", "/");
    if (
      /(?:^|\/)worker\/src\/(?:api\/|routes\/|handlers\/http\/|router\.[jt]s)/.test(path) ||
      /(?:^|\/)worker\/src\/telegram\/(?:webhook|commands|callbacks|mini-app|adoption|admin)\//.test(path) ||
      /(?:^|\/)(?:@resvg|satori|yoga-wasm-web|fonts?)(?:\/|$)/.test(path) ||
      /\.(?:wasm|ttf|otf|woff2?)$/i.test(path)
    ) throw new Error(`invalid-heavy-http-graph:${input}`);
  }
}

// Generated probe intentionally defers literal module imports: measuring each
// module-loading boundary is impossible if static imports initialize it first.
export function qualificationProbeSource() {
  return `import { appendFileSync } from 'node:fs';
import { getHeapSpaceStatistics, getHeapCodeStatistics } from 'node:v8';
const output = process.env.PHAROS_QUALIFICATION_OUTPUT;
function memory() {
  return { ...process.memoryUsage(), oldSpace: getHeapSpaceStatistics().filter(s => s.space_name.includes('old') || s.space_name.includes('large_object')), sourceAndCode: getHeapCodeStatistics() };
}
function phase(name, detail = {}) {
  const before = memory();
  globalThis.gc?.();
  appendFileSync(output, JSON.stringify({ phase: name, before, after: memory(), forcedGc: !!globalThis.gc, ...detail }) + '\\n');
}
phase('node-start');
const entry = await import('./worker/src/index.heavy.ts');
if (typeof entry.default.scheduled !== 'function') throw new Error('invalid-heavy-entry');
phase('cold-heavy-entry');
await (${assertQualificationHeavyEntry.toString()})(entry.default);
phase('private-fetch-validated');
const { HEAVY_SLOT_RUNNER_LOADERS } = await import('./worker/src/handlers/scheduled/heavy-runners.ts');
await HEAVY_SLOT_RUNNER_LOADERS.halfHourlyChartsOffset();
phase('cold-charts-loader');
if (process.env.PHAROS_QUALIFICATION_DATABASE) {
  const { DatabaseSync } = await import('node:sqlite');
  const { createSqliteD1 } = await import('./shared/test-utils/sqlite-d1.ts');
  const { loadSafetyScoreV9AcceptedBaselineState, loadSafetyScoreV9LenderCollateralState } = await import('./worker/src/lib/safety-score-v9/accepted-projection-readers.ts');
  const sqlite = new DatabaseSync(process.env.PHAROS_QUALIFICATION_DATABASE, { readOnly: true });
  try {
    const db = createSqliteD1(sqlite);
    const baseline = await loadSafetyScoreV9AcceptedBaselineState(db);
    if (baseline.kind !== 'accepted') throw new Error('baseline-not-accepted:' + baseline.kind);
    phase('accepted-baseline-reader');
    const lender = await loadSafetyScoreV9LenderCollateralState(db);
    if (lender.kind !== 'accepted') throw new Error('lender-not-accepted:' + lender.kind);
    phase('accepted-lender-reader');
    const concurrent = await Promise.all([loadSafetyScoreV9AcceptedBaselineState(db), loadSafetyScoreV9LenderCollateralState(db)]);
    if (concurrent.some(state => state.kind !== 'accepted')) throw new Error('concurrent-read-not-accepted');
    // Retain both admitted projections to measure reader/charts co-residence.
    phase('accepted-readers-co-resident', { generation: baseline.health.acceptedPublicationGenerationId });
  } finally { sqlite.close(); }
}
phase('complete');
`;
}

export async function qualifyWorkerMemory(argv) {
  const { values } = parseStrictCliArgs(argv, { options: {
    "out-dir": { type: "string" }, runs: { type: "string", default: "5" },
  } });
  if (values.help) { console.log(usage); return; }
  assertCliUsage(typeof values["out-dir"] === "string", "--out-dir is required");
  const runs = parseCliInteger(values.runs, { name: "--runs", min: 1, max: 100 });
  const directory = resolve(root, values["out-dir"]);
  // Exclusive creation preserves previous evidence, including failed runs.
  mkdirSync(directory, { recursive: false });
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, v8: process.versions.v8,
    diagnosticOnly: true, policy: "unchanged; qualification not granted by this harness",
    evidence: {
      node: { oldSpace: "128 MiB natural process and separate 256 MiB forced-GC diagnostic", external: "memoryUsage.external/arrayBuffers and V8 source/code statistics; not summed with heap as Worker usage" },
      adaptive: { status: "not-collected", reason: "Collect independently with ops:worker-memory; shared-isolate samples are not phase peaks or subtractable headroom." },
      productionConcurrency: { status: "not-qualified", reason: "Charts/readers co-residence is local only; observe real overlapping heavy invocations after deployment." },
    }, workloads: [], failures: [], complete: false,
  };
  const flush = () => writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  flush();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+)$/.test(key)));
  function child(name, args, protocol = {}) {
    const offlinePreload = pathToFileURL(resolve(root, "worker/scripts/lib/v9-resource-offline.mjs")).href;
    const result = spawnSync(process.execPath, ["--import", offlinePreload, ...args], { cwd: root, env: { ...env, ...protocol }, encoding: "utf8", timeout: 360_000, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(resolve(directory, `${name}.stdout`), result.stdout ?? "");
    writeFileSync(resolve(directory, `${name}.stderr`), result.stderr ?? "");
    const evidence = { name, status: result.status, signal: result.signal, error: result.error?.message ?? null };
    report.workloads.push(evidence);
    if (result.error || result.signal || result.status !== 0) report.failures.push({ ...evidence, reason: "workload-failed" });
    flush();
    return !result.error && !result.signal && result.status === 0;
  }
  try {
    // Existing production-path probe owns fixtures, two warm cycles, store,
    // archive serialization, output identity, and natural-vs-observed parity.
    for (const profile of ["compute", "heavy-warm"]) {
      const profileDirectory = resolve(directory, profile);
      child(profile, ["--import", "tsx", "worker/scripts/measure-v9-resource.ts", "--profile", profile, "--runs", String(runs), "--directory", profileDirectory, "--deadline-seconds", "360"]);
      const result = JSON.parse(readFileSync(resolve(profileDirectory, "report.json"), "utf8"));
      report.workloads.push({ name: `${profile}-phases`, report: `${profile}/report.json`, complete: result.complete, identity: result.identity });
      if (result.complete !== true) report.failures.push({ reason: "incomplete-resource-phases", profile, violations: result.violations });
      flush();
    }
    const require = createRequire(resolve(root, "package.json"));
    const wranglerRequire = createRequire(require.resolve("wrangler"));
    const esbuild = wranglerRequire("esbuild");
    const config = readFileSync(resolve(root, "worker/wrangler.heavy.toml"), "utf8");
    const assignments = parseAssignments(config);
    function required(section, key) {
      const found = assignments.filter(item => item.section === section && item.key === key);
      if (found.length !== 1) throw new Error(`invalid-build-setting:${section}.${key}`);
      return found[0].value;
    }
    const alias = unquote(required("alias", "#pharos-full-catalog"));
    assertCliUsage(typeof alias === "string" && alias.length > 0, "heavy catalog alias missing");
    const built = await esbuild.build({
      absWorkingDir: root, stdin: { contents: qualificationProbeSource(), resolveDir: root, sourcefile: "memory-qualification-probe.mjs", loader: "js" },
      outdir: resolve(directory, "probe"), entryNames: "entry", outExtension: { ".js": ".mjs" },
      bundle: true, splitting: true, metafile: true, format: "esm", platform: "browser", target: "es2024",
      conditions: ["workerd", "worker", "browser"], mainFields: ["browser", "module", "main"], external: ["node:*"],
      minify: required("root", "minify") === "true", keepNames: required("root", "keep_names") === "true",
      alias: { "#pharos-full-catalog": resolve(root, "worker", alias) }, tsconfig: resolve(root, "tsconfig.json"),
      banner: { js: "globalThis.__zod_globalConfig = { jitless: true };" },
      // Match the deployed Text module rather than esbuild's JSON object loader.
      plugins: [{
        name: "packed-catalog-text",
        setup(build) {
          build.onLoad({ filter: /[/\\]coins\.worker-full\.generated\.json$/ }, ({ path }) => ({
            contents: readFileSync(path, "utf8"), loader: "text",
          }));
        },
      }],
    });
    writeFileSync(resolve(directory, "probe.metafile.json"), JSON.stringify(built.metafile));
    assertQualificationHeavyGraph(Object.keys(built.metafile.inputs));
    report.build = { configSha256: createHash("sha256").update(config).digest("hex"), esbuild: esbuild.version };
    for (let run = 1; run <= runs; run++) {
      for (const [mode, flags] of [["natural", ["--max-old-space-size=128"]], ["observed", ["--max-old-space-size=256", "--expose-gc"]]]) {
        for (const workload of ["cold", "readers"]) {
          const name = `${workload}-${mode}-${run}`;
          const output = resolve(directory, `${name}.ndjson`);
          writeFileSync(output, "");
          const ok = child(name, [...flags, resolve(directory, "probe/entry.mjs")], {
            PHAROS_QUALIFICATION_OUTPUT: output,
            ...(workload === "readers" ? { PHAROS_QUALIFICATION_DATABASE: resolve(directory, `compute/hard-cap-${run}.sqlite`) } : {}),
          });
          const samples = readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
          const requiredPhases = ["node-start", "cold-heavy-entry", "private-fetch-validated", "cold-charts-loader", ...(workload === "readers" ? ["accepted-baseline-reader", "accepted-lender-reader", "accepted-readers-co-resident"] : []), "complete"];
          if (!ok || requiredPhases.some(phase => !samples.some(sample => sample.phase === phase))) report.failures.push({ reason: "missing-phase", name });
          flush();
        }
      }
    }
  } catch (error) {
    report.failures.push({ reason: "harness-error", detail: error instanceof Error ? error.stack : String(error) });
  } finally {
    report.complete = report.failures.length === 0;
    flush();
  }
  console.log(JSON.stringify({ report: resolve(directory, "report.json"), complete: report.complete, diagnosticOnly: true }));
  if (!report.complete) process.exitCode = 1;
  return report;
}

runDirectCli(import.meta.url, () => qualifyWorkerMemory(process.argv.slice(2)), { usage });
