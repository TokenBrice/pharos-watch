import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { hostname, release } from "node:os";
import { RESOURCE_HARNESS_REVISION, RESOURCE_PHASES, loadResourcePolicy, type ResourcePolicy, type ResourceIdentity } from "../../../scripts/lib/v9-resource-policy";
import ts from "typescript";
import { z } from "zod";
import type * as Esbuild from "esbuild";
import type { BuildOptions, Plugin } from "esbuild";
import { parseAssignments, unquote } from "../../../../scripts/lib/wrangler-toml.mjs";
import { resourceChildEnvironment } from "./safety-score-v9-resource-env.test-support";

export type ResourceProfile = "compute" | "heavy-warm";
export type PhaseManifest = "post-p2";
export { RESOURCE_HARNESS_REVISION };
export const PHASE_MANIFESTS = { "post-p2": RESOURCE_PHASES };
export const RESOURCE_MEASUREMENT_DEADLINE_MS = 300_000;
class ResourceWallTimeout extends Error {
  constructor() { super("overall-resource-measurement-deadline-exceeded"); }
}
export function readHeavyProbeBuildSettings(root: string) {
  const path = resolve(root, "worker/wrangler.heavy.toml");
  const source = readFileSync(path, "utf8");
  const assignments = parseAssignments(source);
  function required(section: string, key: string) {
    const found = assignments.filter((item) => item.section === section && item.key === key);
    if (found.length !== 1) throw new Error(`invalid-build-setting:${section}.${key}`);
    return found[0].value;
  }
  function booleanSetting(key: string) {
    const value = required("root", key);
    if (value !== "true" && value !== "false") throw new Error(`invalid-build-setting:${key}`);
    return value === "true";
  }
  const aliasValue = unquote(required("alias", "#pharos-full-catalog"));
  if (!aliasValue) throw new Error("invalid-build-setting:catalog-alias");
  return {
    configSha256: createHash("sha256").update(source).digest("hex"),
    minify: booleanSetting("minify"), keepNames: booleanSetting("keep_names"),
    alias: { "#pharos-full-catalog": resolve(dirname(path), aliasValue) },
    platform: "browser" as const, conditions: ["workerd", "worker", "browser"], target: "es2024",
    mainFields: ["browser", "module", "main"],
  };
}

