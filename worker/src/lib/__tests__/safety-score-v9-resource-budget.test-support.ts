import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import type * as Esbuild from "esbuild";
import type { BuildOptions, Plugin } from "esbuild";
import { parseAssignments, unquote } from "../../../../scripts/lib/wrangler-toml.mjs";

export type ResourceProfile = "compute" | "heavy-warm";
export type PhaseManifest = "pre-p2" | "post-p2";
export const RESOURCE_HARNESS_REVISION = "full-path-v1";
const COMMON_PHASES = ["module-initialized", "native-envelope-loaded", "native-inflate-decoded", "native-input-decoded", "enrichment-loaded", "extension-built", "facts-compiled", "evaluation-complete", "candidate-finalized", "gate-assessed", "replay-serialized", "store-admitted", "publication-gzip-complete", "score-index-serialized", "publication-committed", "alert-envelope-projected", "journal-complete", "archive-string-built", "archive-upload-pending", "publication-settled"];
export const PHASE_MANIFESTS = {
  "pre-p2": [...COMMON_PHASES, "accepted-text-decoded", "accepted-json-parsed", "accepted-admitted", "accepted-baseline-ready"],
  "post-p2": [...COMMON_PHASES, "accepted-baseline-row-loaded", "accepted-baseline-parsed", "accepted-baseline-ready"],
};
export function resourceChildEnvironment(protocol: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+)$/.test(key)) env[key] = value;
  }
  return { ...env, ...protocol };
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
  { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: "parseSafetyScoreV9Publication", phase: "accepted-text-decoded", kind: "assignment", name: "canonical" },
  { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: "parseSafetyScoreV9Publication", phase: "accepted-json-parsed", kind: "variable", name: "payload" },
  { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: "parseSafetyScoreV9Publication", phase: "accepted-admitted", kind: "variable", name: "publication" },
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

