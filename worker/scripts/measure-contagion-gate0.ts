import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parseSafetyScoreV9ReplayFixedInput, buildSafetyScoreV9ReplayArtifact } from "./replay-safety-score-v9";
import { localRegistrySnapshot } from "./lib/safety-score-v9-registry";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { evaluateV9ContagionScenario } from "@shared/lib/safety-score-v9/contagion";
import type { ContagionShock } from "@shared/types/contagion";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";

const USAGE = `Usage: node --expose-gc --import tsx worker/scripts/measure-contagion-gate0.ts --graph <path> --out-dir <path>

Options:
  --graph <path>    Dependency graph snapshot used to select the hub cohort (required)
  --out-dir <path>  Directory for retained capture and measurement artifacts (required)
  -h, --help        Show this help`;

async function main(): Promise<void> {
const { values } = parseStrictCliArgs(process.argv.slice(2), {
  options: { graph: { type: "string" }, "out-dir": { type: "string" } },
});
if (writeCliHelpIfRequested(values, USAGE)) return;
assertCliUsage(typeof values.graph === "string" && values.graph.trim().length > 0, "--graph is required");
assertCliUsage(typeof values["out-dir"] === "string" && values["out-dir"].trim().length > 0, "--out-dir is required");
const root = process.cwd();
const graph = JSON.parse(readFileSync(resolve(root, values.graph), "utf8"));
const directory = resolve(root, values["out-dir"]);
mkdirSync(directory, { recursive: true });
if (existsSync(resolve(root, ".env.local"))) process.loadEnvFile(resolve(root, ".env.local"));
const rawPath = resolve(directory, "capture.raw.json");
  const captureEnv = { ...process.env };
  // Wrangler's checked-in account owns D1; .env.local also carries R2 tooling credentials.
  delete captureEnv.CLOUDFLARE_ACCOUNT_ID;
if (!existsSync(rawPath)) {
  const exported = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--command", "SELECT value, updated_at FROM cache WHERE key = 'report-cards:fixed-input:exact'"], { cwd: resolve(root, "worker"), encoding: "utf8", maxBuffer: 30_000_000, env: captureEnv });
  if (exported.status !== 0) throw new Error(`Production D1 capture failed (${exported.status}); ${exported.stderr || exported.stdout}`);
  writeFileSync(rawPath, exported.stdout);
}
const exported = JSON.parse(readFileSync(rawPath, "utf8"));
const envelope = JSON.parse(exported[0].results[0].value);
const fixedInput = await parseSafetyScoreV9ReplayFixedInput(envelope);
const registrySnapshot = localRegistrySnapshot();
writeFileSync(resolve(directory, "capture.json"), JSON.stringify({ kind: "safety-score-v9-registry-capture", registrySnapshot, fixedInput }));
let replay = buildSafetyScoreV9ReplayArtifact({ fixedInput, publishedAtSec: fixedInput.clockSec, allowRegistryMismatch: true });
const { v9FactSetDigest: _digest, ...rawCompileInput } = replay.pipeline.compiledFacts;
writeFileSync(resolve(directory, "raw-compile-input.json"), JSON.stringify(rawCompileInput));
const publicationGenerationId = replay.pipeline.candidate.publicationGenerationId;
const captureIdentity = { clockSec: fixedInput.clockSec, cacheUpdatedAt: exported[0].results[0].updated_at, publicationGenerationId, registryMode: "current checkout curation; producer registry mismatch allowed; not an accepted historical publication replay" };
// The scenario input is the retained raw compiler core. Do not deserialize compiled facts.
replay = null as unknown as typeof replay;
const policy = loadV9CandidateMethodologyPolicy(fixedInput.clockSec);
const exposure = new Map<string, number>();
for (const edge of graph.edges) {
  const share = edge.kind === "serial" ? 1 : edge.weight;
  if (share !== null && typeof edge.toMcapUsd === "number") exposure.set(edge.from, (exposure.get(edge.from) ?? 0) + share * edge.toMcapUsd);
}
const hubs = [...exposure].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15);
const measurements = [];
const startCpu = process.cpuUsage();
const start = performance.now();
const recompileStart = performance.now();
const recompileCpu = process.cpuUsage();
compileV9FactSetV3(rawCompileInput);
const recompile = { wallMs: performance.now() - recompileStart, cpuMs: (process.cpuUsage(recompileCpu).user + process.cpuUsage(recompileCpu).system) / 1000 };
for (const [assetId, directExposureMarketCapProxyUsd] of hubs) {
  const shocks: ContagionShock[] = [
    { kind: "score-limit", assetId, dimension: "final", limit: 40 },
    { kind: "depeg", assetId, activeDepegBps: 1000, template: "one-day-history-and-exit-held" },
    { kind: "mint-control-compromise", assetId },
  ];
  for (const shock of shocks) {
    globalThis.gc?.();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const memoryBefore = process.memoryUsage();
    const result = evaluateV9ContagionScenario({ rawCompileInput, policy, clock: fixedInput.clockSec, publicationGenerationId }, { id: `gate0:${assetId}:${shock.kind}`, shocks: [shock] });
    const cpuUsed = process.cpuUsage(cpu);
    const memoryAfter = process.memoryUsage();
    measurements.push({ assetId, directExposureMarketCapProxyUsd, shock, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, wallMs: performance.now() - started,
      memoryBefore, memoryAfter, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      manifest: result.manifest, changed: result.rows.filter((row) => row.changedDimensions.length > 0).length });
    await yieldTurn();
  }
}
const cohortCpu = process.cpuUsage(startCpu);
const results = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  method: "Sequential tsx Node process. Each scenario recompiles baseline and hypothetical raw V3 facts and evaluates both full sets. CPU=process.cpuUsage user+system; wall=performance.now; peak RSS=process.resourceUsage lifetime high-water; heap=memoryUsage boundary samples, not exact intrafunction peak. Capture/replay bootstrap excluded from cohort time but included in lifetime RSS. When --expose-gc is supplied, GC runs before each scenario, included in cohort but excluded from scenario time. No Worker/concurrency or publication placement decision.",
  explicitGc: typeof globalThis.gc === "function",
  policyDigest: policy.semanticDigest,
  captureIdentity, assets: rawCompileInput.assets.length, scenarios: measurements.length, recompile,
  cohort: { cpuMs: (cohortCpu.user + cohortCpu.system) / 1000, wallMs: performance.now() - start, peakRssBytes: process.resourceUsage().maxRSS * 1024, peakSampledHeapUsedBytes: Math.max(...measurements.flatMap((row) => [row.memoryBefore.heapUsed, row.memoryAfter.heapUsed])) }, measurements };
writeFileSync(resolve(directory, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ captureIdentity, assets: results.assets, scenarios: results.scenarios, recompile, cohort: results.cohort }));
}
void runCliEntrypoint(main, { label: "contagion:measure-gate0", usage: USAGE });