type Site = { file: string; fn: string; phase: string; kind: "variable" | "call" | "return" | "assignment"; name: string; before?: boolean; contains?: string };
// Structural hooks are deliberately fail-closed: a renamed/duplicated statement is a protocol revision.
const SITES: Site[] = [
  { file: "worker/src/cron/compute-safety-score-v9.ts", fn: "computeSafetyScoreV9", phase: "native-envelope-loaded", kind: "variable", name: "caches" },
  { file: "worker/src/lib/report-cards-fixed-input-cache-codec.ts", fn: "parseFixedInputCacheEntry", phase: "native-inflate-decoded", kind: "variable", name: "payloadText" },
  { file: "worker/src/cron/compute-safety-score-v9.ts", fn: "computeSafetyScoreV9", phase: "native-input-decoded", kind: "variable", name: "fixedInput" },
  { file: "worker/src/cron/compute-safety-score-v9.ts", fn: "computeSafetyScoreV9", phase: "enrichment-loaded", kind: "variable", name: "evidenceJournalById" },
  { file: "worker/src/lib/safety-score-v9/accepted-projection-readers.ts", fn: "loadSafetyScoreV9AcceptedBaselineState", phase: "accepted-baseline-row-loaded", kind: "variable", name: "row" },
  { file: "worker/src/lib/safety-score-v9/accepted-projection-readers.ts", fn: "loadSafetyScoreV9AcceptedBaselineState", phase: "accepted-baseline-parsed", kind: "variable", name: "state" },
  { file: "worker/src/lib/safety-score-v9/publication-runner.ts", fn: "runSafetyScoreV9Publication", phase: "accepted-baseline-ready", kind: "variable", name: "acceptedPublication" },
  { file: "worker/src/lib/safety-score-v9/candidate.ts", fn: "buildSafetyScoreV9CandidatePipeline", phase: "extension-built", kind: "variable", name: "extension" },
  { file: "worker/src/lib/safety-score-v9/candidate.ts", fn: "buildSafetyScoreV9CandidatePipeline", phase: "facts-compiled", kind: "variable", name: "compiledFacts" },
  { file: "worker/src/lib/safety-score-v9/candidate.ts", fn: "buildSafetyScoreV9CandidatePipeline", phase: "evaluation-complete", kind: "variable", name: "projected" },
  { file: "worker/src/lib/safety-score-v9/candidate.ts", fn: "publishEvaluatedCandidate", phase: "candidate-finalized", kind: "variable", name: "candidate" },
  { file: "worker/src/lib/safety-score-v9/publication-runner.ts", fn: "runSafetyScoreV9Publication", phase: "gate-assessed", kind: "assignment", name: "assessment", contains: "assessV9Publication(" },
  { file: "worker/src/lib/safety-score-v9/publication-runner.ts", fn: "runSafetyScoreV9Publication", phase: "replay-serialized", kind: "assignment", name: "replayCaptureValue" },
  { file: "worker/src/lib/safety-score-v9/publication-store.ts", fn: "persistSafetyScoreV9Publication", phase: "score-index-serialized", kind: "assignment", name: "scoreIndexValue" },
  { file: "worker/src/lib/safety-score-v9/publication-store.ts", fn: "persistSafetyScoreV9Publication", phase: "publication-committed", kind: "call", name: "executeAtomicBatch" },
  { file: "worker/src/lib/safety-score-v9/publication-runner.ts", fn: "runSafetyScoreV9Publication", phase: "alert-envelope-projected", kind: "call", name: "persistAlertSafetyV9SourceEnvelope" },
  { file: "worker/src/lib/safety-score-v9/publication-runner.ts", fn: "runSafetyScoreV9Publication", phase: "journal-complete", kind: "variable", name: "journal", contains: 'outcome: "accepted"' },
  { file: "worker/src/lib/safety-score-v9/capture-archive.ts", fn: "archiveSafetyScoreCapture", phase: "archive-string-built", kind: "variable", name: "value" },
  { file: "worker/src/lib/safety-score-v9/capture-archive.ts", fn: "archiveSafetyScoreCapture", phase: "archive-upload-pending", kind: "variable", name: "upload" },
];

function instrumentation(root: string): Plugin {
  const sites = [...SITES];
  sites.push(
    { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: "admitAndSerializeSafetyScoreV9Publication", phase: "store-admitted", kind: "variable", name: "publication" },
    { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: "admitAndSerializeSafetyScoreV9Publication", phase: "publication-gzip-complete", kind: "variable", name: "compressed" },
  );
  const counts = new Map(sites.map((site) => [site.phase, 0]));
  return {
    name: "pharos-resource-phases",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const selected = sites.filter((site) => path === resolve(root, site.file));
        if (!selected.length) return;
        const source = readFileSync(path, "utf8");
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const insertions: Array<{ at: number; text: string }> = [];
        function visit(node: ts.Node) {
          for (const site of selected) {
            let parent: ts.Node | undefined = node.parent;
            let fn = "";
            while (parent) {
              if (ts.isFunctionDeclaration(parent) && parent.name) { fn = parent.name.text; break; }
              parent = parent.parent;
            }
            if (fn !== site.fn) continue;
            let matches = false;
            if (site.kind === "variable" && ts.isVariableStatement(node)) matches = node.declarationList.declarations.some((item) =>
              ts.isIdentifier(item.name) ? item.name.text === site.name
                : item.name.elements.some((element) => ts.isBindingElement(element) && element.name.getText(ast) === site.name));
            if (site.kind === "call" && ts.isExpressionStatement(node)) {
              let expression = node.expression;
              if (ts.isAwaitExpression(expression)) expression = expression.expression;
              matches = ts.isCallExpression(expression) && expression.expression.getText(ast) === site.name;
            }
            if (site.kind === "return" && ts.isReturnStatement(node)) matches = node.expression?.getText(ast) === site.name;
            if (site.kind === "assignment" && ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) matches = node.expression.left.getText(ast) === site.name && node.expression.right.getText(ast) !== '""';
            if (!matches || (site.contains && !node.getText(ast).includes(site.contains))) continue;
            counts.set(site.phase, counts.get(site.phase)! + 1);
            insertions.push({ at: site.before ? node.getStart(ast) : node.end, text: `;globalThis.__pharosResourcePhase(${JSON.stringify(site.phase)});` });
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
        let contents = source;
        for (const insertion of insertions.sort((a, b) => b.at - a.at)) contents = contents.slice(0, insertion.at) + insertion.text + contents.slice(insertion.at);
        return { contents, loader: "ts" };
      });
      build.onEnd(() => {
        const invalid = [...counts].filter(([, count]) => count !== 1);
        if (invalid.length) throw new Error(`phase-transform-mismatch:${JSON.stringify(invalid)}`);
      });
    },
  };
}