function instrumentation(root: string, manifest: PhaseManifest): Plugin {
  const sites = SITES.filter((site) => manifest === "pre-p2" || !site.phase.startsWith("accepted-") || site.phase === "accepted-baseline-ready");
  const codec = readFileSync(resolve(root, "worker/src/lib/safety-score-v9/publication-codec.ts"), "utf8");
  const admissionFunction = codec.includes("export async function admitAndSerializeSafetyScoreV9Publication(")
    ? "admitAndSerializeSafetyScoreV9Publication" : "serializeSafetyScoreV9Publication";
  sites.push(
    { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: admissionFunction, phase: "store-admitted", kind: "variable", name: "publication" },
    { file: "worker/src/lib/safety-score-v9/publication-codec.ts", fn: admissionFunction, phase: "publication-gzip-complete", kind: "variable", name: "compressed" },
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
export async function buildResourceProbe(root: string, directory: string, mode: "live" | "hard-cap" | "setup", manifest: PhaseManifest) {
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
    plugins: mode === "live" ? [instrumentation(root, manifest)] : [],
  } as BuildOptions);
  const metafile = result.metafile!;
  const loader = relative(root, settings.alias["#pharos-full-catalog"]);
  if (!metafile.inputs[loader] || !Object.values(metafile.inputs).some((input) => input.imports.some((edge) => edge.original === "#pharos-full-catalog" && edge.path === loader))) throw new Error("catalog-alias-not-packed-worker-loader");
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
type ResourceReport = Record<string, unknown> & { complete?: boolean; runs: RunResult[]; violations: ResourceViolation[] };
export function validateResourceSamples(samples: ResourceSample[], phases: readonly string[], policy?: { phaseLimitsBytes: Record<string, number>; globalPostGcHeapBytes: number }): ResourceViolation[] {
  const violations: ResourceViolation[] = [];
  for (const phase of phases) {
    const matching = samples.filter((sample) => sample.type === "phase" && sample.phase === phase);
    const cycles = phase === "module-initialized" || phase === "prep-complete" ? [phase === "module-initialized" ? 0 : 1] : [1, 2];
    for (const cycle of cycles) if (!matching.some((sample) => sample.cycle === cycle)) violations.push({ reason: "missing-phase", phase, cycle });
    for (const sample of matching) {
      if (!sample.after || !sample.before) { violations.push({ reason: "invalid-phase-sample", phase }); continue; }
      if (policy && sample.after.heapUsed > policy.phaseLimitsBytes[phase]) violations.push({ reason: "phase-budget-exceeded", phase, observed: sample.after.heapUsed, limit: policy.phaseLimitsBytes[phase] });
      if (policy && sample.after.heapUsed > policy.globalPostGcHeapBytes) violations.push({ reason: "global-live-budget-exceeded", phase });
    }
  }
  return violations;
}
export function runResourceChild(root: string, entry: string, protocol: Record<string, string>, flags: string[], directory: string, name: string) {
  const result = spawnSync(process.execPath, [...flags, entry], { cwd: root, env: resourceChildEnvironment(protocol), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(resolve(directory, `${name}.stderr`), result.stderr ?? "");
  writeFileSync(resolve(directory, `${name}.stdout`), result.stdout ?? "");
  const reasons: ResourceViolation[] = [];
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") reasons.push({ reason: "wall-timeout" });
  else if (result.signal || /heap out of memory|Reached heap limit|Allocation failed/i.test(result.stderr ?? "")) reasons.push({ reason: "child-oom-or-signal", signal: result.signal });
  else if (result.status !== 0) reasons.push({ reason: "child-failed", status: result.status });
  return { status: result.status, signal: result.signal, error: result.error?.message ?? null, reasons };
}

export async function measureV9Resource(root: string, profile: ResourceProfile, runs: number, manifest: PhaseManifest) {
  const directory = resolve(root, ".tmp/safety-score-v9-resource");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const report: ResourceReport = { schemaVersion: 1, harnessRevision: RESOURCE_HARNESS_REVISION, phaseManifest: manifest, profile, diagnosticOnly: true, node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, productionRawPublicationBytesApprox: 8_000_000, fixtureProductionGap: "Synthetic fixture under-represents production; measured raw bytes and the approximate 8.0 MB production size are not capacity evidence.", runs: [], violations: [] };
  report.testedSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || null;
  report.sourceHashes = Object.fromEntries([
    "package-lock.json", "worker/src/lib/__tests__/fixtures/safety-score-v9-full-registry-input.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-probe.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-fixture.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-budget.test-support.ts",
  ].map((file) => {
    try { return [file, createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex")]; }
    catch { return [file, null]; }
  }));
  try {
    const setup = await buildResourceProbe(root, directory, "setup", manifest);
    const live = await buildResourceProbe(root, directory, "live", manifest);
    const hardCap = await buildResourceProbe(root, directory, "hard-cap", manifest);
    report.bundle = { esbuildVersion: live.esbuildVersion, wranglerVersion: live.wranglerVersion, settings: live.settings, liveSha256: live.sha256, hardCapSha256: hardCap.sha256 };
    const fixturePath = resolve(directory, "fixture.sqlite");
    const fixtureManifest = resolve(directory, "fixture.json");
    const preparation = runResourceChild(root, setup.outfile, { PHAROS_RESOURCE_DATABASE: fixturePath, PHAROS_RESOURCE_MANIFEST: fixtureManifest, PHAROS_RESOURCE_ACTION: "setup" }, ["--max-old-space-size=512"], directory, "setup");
    if (preparation.reasons.length) throw new Error(`fixture-preparation-failed:${JSON.stringify(preparation)}`);
    report.fixture = JSON.parse(readFileSync(fixtureManifest, "utf8"));
    for (let run = 1; run <= runs; run += 1) {
      const entry: RunResult = { run, violations: [] };
      report.runs.push(entry);
      for (const [mode, build, flags] of [["live", live, ["--max-old-space-size=256", "--expose-gc"]], ["hard-cap", hardCap, ["--max-old-space-size=128"]]] as const) {
        const database = resolve(directory, `${mode}-${run}.sqlite`);
        const output = resolve(directory, `${mode}-${run}.ndjson`);
        copyFileSync(fixturePath, database);
        writeFileSync(output, "");
        const result = runResourceChild(root, build.outfile, { PHAROS_RESOURCE_DATABASE: database, PHAROS_RESOURCE_OUTPUT: output, PHAROS_RESOURCE_PROFILE: profile }, [...flags], directory, `${mode}-${run}`);
        let samples: ResourceSample[] = [];
        try { samples = readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => SampleSchema.parse(JSON.parse(line))); }
        catch (error) { result.reasons.push({ reason: "protocol-fault", detail: String(error) }); }
        if (mode === "live") result.reasons.push(...validateResourceSamples(samples, [...PHASE_MANIFESTS[manifest], ...(profile === "heavy-warm" ? ["prep-complete"] : [])]));
        if (!samples.some((sample) => sample.type === "complete")) result.reasons.push({ reason: "missing-completion" });
        const phaseMaxima = Object.fromEntries(PHASE_MANIFESTS[manifest].map((phase) => {
          const values = samples.filter((sample) => sample.type === "phase" && sample.phase === phase);
          return [phase, values.length ? { samples: values.length, postGcHeapBytes: Math.max(...values.map((sample) => sample.after!.heapUsed)), beforeGcHeapBytes: Math.max(...values.map((sample) => sample.before!.heapUsed)) } : null];
        }));
        entry[mode] = { ...result, phaseMaxima, cycles: samples.filter((sample) => sample.type === "cycle-result"), archives: samples.find((sample) => sample.type === "complete")?.archives ?? null };
        entry.violations.push(...result.reasons.map((reason) => ({ ...reason, mode })));
        if (result.status === 0) {
          const check = runResourceChild(root, setup.outfile, { PHAROS_RESOURCE_DATABASE: database, PHAROS_RESOURCE_MANIFEST: fixtureManifest, PHAROS_RESOURCE_ACTION: "inspect" }, ["--max-old-space-size=512"], directory, `${mode}-${run}-correctness`);
          if (check.reasons.length) entry.violations.push({ reason: "correctness-failed", mode, ...check });
        }
      }
      const liveCycles = entry.live!.cycles.map((cycle) => cycle.metadata?.publication?.publicationGenerationId);
      const naturalCycles = entry["hard-cap"]!.cycles.map((cycle) => cycle.metadata?.publication?.publicationGenerationId);
      if (entry["hard-cap"]!.status === 0 && JSON.stringify(liveCycles) !== JSON.stringify(naturalCycles)) entry.violations.push({ reason: "output-identity-mismatch" });
      report.violations.push(...entry.violations.map((violation: ResourceViolation) => ({ run, ...violation })));
    }
  } catch (error) {
    report.violations.push({ reason: "harness-error", detail: error instanceof Error ? error.stack : String(error) });
  } finally {
    report.complete = report.runs.length === runs && report.violations.length === 0;
    writeFileSync(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
