import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { DependencyScenarioArtifactSchema, DEPENDENCY_SCENARIOS_CACHE_PREFIX, type DependencyScenarioArtifact } from "@shared/types/dependency-scenarios";
import { ReportCardsV9CurrentResponseSchema, buildReportCardsV9DependencyGraph } from "@shared/types/report-cards-v9";
import { buildDirectHubExposures } from "@shared/lib/dependency-exposure";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { evaluateV9ContagionScenario } from "@shared/lib/safety-score-v9/contagion";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import type { ContagionShock } from "@shared/types/contagion";
import { buildSafetyScoreV9ReplayArtifact, parseSafetyScoreV9ReplayFixedInput } from "./replay-safety-score-v9";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";

const DEPENDENCY_SCENARIOS_RETAINED_ARTIFACT_COUNT = 24;

function verificationStamp(source: ReportCardsV9CurrentResponse, artifactBytes: string): string {
  const identity = source.safetyScoreIdentity;
  return createHash("sha256").update(stableJsonStringifyV1({
    publicationGenerationId: identity.publicationGenerationId,
    baseInputGenerationId: identity.baseInputGenerationId,
    evaluationBuildDigest: identity.evaluationBuildDigest,
    methodology: { version: source.methodology.version },
    artifactPayloadSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  })).digest("hex");
}