const OBSERVER_BANNER = `import { appendFileSync as __resourceAppend } from 'node:fs';
globalThis.__pharosResourcePhase = (phase) => {
  if (typeof globalThis.gc !== 'function') throw new Error('forced-gc-unavailable');
  const before = process.memoryUsage(); globalThis.gc(); const after = process.memoryUsage();
  __resourceAppend(process.env.PHAROS_RESOURCE_OUTPUT, JSON.stringify({type:'phase',phase,cycle:globalThis.__pharosResourceCycle ?? 0,before,after})+'\\n');
};`;
export function assertResourceProbeCatalog(metafile: Esbuild.Metafile, packedLoader: string) {
  const loader = packedLoader.replaceAll("\\", "/");
  const inputs = Object.keys(metafile.inputs).map((input) => input.replaceAll("\\", "/"));
  if (!inputs.includes(loader) || !Object.values(metafile.inputs).some((input) =>
    input.imports.some((edge) => edge.original === "#pharos-full-catalog" && !edge.external && edge.path.replaceAll("\\", "/") === loader))) {
    throw new Error("catalog-alias-not-packed-worker-loader");
  }
}

export async function buildResourceProbe(root: string, directory: string, mode: "live" | "hard-cap" | "setup") {
  const require = createRequire(resolve(root, "package.json"));
  const wranglerRequire = createRequire(require.resolve("wrangler"));
  const esbuild = wranglerRequire("esbuild") as typeof Esbuild;
  const settings = readHeavyProbeBuildSettings(root);
  const { configSha256: _configSha256, ...buildSettings } = settings;
  const outfile = resolve(directory, `${mode}.mjs`);
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [resolve(root, `worker/src/lib/__tests__/safety-score-v9-resource-${mode === "setup" ? "fixture" : "probe"}.test-support.ts`)],
    outfile, bundle: true, metafile: true, format: "esm", ...buildSettings,
    external: ["node:*"], tsconfig: resolve(root, "tsconfig.json"), logLevel: "silent",
    banner: { js: `globalThis.__zod_globalConfig = { jitless: true };\n${mode === "live" ? OBSERVER_BANNER : ""}` },
    plugins: mode === "live" ? [instrumentation(root)] : [],
  } as BuildOptions);
  const metafile = result.metafile!;
  const loader = relative(root, settings.alias["#pharos-full-catalog"]);
  assertResourceProbeCatalog(metafile, loader);
  if (mode !== "setup") {
    for (const input of Object.keys(metafile.inputs)) {
      if (/resource-fixture|full-registry-input|latest-schema-sqlite/.test(input)) throw new Error(`setup-import-in-measured-graph:${input}`);
    }
  }
  writeFileSync(resolve(directory, `${mode}.metafile.json`), JSON.stringify(metafile));
  return { outfile, sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex"), esbuildVersion: esbuild.version, settings, inputs: Object.keys(metafile.inputs), wranglerVersion: require("wrangler/package.json").version as string };
}