const USAGE = `Usage: node --expose-gc --import tsx worker/scripts/compute-dependency-scenarios.ts --mode <plan|compute|publish> --out-dir <path> [--input <capture.json>] [--publication <publication.json>]
Plan exports the production capture and accepted publication. Compute without --publication is a local replay only and cannot be published. Publish verifies immutable payload bytes before advancing the commit marker.`;
function remote(...args: string[]): string {
  const run = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", ...args], { cwd: resolve("worker"), encoding: "utf8", maxBuffer: 50_000_000 });
  if (run.status !== 0) throw new Error(`D1 command failed: ${run.stderr || run.stdout}`);
  return run.stdout;
}
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
function readRemote(key: string): string | null {
  const result = JSON.parse(remote("--command", `SELECT value FROM cache WHERE key = ${sqlString(key)}`));
  return result[0]?.results[0]?.value ?? null;
}
async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { mode: { type: "string" }, "out-dir": { type: "string" }, input: { type: "string" }, publication: { type: "string" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values["out-dir"] === "string", "--out-dir is required");
  assertCliUsage(["plan", "compute", "publish"].includes(values.mode as string), "--mode must be plan, compute or publish");
  const directory = resolve(values["out-dir"] as string);
  mkdirSync(directory, { recursive: true });
  const artifactPath = resolve(directory, "artifact.json");
  const sourcePath = resolve(directory, "publication.json");
  const stampPath = resolve(directory, "artifact.verified.sha256");
  // A new plan or an unverified/rejected compute must never reuse an old stamp.
  if (values.mode !== "publish") rmSync(stampPath, { force: true });
  if (values.mode === "plan") {
    const apiKey = process.env.PHAROS_API_KEY;
    if (!apiKey) throw new Error("PHAROS_API_KEY is required for accepted-publication capture");
    const response = await fetch("https://api.pharos.watch/api/report-cards/v9", { headers: { "X-API-Key": apiKey } });
    if (!response.ok) throw new Error(`Publication capture failed: ${response.status}`);
    const source = ReportCardsV9CurrentResponseSchema.parse(await response.json());
    writeFileSync(sourcePath, JSON.stringify(source));
    const raw = JSON.parse(remote("--command", "SELECT value FROM cache WHERE key = 'report-cards:fixed-input:exact'"));
    if (!raw[0]?.results[0]?.value) throw new Error("Exact compiler capture unavailable");
    const fixedInput = await parseSafetyScoreV9ReplayFixedInput(JSON.parse(raw[0].results[0].value));
    writeFileSync(resolve(directory, "capture.json"), JSON.stringify(fixedInput));
    console.log(JSON.stringify({ sourcePublicationGenerationId: source.safetyScoreIdentity.publicationGenerationId }));
    return;
  }
  if (values.mode === "publish") {
    const bytes = readFileSync(artifactPath, "utf8");
    const artifact = DependencyScenarioArtifactSchema.parse(JSON.parse(bytes));
    const source = ReportCardsV9CurrentResponseSchema.parse(JSON.parse(readFileSync(sourcePath, "utf8")));
    if (source.safetyScoreIdentity.publicationGenerationId !== artifact.sourcePublicationGenerationId) throw new Error("Publish source generation mismatch");
    if (source.safetyScoreIdentity.baseInputGenerationId !== artifact.sourceBaseInputGenerationId ||
        source.safetyScoreIdentity.evaluationBuildDigest !== artifact.evaluationBuildDigest ||
        source.methodology.version !== artifact.methodologyVersion) throw new Error("Publish source identity mismatch");
    if (!existsSync(stampPath)) throw new Error("Accepted-publication verification stamp missing");
    if (readFileSync(stampPath, "utf8").trim() !== verificationStamp(source, bytes)) throw new Error("Accepted-publication verification stamp mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:${digest}`;
    const writeRow = (rowKey: string, value: string) => {
      const sqlPath = resolve(directory, "publish.sql");
      writeFileSync(sqlPath, `INSERT INTO cache (key,value,updated_at) VALUES (${sqlString(rowKey)},${sqlString(value)},${artifact.computedAtSec}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`);
      remote("--file", sqlPath);
      if (readRemote(rowKey) !== value) throw new Error(`Readback mismatch for ${rowKey}`);
    };
    // Immutable content first. An unsuccessful readback never advances latest.
    writeRow(key, bytes);
    writeRow(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`, key);
    // Prune only after the new marker's successful readback. The marker lookup
    // stays inside this statement so a changed marker can never lose its row.
    try {
      const artifactKeys = sqlString(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:*`);
      const markerKey = sqlString(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`);
      remote("--command", `DELETE FROM cache WHERE key GLOB ${artifactKeys} AND key <> (SELECT value FROM cache WHERE key = ${markerKey}) AND key NOT IN (SELECT key FROM cache WHERE key GLOB ${artifactKeys} ORDER BY updated_at DESC, key DESC LIMIT ${DEPENDENCY_SCENARIOS_RETAINED_ARTIFACT_COUNT})`);
    } catch (error) {
      console.warn(`Dependency scenario artifact pruning failed; publication remains committed: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(JSON.stringify({ published: key, bytes: Buffer.byteLength(bytes) }));
    return;
  }
  assertCliUsage(typeof values.input === "string", "--input is required for compute");
  const start = performance.now(), cpu = process.cpuUsage();
  const capture = JSON.parse(readFileSync(resolve(values.input as string), "utf8"));
  const fixedInput = await parseSafetyScoreV9ReplayFixedInput(capture.fixedInput ?? capture, capture.registrySnapshot);
  const source = values.publication ? ReportCardsV9CurrentResponseSchema.parse(JSON.parse(readFileSync(resolve(values.publication as string), "utf8"))) : null;
  let replay = buildSafetyScoreV9ReplayArtifact({ fixedInput, ...(capture.registrySnapshot ? { registrySnapshot: capture.registrySnapshot } : {}), publishedAtSec: source?.updatedAt ?? fixedInput.clockSec });
  const candidate = replay.pipeline.candidate;
  if (source) {
    const identity = source.safetyScoreIdentity;
    if (candidate.publicationGenerationId !== identity.publicationGenerationId || candidate.baseInputGenerationId !== identity.baseInputGenerationId || candidate.evaluationBuildDigest !== identity.evaluationBuildDigest) throw new Error("Capture replay does not match accepted publication identity");
    for (const card of source.cards) {
      const baseline = candidate.cards.find(row => row.id === card.id);
      if (!baseline || baseline.score !== card.score || baseline.grade !== card.grade) throw new Error(`Published baseline mismatch: ${card.id}`);
    }
    writeFileSync(sourcePath, JSON.stringify(source));
  }
  const cards = candidate.cards;
  const byId = new Map(cards.map(card => [card.id, card]));
  const edges = source?.dependencyGraph.edges ?? buildReportCardsV9DependencyGraph(cards).edges;
  const hubs = buildDirectHubExposures(edges, id => {
    const supply = byId.get(id)?.supply;
    return supply?.circulatingUsdAtEvaluation === null || supply?.circulatingUsdAtEvaluation === undefined ? null : { usd: supply.circulatingUsdAtEvaluation, asOf: supply.asOfSec, basis: "publication-circulating" };
  }, { sharedBooks: { bookIdOf: id => byId.get(id)?.sharedBookId ?? null, measuredHoldingUsd: () => null }, familyOf: () => null, wrapperFormOf: () => "unknown" }).slice(0, 15);
  const { v9FactSetDigest: _digest, ...rawCompileInput } = replay.pipeline.compiledFacts;
  replay = null as unknown as typeof replay;
  const policy = loadV9CandidateMethodologyPolicy(fixedInput.clockSec);
  const scenarios: DependencyScenarioArtifact["scenarios"] = [];
  for (const { hubId: rootId } of hubs) {
    const shocks: ContagionShock[] = [
      { kind: "score-limit", assetId: rootId, dimension: "final", limit: 40 },
      { kind: "depeg", assetId: rootId, activeDepegBps: 1000, template: "one-day-history-and-exit-held" },
      { kind: "mint-control-compromise", assetId: rootId },
    ];
    for (const shock of shocks) {
      globalThis.gc?.();
      const id = `${rootId}:${shock.kind}`;
      const result = evaluateV9ContagionScenario({ rawCompileInput, policy, clock: fixedInput.clockSec, publicationGenerationId: candidate.publicationGenerationId }, { id, shocks: [shock] });
      const assumptions = shock.kind === "score-limit" ? ["Root downstream-consumed final projection is limited to 40; its published headline score is not overwritten."] : shock.kind === "depeg" ? ["Active depeg of 1,000 bps for one day; captured historical peg performance and exit facts are held fixed."] : ["Root mint authority is compromised; missing mint control is modeled as global unbounded EOA minting with zero delay."];
      scenarios.push({ id, rootId, shock, assumptions, results: result.rows.filter(row => row.coinId === rootId || row.changedDimensions.length > 0).map(row => ({
        assetId: row.coinId, publishedScore: row.baselineScore, publishedGrade: row.baselineGrade as DependencyScenarioArtifact["scenarios"][number]["results"][number]["publishedGrade"],
        modeledScore: row.scenarioScore, modeledGrade: row.scenarioGrade as DependencyScenarioArtifact["scenarios"][number]["results"][number]["modeledGrade"], deltaScore: row.delta, minHop: row.shortestHop,
        roles: [...new Set((byId.get(row.coinId)?.dependencies.roles ?? []).map(role => role.role))].sort(),
      })), failures: result.rows.filter(row => row.failure !== null).map(row => ({ assetId: row.coinId, code: row.failure! })) });
    }
  }
  const artifact = DependencyScenarioArtifactSchema.parse({ schemaVersion: 1, sourcePublicationGenerationId: candidate.publicationGenerationId, sourceBaseInputGenerationId: candidate.baseInputGenerationId, methodologyVersion: source?.methodology.version ?? candidate.policyVersion, evaluationBuildDigest: candidate.evaluationBuildDigest, computedAtSec: Math.floor(Date.now() / 1000), cohort: { rootIds: hubs.map(hub => hub.hubId), selection: "Top 15 hubs by A1 direct exposure USD using source-publication supply and published dependencies; shared books counted once. Unknown supply or shares excluded, not zero." }, scenarios });
  const bytes = JSON.stringify(artifact);
  writeFileSync(artifactPath, bytes);
  if (source) writeFileSync(stampPath, `${verificationStamp(source, bytes)}\n`);
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, bytes: Buffer.byteLength(bytes), roots: hubs.length, scenarios: scenarios.length, rows: scenarios.reduce((sum, row) => sum + row.results.length, 0), failures: scenarios.reduce((sum, row) => sum + row.failures.length, 0), acceptedPublicationVerified: source !== null }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void runCliEntrypoint(main, { label: "dependency-scenarios", usage: USAGE });