export type ResourceViolation = { reason: string; [key: string]: unknown };
const MemorySchema = z.object({ heapUsed: z.number().nonnegative(), heapTotal: z.number().nonnegative(), rss: z.number().nonnegative(), external: z.number().nonnegative(), arrayBuffers: z.number().nonnegative() });
const SampleSchema = z.object({
  type: z.enum(["start", "phase", "progress", "cycle-start", "cycle-result", "complete", "failure"]),
  cycle: z.number().int().nonnegative().default(0), phase: z.string().optional(),
  before: MemorySchema.optional(), after: MemorySchema.optional(),
  metadata: z.object({ publication: z.object({ publicationGenerationId: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
  archives: z.array(z.object({ cycle: z.number(), key: z.string(), bytes: z.number(), sha256: z.string() })).optional(),
}).passthrough();
type ResourceSample = z.infer<typeof SampleSchema>;
type ChildResult = { status: number | null; signal: NodeJS.Signals | null; error: string | null; reasons: ResourceViolation[] };
type ModeResult = ChildResult & {
  phaseMaxima: Record<string, { samples: number; postGcHeapBytes: number; beforeGcHeapBytes: number } | null>;
  cycles: ResourceSample[]; archives: ResourceSample["archives"] | null;
};
type RunResult = { run: number; violations: ResourceViolation[]; live?: ModeResult; "hard-cap"?: ModeResult };
export type ResourceReport = Record<string, unknown> & { complete?: boolean; identity?: ResourceIdentity; runs: RunResult[]; violations: ResourceViolation[] };
export function validateResourceSamples(samples: ResourceSample[], phases: readonly string[], policy?: { phaseLimitsBytes: Record<string, number>; globalPostGcHeapBytes: number }): ResourceViolation[] {
  const violations: ResourceViolation[] = [];
  for (const phase of phases) {
    const matching = samples.filter((sample) => sample.type === "phase" && sample.phase === phase);
    const cycles = phase === "module-initialized" || phase === "prep-complete" ? [phase === "module-initialized" ? 0 : 1] : [1, 2];
    for (const cycle of cycles) if (!matching.some((sample) => sample.cycle === cycle)) violations.push({ reason: "missing-phase", phase, cycle });
    for (const sample of matching) {
      if (!sample.after || !sample.before) { violations.push({ reason: "invalid-phase-sample", phase }); continue; }
      if (policy && (!Number.isFinite(policy.phaseLimitsBytes[phase]) || sample.after.heapUsed > policy.phaseLimitsBytes[phase])) violations.push({ reason: "phase-budget-exceeded", phase, observed: sample.after.heapUsed, limit: policy.phaseLimitsBytes[phase] ?? null });
      if (policy && sample.after.heapUsed > policy.globalPostGcHeapBytes) violations.push({ reason: "global-live-budget-exceeded", phase });
    }
  }
  return violations;
}
export function runResourceChild(root: string, entry: string, protocol: Record<string, string>, flags: string[], directory: string, name: string, deadline = Date.now() + RESOURCE_MEASUREMENT_DEADLINE_MS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: null, signal: null, error: "overall-resource-measurement-deadline-exceeded", reasons: [{ reason: "wall-timeout" }] };
  const offlinePreload = new URL("../../../scripts/lib/v9-resource-offline.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", offlinePreload, ...flags, entry], { cwd: root, env: resourceChildEnvironment(protocol), encoding: "utf8", timeout: Math.min(300_000, remaining), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(resolve(directory, `${name}.stderr`), result.stderr ?? "");
  writeFileSync(resolve(directory, `${name}.stdout`), result.stdout ?? "");
  const reasons: ResourceViolation[] = [];
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") reasons.push({ reason: "wall-timeout" });
  else if (result.signal || /heap out of memory|Reached heap limit|Allocation failed/i.test(result.stderr ?? "")) reasons.push({ reason: "child-oom-or-signal", signal: result.signal });
  else if (result.status !== 0) reasons.push({ reason: "child-failed", status: result.status });
  return { status: result.status, signal: result.signal, error: result.error?.message ?? null, reasons };
}

export async function measureV9Resource(root: string, profile: ResourceProfile, runs: number, manifest: PhaseManifest, options: { directory?: string; policyPath?: string; invocationId?: string; allowUnqualifiedPolicy?: boolean; deadlineMs?: number } = {}) {
  const deadlineMs = Math.min(options.deadlineMs ?? RESOURCE_MEASUREMENT_DEADLINE_MS, 360_000);
  const deadline = Date.now() + deadlineMs;
  const directory = options.directory ?? resolve(root, ".tmp/safety-score-v9-resource");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const report: ResourceReport = { schemaVersion: 1, invocationId: options.invocationId ?? randomUUID(), generatedAt: new Date().toISOString(), harnessRevision: RESOURCE_HARNESS_REVISION, phaseManifest: manifest, profile, diagnosticOnly: !options.policyPath, node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, fixtureProductionGap: "Synthetic inputs and evidence density are not production-size replay; measured card-unit and streamed-total bytes and Node heap limits do not establish Workers isolate capacity.", runs: [], violations: [] };
  report.policy = options.policyPath ? "unqualified" : "diagnostic";
  report.declaredPhases = PHASE_MANIFESTS[manifest];
  report.complete = false;
  report.deadlineMs = deadlineMs;
  const flush = () => writeFileSync(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  flush();
  async function buildBeforeDeadline(mode: "setup" | "live" | "hard-cap") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ResourceWallTimeout();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        buildResourceProbe(root, directory, mode),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ResourceWallTimeout()), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function child(entry: string, protocol: Record<string, string>, flags: string[], name: string) {
    report.activeChild = name;
    flush();
    const result = runResourceChild(root, entry, protocol, flags, directory, name, deadline);
    report.lastChild = { name, ...result };
    delete report.activeChild;
    flush();
    if (result.reasons.some((violation) => violation.reason === "wall-timeout")) throw new ResourceWallTimeout();
    return result;
  }
  report.testedSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL" }).stdout?.trim() || null;
  report.sourceHashes = Object.fromEntries([
    "package-lock.json", "worker/src/lib/__tests__/fixtures/safety-score-v9-full-registry-input.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-env.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-probe.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-fixture.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-budget.test-support.ts",
    "worker/scripts/lib/v9-resource-policy.ts",
    "shared/lib/safety-score-v9-resource-bytes.ts",
    "shared/lib/safety-score-v9-publication-limits.ts",
    "worker/scripts/lib/v9-resource-offline.mjs",
    "shared/test-utils/v9-resource-offline.ts",
  ].map((file) => {
    try { return [file, createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex")]; }
    catch { return [file, null]; }
  }));
  try {
    const setup = await buildBeforeDeadline("setup");
    const live = await buildBeforeDeadline("live");
    const hardCap = await buildBeforeDeadline("hard-cap");
    report.bundle = { esbuildVersion: live.esbuildVersion, wranglerVersion: live.wranglerVersion, settings: live.settings, liveSha256: live.sha256, hardCapSha256: hardCap.sha256 };
    const fixturePath = resolve(directory, "fixture.sqlite");
    const fixtureManifest = resolve(directory, "fixture.json");
    const preparation = child(setup.outfile, { PHAROS_RESOURCE_DATABASE: fixturePath, PHAROS_RESOURCE_MANIFEST: fixtureManifest, PHAROS_RESOURCE_ACTION: "setup" }, ["--max-old-space-size=512"], "setup");
    if (preparation.reasons.length) throw new Error(`fixture-preparation-failed:${JSON.stringify(preparation)}`);
    report.fixture = JSON.parse(readFileSync(fixtureManifest, "utf8"));
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const identity: ResourceIdentity = {
      harnessRevision: RESOURCE_HARNESS_REVISION, phaseManifest: manifest,
      node: process.version, v8: process.versions.v8, esbuild: live.esbuildVersion, wrangler: live.wranglerVersion,
      platform: process.platform, arch: process.arch,
      runner: process.env.GITHUB_ACTIONS === "true"
        ? { kind: "github", description: process.env.RUNNER_OS ?? "unknown", image: process.env.ImageOS ?? "unknown", version: process.env.ImageVersion ?? "unknown" }
        : { kind: "local", description: `${hostname()} ${process.platform} ${process.arch}`, image: process.platform, version: release() },
      fixture: { kind: "current-full-registry-native", sourceSha256: hash(readFileSync(resolve(root, "worker/src/lib/__tests__/fixtures/safety-score-v9-full-registry-input.ts"))), manifestSha256: hash(readFileSync(fixtureManifest)) },
      protocolSha256: hash(JSON.stringify({ settings: live.settings, hashes: report.sourceHashes })),
      configSha256: live.settings.configSha256,
    };
    report.identity = identity;
    let policy: ResourcePolicy | undefined;
    if (options.policyPath) {
      try {
        policy = loadResourcePolicy(options.policyPath, identity, options.allowUnqualifiedPolicy) ?? undefined;
        if (policy) {
          report.appliedPolicy = policy;
          report.policy = "qualified";
        } else {
          report.policy = "unqualified";
          report.policyQualification = "No qualified checked-in policy. All phases/correctness/bytes and natural 128 MiB remain required; phase limits are not enforced. Further remediation is required before five-run <=110 MiB qualification.";
        }
      } catch (error) {
        report.policy = "invalid";
        report.violations.push({ reason: "invalid-resource-policy", detail: String(error) });
      }
    }
    for (let run = 1; run <= runs; run += 1) {
      const entry: RunResult = { run, violations: [] };
      report.runs.push(entry);
      for (const [mode, build, flags] of [["live", live, ["--max-old-space-size=256", "--expose-gc"]], ["hard-cap", hardCap, ["--max-old-space-size=128"]]] as const) {
        const database = resolve(directory, `${mode}-${run}.sqlite`);
        const output = resolve(directory, `${mode}-${run}.ndjson`);
        copyFileSync(fixturePath, database);
        writeFileSync(output, "");
        const result = child(build.outfile, { PHAROS_RESOURCE_DATABASE: database, PHAROS_RESOURCE_OUTPUT: output, PHAROS_RESOURCE_PROFILE: profile }, [...flags], `${mode}-${run}`);
        let samples: ResourceSample[] = [];
        try { samples = readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => SampleSchema.parse(JSON.parse(line))); }
        catch (error) { result.reasons.push({ reason: "protocol-fault", detail: String(error) }); }
        if (mode === "live") result.reasons.push(...validateResourceSamples(samples, [...PHASE_MANIFESTS[manifest], ...(profile === "heavy-warm" ? ["prep-complete"] : [])], policy));
        if (!samples.some((sample) => sample.type === "complete")) result.reasons.push({ reason: "missing-completion" });
        const phaseMaxima = Object.fromEntries(PHASE_MANIFESTS[manifest].map((phase) => {
          const values = samples.filter((sample) => sample.type === "phase" && sample.phase === phase);
          return [phase, values.length ? { samples: values.length, postGcHeapBytes: Math.max(...values.map((sample) => sample.after!.heapUsed)), beforeGcHeapBytes: Math.max(...values.map((sample) => sample.before!.heapUsed)) } : null];
        }));
        entry[mode] = { ...result, phaseMaxima, cycles: samples.filter((sample) => sample.type === "cycle-result"), archives: samples.find((sample) => sample.type === "complete")?.archives ?? null };
        entry.violations.push(...result.reasons.map((reason) => ({ ...reason, mode })));
        flush();
        if (result.status === 0) {
          const check = child(setup.outfile, { PHAROS_RESOURCE_DATABASE: database, PHAROS_RESOURCE_MANIFEST: fixtureManifest, PHAROS_RESOURCE_ACTION: "inspect" }, ["--max-old-space-size=512"], `${mode}-${run}-correctness`);
          if (!check.reasons.length) {
            try {
              const lines = readFileSync(resolve(directory, `${mode}-${run}-correctness.stdout`), "utf8").trim().split("\n");
              const correctness = JSON.parse(lines[lines.length - 1]);
              (entry[mode] as ModeResult & { correctness?: unknown }).correctness = correctness;
            } catch (error) { entry.violations.push({ reason: "correctness-protocol-fault", mode, detail: String(error) }); }
          }
          if (check.reasons.length) entry.violations.push({ reason: "correctness-failed", mode, ...check });
        }
      }
      const liveCycles = entry.live!.cycles.map((cycle) => cycle.metadata?.publication?.publicationGenerationId);
      const naturalCycles = entry["hard-cap"]!.cycles.map((cycle) => cycle.metadata?.publication?.publicationGenerationId);
      if (entry["hard-cap"]!.status === 0 && JSON.stringify(liveCycles) !== JSON.stringify(naturalCycles)) entry.violations.push({ reason: "output-identity-mismatch" });
      report.violations.push(...entry.violations.map((violation: ResourceViolation) => ({ run, ...violation })));
      flush();
    }
  } catch (error) {
    report.violations.push({ reason: error instanceof ResourceWallTimeout ? "wall-timeout" : "harness-error", detail: error instanceof Error ? error.stack : String(error) });
  } finally {
    report.complete = report.runs.length === runs && report.violations.length === 0;
    flush();
  }
  return report;
}
