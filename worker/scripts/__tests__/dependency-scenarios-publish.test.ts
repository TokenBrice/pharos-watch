import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { makeReportCardsV9Response } from "../../src/test-helpers/report-cards-v9";
import { DEPENDENCY_SCENARIOS_CACHE_PREFIX } from "@shared/types/dependency-scenarios";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildSafetyScoreV9ReplayArtifact } from "../replay-safety-score-v9";
import { createReplayFixedInput } from "./safety-score-v9-replay.test-support";
import { projectSafetyScoreV9PublicationToPublicSnapshot } from "../../src/lib/safety-score-v9/report-cards-v9-cache";
import { buildSafetyScoreV9PublicationReplayCapture, parseSafetyScoreV9PublicationReplayCapture } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { buildFixedInputCacheEntry } from "../../src/lib/safety-score-v9/report-cards-fixed-input-cache-codec";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, serializeSafetyScoreV9Publication } from "../../src/lib/safety-score-v9/publication-codec";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../src/lib/safety-score-v9/publication-health";
import { makeV9FixedInput, makeXautObservation } from "../../src/test-helpers/v9-fixed-input";
import { normalizeFixedInput } from "../../src/lib/safety-score-v9/report-cards-fixed-input";
import { deriveXautRepresentationGroupSupplyAttribution } from "../../src/lib/safety-score-v9/xaut-supply-attribution-contract";
import { buildReportCardsFixedInputCacheEntry } from "../../src/test-helpers/report-cards-fixed-input";
import { DEPENDENCY_SCENARIO_CHUNK_BYTES, DEPENDENCY_SCENARIO_CHUNK_STORAGE_FORMAT, DEPENDENCY_SCENARIO_READER_CAPABILITY_HEADER, DEPENDENCY_SCENARIO_READER_VERSION_HEADER } from "@shared/types/dependency-scenario-storage";
import { reassembleDependencyScenarioPayload } from "@shared/lib/dependency-scenario-storage";
import { applySafetyScoreV9GradeHysteresis } from "@shared/lib/safety-score-v9/grade-hysteresis";
import { scoreToGrade } from "@shared/types/safety-score-v9-grade";
import { sha256Hex } from "@shared/lib/sha256";
import { buildSafetyScoreV9AcceptedPublicationBaseline, type SafetyScoreV9AcceptedPublicationBaseline } from "../../src/lib/safety-score-v9/publication-assessment";
import { verifyAcceptedPublicationCards, main } from "../compute-dependency-scenarios";
import { runSafetyScoreV9ReplayCli } from "../replay-safety-score-v9";
import { runReportCardsFixedInputCaptureCli } from "../capture-report-cards-fixed-input";
import { localRegistrySnapshot, registrySnapshotFingerprint } from "../lib/safety-score-v9-registry";
import { loadReviewedLaneEmitterCatalog } from "../../src/lib/safety-score-v9/lane-emitter-catalog";
import { buildSafetyScoreV9ReplayLaneScreening } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { V9LaneIncidentCertificateSchema } from "@shared/types/safety-score-v9-incidents";

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
const markerKey = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`;
const artifactPrefix = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:`;
const readerVersion = "12345678-1234-4234-8234-123456789abc";

// This Wrangler executable runs the publisher's actual SQL against SQLite,
// rather than returning mock echoes, and exposes readback/failure boundaries.
const WRANGLER_SIMULATOR = `#!/usr/bin/env node
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const sql = args.includes('--file') ? fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8') : args[args.indexOf('--command') + 1];
const db = new DatabaseSync(process.env.SCENARIO_TEST_DB);
const event = sql.includes('worker-active-version:public') ? 'read-capability' : sql.includes('dependency_scenario_payload_chunks') ? (sql.startsWith('INSERT') ? 'write-chunk' : sql.startsWith('DELETE') ? 'prune-chunks' : 'read-chunks') : sql.includes(':writing:') ? (sql.startsWith('INSERT') ? 'write-writing' : sql.startsWith('DELETE') ? sql.includes(' GLOB ') ? 'prune-writing' : 'clear-writing' : 'read-writing') : sql.startsWith('INSERT') ? (sql.includes(':latest') ? 'write-marker' : 'write-artifact') : sql.startsWith('DELETE') ? 'prune' : sql.includes(':latest') ? 'read-marker' : 'read-artifact';
if (sql.startsWith('INSERT') && Buffer.byteLength(sql) >= 100000) {
 console.error('D1 statement size exceeded'); process.exit(1);
}
fs.appendFileSync(process.env.SCENARIO_TEST_EVENTS, JSON.stringify(event) + '\\n');
if (event === 'prune' && process.env.SCENARIO_TEST_FAIL_PRUNE === '1') {
 console.error('simulated-prune-outage'); process.exit(1);
}
if (event === 'prune' && process.env.SCENARIO_TEST_MOVE_MARKER) {
 db.prepare('UPDATE cache SET value = ? WHERE key = ?').run(process.env.SCENARIO_TEST_MOVE_MARKER, process.env.SCENARIO_TEST_MARKER_KEY);
}
if (sql.startsWith('SELECT')) {
 let results = db.prepare(sql).all();
 if (event === 'read-artifact' && process.env.SCENARIO_TEST_BAD_READBACK === '1') results = [{value:'corrupt-readback'}];
 if (event === 'read-chunks' && process.env.SCENARIO_TEST_BAD_CHUNKS === 'missing') results.pop();
 if (event === 'read-chunks' && process.env.SCENARIO_TEST_BAD_CHUNKS === 'hash') results[0].sha256 = '0'.repeat(64);
 if (event === 'read-chunks' && process.env.SCENARIO_TEST_BAD_CHUNKS === 'whole-hash') {
  results[0].value = results[0].value.replace('Publisher', 'Corrupted');
  results[0].sha256 = require('node:crypto').createHash('sha256').update(results[0].value).digest('hex');
 }
 console.log(JSON.stringify([{results,success:true}]));
} else {
 db.exec(sql); console.log(JSON.stringify([{results:[],success:true}]));
}
db.close();
`;
type ScenarioEnv = Partial<Record<"SCENARIO_TEST_FAIL_PRUNE" | "SCENARIO_TEST_MOVE_MARKER" | "SCENARIO_TEST_BAD_READBACK" | "SCENARIO_TEST_BAD_CHUNKS" | "SCENARIO_TEST_READER", string>>;
function scenarioEvent(sql: string): string {
  return sql.includes("worker-active-version:public") ? "read-capability"
    : sql.includes("dependency_scenario_payload_chunks") ? (sql.startsWith("INSERT") ? "write-chunk" : sql.startsWith("DELETE") ? "prune-chunks" : "read-chunks")
    : sql.includes(":writing:") ? (sql.startsWith("INSERT") ? "write-writing" : sql.startsWith("DELETE") ? (sql.includes(" GLOB ") ? "prune-writing" : "clear-writing") : "read-writing")
    : sql.startsWith("INSERT") ? (sql.includes(":latest") ? "write-marker" : "write-artifact")
    : sql.startsWith("DELETE") ? "prune"
    : sql.includes(":latest") ? "read-marker" : "read-artifact";
}
/**
 * Runs the publish/compute CLI in-process against the same SQLite fixture the
 * stdout/stderr/exit-code contract keeps exercising through `invokeSpawn`.
 */
function createInProcessHarness(directory: string, databasePath: string) {
  const eventsPath = resolve(directory, "events.jsonl");
  const run = async (args: string[], env: ScenarioEnv = {}) => {
    const stdout: string[] = [], stderr: string[] = [];
    let clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    const remote = (...remoteArgs: string[]): string => {
      const sql = remoteArgs.includes("--file")
        ? readFileSync(remoteArgs[remoteArgs.indexOf("--file") + 1]!, "utf8")
        : remoteArgs[remoteArgs.indexOf("--command") + 1]!;
      const db = new DatabaseSync(databasePath);
      try {
        const event = scenarioEvent(sql);
        if (sql.startsWith("INSERT") && Buffer.byteLength(sql) >= 100_000) throw new Error("D1 command failed: D1 statement size exceeded");
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
        if (event === "prune" && env.SCENARIO_TEST_FAIL_PRUNE === "1") throw new Error("D1 command failed: simulated-prune-outage");
        if (event === "prune" && env.SCENARIO_TEST_MOVE_MARKER) db.prepare("UPDATE cache SET value = ? WHERE key = ?").run(env.SCENARIO_TEST_MOVE_MARKER, markerKey);
        if (sql.startsWith("SELECT")) {
          let results = db.prepare(sql).all();
          if (event === "read-artifact" && env.SCENARIO_TEST_BAD_READBACK === "1") results = [{ value: "corrupt-readback" }];
          if (event === "read-chunks" && env.SCENARIO_TEST_BAD_CHUNKS === "missing") results.pop();
          if (event === "read-chunks" && env.SCENARIO_TEST_BAD_CHUNKS === "hash") results[0]!.sha256 = "0".repeat(64);
          if (event === "read-chunks" && env.SCENARIO_TEST_BAD_CHUNKS === "whole-hash") {
            results[0]!.value = String(results[0]!.value).replace("Publisher", "Corrupted");
            results[0]!.sha256 = createHash("sha256").update(String(results[0]!.value)).digest("hex");
          }
          return JSON.stringify([{ results, success: true }]);
        }
        db.exec(sql);
        return JSON.stringify([{ results: [], success: true }]);
      } finally { db.close(); }
    };
    let probes = 0;
    vi.stubGlobal("fetch", async () => {
      probes++;
      appendFileSync(eventsPath, `${JSON.stringify("probe-reader")}\n`);
      const mode = env.SCENARIO_TEST_READER ?? "capable";
      if (mode === "network") throw new Error("simulated-reader-unavailable");
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      if (mode !== "missing-capability" && !(mode === "rollback" && probes > 1)) headers[DEPENDENCY_SCENARIO_READER_CAPABILITY_HEADER] = DEPENDENCY_SCENARIO_CHUNK_STORAGE_FORMAT;
      if (mode !== "missing-version") headers[DEPENDENCY_SCENARIO_READER_VERSION_HEADER] = mode === "mismatched-version" ? "87654321-4321-4321-8321-cba987654321" : readerVersion;
      if (mode === "expired" && probes > 1) clockOffsetMs = 16 * 60_000;
      return new Response("reader-proof-body", { status: mode === "http-error" ? 503 : 200, headers });
    });
    const log = vi.spyOn(console, "log").mockImplementation((...values) => { stdout.push(values.map(String).join(" ")); });
    const warn = vi.spyOn(console, "warn").mockImplementation((...values) => { stderr.push(values.map(String).join(" ")); });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    try {
      await main(args, { remote });
      return { status: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 1, stdout: stdout.join("\n"), stderr: `${stderr.join("\n")}\n${message}`.trim() };
    } finally {
      log.mockRestore(); warn.mockRestore(); clock.mockRestore(); vi.unstubAllGlobals();
    }
  };
  return {
    run,
    invoke: (env: ScenarioEnv = {}) => run(["--mode", "publish", "--out-dir", directory], env),
  };
}
function setup(payloadSize?: number) {
  const directory = mkdtempSync(resolve(tmpdir(), "pharos-scenario-publish-"));
  temporaryDirectories.push(directory);
  const bin = resolve(directory, "bin");
  mkdirSync(bin);
  writeFileSync(resolve(bin, "npx"), WRANGLER_SIMULATOR);
  chmodSync(resolve(bin, "npx"), 0o755);
  const databasePath = resolve(directory, "cache.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec(readFileSync(resolve("worker/migrations/0264_dependency_scenario_chunks.sql"), "utf8"));
  for (let index = 0; index < 40; index++) {
    db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(`${artifactPrefix}old-${String(index).padStart(2, "0")}`, `old-payload-${index}`, 1000 + index);
  }
  db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(markerKey, `${artifactPrefix}old-00`, 1000);
  db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run("report-cards:v9", "untouched-canonical", 1000);
  db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run("worker-active-version:public", JSON.stringify({ worker: "public", scriptName: "stablecoin-api", workerVersion: readerVersion, activatedAt: 1000 }), 1000);
  db.close();
  const source = makeReportCardsV9Response();
  const artifact = { schemaVersion: 2, sourcePublicationGenerationId: source.safetyScoreIdentity.publicationGenerationId, sourceBaseInputGenerationId: source.safetyScoreIdentity.baseInputGenerationId, evaluationBuildDigest: source.safetyScoreIdentity.evaluationBuildDigest, methodologyVersion: source.methodology.version, computedAtSec: 10_000, cohort: { rootIds: [], selection: "Publisher storage fixture" }, scenarios: [] };
  if (payloadSize) artifact.cohort.selection += "x".repeat(payloadSize - Buffer.byteLength(JSON.stringify(artifact)));
  const bytes = JSON.stringify(artifact);
  writeFileSync(resolve(directory, "artifact.json"), bytes);
  writeFileSync(resolve(directory, "publication.json"), JSON.stringify(source));
  const stamp = createHash("sha256").update(stableJsonStringifyV1({
    publicationGenerationId: source.safetyScoreIdentity.publicationGenerationId,
    baseInputGenerationId: source.safetyScoreIdentity.baseInputGenerationId,
    evaluationBuildDigest: source.safetyScoreIdentity.evaluationBuildDigest,
    methodology: { version: source.methodology.version },
    artifactPayloadSha256: createHash("sha256").update(bytes).digest("hex"),
  })).digest("hex");
  writeFileSync(resolve(directory, "artifact.verified.sha256"), stamp);
  const publishedKey = `${artifactPrefix}${createHash("sha256").update(bytes).digest("hex")}`;
  const readerShim = resolve(directory, "reader.mjs");
  writeFileSync(readerShim, `import { appendFileSync } from 'node:fs';
let probes = 0;
const startedAt = Date.now();
globalThis.fetch = async () => {
  probes++;
  appendFileSync(process.env.SCENARIO_TEST_EVENTS, JSON.stringify('probe-reader') + '\\n');
  const mode = process.env.SCENARIO_TEST_READER ?? 'capable';
  if (mode === 'network') throw new Error('simulated-reader-unavailable');
  const headers = { 'Cache-Control': 'no-store' };
  if (mode !== 'missing-capability' && !(mode === 'rollback' && probes > 1)) headers[${JSON.stringify(DEPENDENCY_SCENARIO_READER_CAPABILITY_HEADER)}] = ${JSON.stringify(DEPENDENCY_SCENARIO_CHUNK_STORAGE_FORMAT)};
  if (mode !== 'missing-version') headers[${JSON.stringify(DEPENDENCY_SCENARIO_READER_VERSION_HEADER)}] = mode === 'mismatched-version' ? '87654321-4321-4321-8321-cba987654321' : ${JSON.stringify(readerVersion)};
  if (mode === 'expired' && probes > 1) Date.now = () => startedAt + 16 * 60_000;
  return new Response('reader-proof-body', { status: mode === 'http-error' ? 503 : 200, headers });
};`);
  const harness = createInProcessHarness(directory, databasePath);
  const invokeSpawn = (extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "--import", readerShim, "worker/scripts/compute-dependency-scenarios.ts", "--mode", "publish", "--out-dir", directory], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCENARIO_TEST_DB: databasePath, SCENARIO_TEST_EVENTS: resolve(directory, "events.jsonl"), SCENARIO_TEST_MARKER_KEY: markerKey, ...extraEnv } });
  return { directory, databasePath, publishedKey, bytes, ...harness, invokeSpawn, events: () => readFileSync(resolve(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}
function prepareComputeFixture(directory: string) {
  const input = createReplayFixedInput(1_800_000_000);
  const candidate = buildSafetyScoreV9ReplayArtifact({ fixedInput: input, publishedAtSec: input.clockSec }).pipeline.candidate;
  const source = projectSafetyScoreV9PublicationToPublicSnapshot(candidate, { schemaVersion: 2, status: "current", acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: candidate.publishedAtSec, attemptedAtSec: candidate.publishedAtSec, heldSinceSec: null, reasons: [] });
  writeFileSync(resolve(directory, "capture.json"), JSON.stringify(input));
  writeFileSync(resolve(directory, "publication.json"), JSON.stringify(source));
}

async function prepareSupplyAttributionReplayFixture() {
  const fixture = setup();
  // The current wM catalog has newly discovered routes without reviewed code
  // identities. Use the supported XAUT packet for these real-child-CLI replays.
  const base = makeV9FixedInput({ assetId: "xaut-tether", clockSec: 1_800_000_000, aggregateCirculating: { peggedGOLD: 2_480_000_000 } });
  const attribution = deriveXautRepresentationGroupSupplyAttribution({
    aggregateSupplyUsd: 2_480_000_000,
    registryFingerprint: base.registryFingerprint,
    scoringClockSec: base.clockSec,
    observation: makeXautObservation({ clockSec: base.clockSec }),
  });
  if (!attribution) throw new Error("Could not derive XAUT supply attribution");
  const fixedInput = normalizeFixedInput({
    ...base,
    safetyScoreV9SupplyAttributionById: { "xaut-tether": attribution },
  });
  const candidate = buildSafetyScoreV9ReplayArtifact({ fixedInput, publishedAtSec: base.clockSec }).pipeline.candidate;
  const source = projectSafetyScoreV9PublicationToPublicSnapshot(candidate, { schemaVersion: 2, status: "current", acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: candidate.publishedAtSec, attemptedAtSec: candidate.publishedAtSec, heldSinceSec: null, reasons: [] });
  const invoke = () => fixture.run(["--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", fixture.directory]);
  writeFileSync(resolve(fixture.directory, "publication.json"), JSON.stringify(source));
  writeFileSync(resolve(fixture.directory, "capture.json"), JSON.stringify(base));
  const entry = await buildSafetyScoreV9PublicationReplayCapture(candidate, fixedInput, null, null);
  const baseEntry = await buildReportCardsFixedInputCacheEntry(base);
  const newerEntry = await buildReportCardsFixedInputCacheEntry(createReplayFixedInput(base.clockSec + 1800));
  const db = new DatabaseSync(fixture.databasePath);
  try {
    for (const [key, value] of [[entry.key, entry.value], [SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, baseEntry.value], [newerEntry.key, newerEntry.value],
      [SAFETY_SCORE_V9_CACHE_KEYS.publication, await serializeSafetyScoreV9Publication(candidate)],
      [SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, stableJsonStringifyV1(source.publicationHealth)]]) {
      db.prepare("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)").run(key, value, base.clockSec);
    }
  } finally { db.close(); }
  const plan = () => fixture.run(["--mode", "plan", "--out-dir", fixture.directory]);
  return { ...fixture, base, candidate, entry, invoke, plan };
}

describe("dependency scenario accepted-publication verification stamp", () => {
  it("rebuilds an accepted certificate-closed deployment from captured lane witnesses", async () => {
    const fixture = setup();
    const clockSec = 1_793_404_800;
    const descriptor = loadReviewedLaneEmitterCatalog().descriptors.find((row) => row.assetId === "frnt-wyoming" &&
      row.subjectDeploymentKey.startsWith("arbitrum:"))!;
    // Synthetic registry scenario only: production FRNT remains global-scope.
    // Documented cohort snapshot: this capture replays one asset, so only its row
    // is needed. Fingerprinting the whole ~386-asset catalog is the expensive
    // part of every snapshot verification (four of them in this case).
    const original = localRegistrySnapshot();
    const scenarioCoin = original.activeStablecoins.find((coin) => coin.id === descriptor.assetId)!;
    const rows = {
      activeStablecoins: [{ ...scenarioCoin, mintAuthority: undefined, bridgeRouteRisk: { ...scenarioCoin.bridgeRouteRisk!,
        routes: scenarioCoin.bridgeRouteRisk!.routes!.map((route) => route.id !== descriptor.subjectDeploymentKey ? route :
          { ...route, routeClass: "canonical" as const, issuanceModel: "bridge-representation" as const }),
      } }],
      frozenStablecoins: [],
      deadStablecoins: [],
    };
    const registrySnapshot = { ...original, ...rows, fingerprint: registrySnapshotFingerprint(rows) };
    const { baseInputGenerationId: _base, ...draft } = createReplayFixedInput(clockSec, { activeAssetIds: [descriptor.assetId] });
    const fixedInput = normalizeFixedInput({ ...draft, registryFingerprint: registrySnapshot.fingerprint });
    const families = [...new Set(descriptor.emitters.flatMap((emitter) => emitter.families))];
    const certificate = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: "lane-cert:scenario-current", evidenceClass: "explorer-events",
      subjectDeploymentKey: descriptor.subjectDeploymentKey, fromBlock: 100, toBlock: 200,
      toBlockHash: `0x${"1".repeat(64)}`, windowStartSec: clockSec - 100, windowEndSec: clockSec - 60, observedAtSec: clockSec - 30,
      screeningPolicyDigest: descriptor.screeningPolicyDigest, logDigest: "d".repeat(64),
      emitters: descriptor.emitters.map((emitter) => ({ address: emitter.address, families: emitter.families,
        expectedRuntimeCodeSha256: emitter.reviewedRuntimePin.split(":")[1], runtimeCodeSha256: emitter.reviewedRuntimePin.split(":")[1] })),
      screenedTopics: families.map((family) => ({ family, topic0: `0x${"2".repeat(64)}`, signature: `${family}()` })),
      eventCounts: Object.fromEntries(families.map((family) => [family, 0])), finding: "no-material-admin-event",
    });
    const laneScreening = buildSafetyScoreV9ReplayLaneScreening({ descriptors: [descriptor],
      certificates: new Map([[descriptor.subjectDeploymentKey, { screeningSetId: descriptor.screeningSetId, certificate }]]) });
    const replay = buildSafetyScoreV9ReplayArtifact({ fixedInput, registrySnapshot, laneScreening, publishedAtSec: clockSec });
    const without = buildSafetyScoreV9ReplayArtifact({ fixedInput, registrySnapshot, publishedAtSec: clockSec });
    expect(replay.pipeline.compiledFacts.v9FactSetDigest).not.toBe(without.pipeline.compiledFacts.v9FactSetDigest);
    const candidate = replay.pipeline.candidate;
    const source = projectSafetyScoreV9PublicationToPublicSnapshot(candidate, { schemaVersion: 2, status: "current",
      acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: clockSec, attemptedAtSec: clockSec, heldSinceSec: null, reasons: [] });
    writeFileSync(resolve(fixture.directory, "publication.json"), JSON.stringify(source));
    const capturePath = resolve(fixture.directory, "capture.json");
    const invoke = () => fixture.run(["--mode", "compute", "--input", capturePath, "--publication", resolve(fixture.directory, "publication.json"),
      "--out-dir", fixture.directory]);
    writeFileSync(capturePath, JSON.stringify({ fixedInput, registrySnapshot, laneScreening }));
    const complete = await invoke();
    expect(complete.status, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout).acceptedPublicationVerified).toBe(true);
    writeFileSync(capturePath, JSON.stringify({ fixedInput, registrySnapshot }));
    const stripped = await invoke();
    expect(stripped.status).not.toBe(0);
    expect(stripped.stderr).toContain("Capture replay does not match accepted publication identity");
  }, 60_000);

  it("rejects a stripped base capture that lacks accepted compute-time supply attribution", async () => {
    const fixture = await prepareSupplyAttributionReplayFixture();
    const incomplete = await fixture.invoke();
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain("factSetDigest");
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
  }, 30_000);
  it("reproduces accepted compute-time supply attribution from the atomic D1 snapshot", async () => {
    const fixture = await prepareSupplyAttributionReplayFixture();
    const planned = await fixture.plan();
    expect(planned.status, planned.stderr).toBe(0);
    expect(fixture.events()).toHaveLength(1);
    const complete = await fixture.invoke();
    expect(complete.status, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout).acceptedPublicationVerified).toBe(true);
    const replayPath = resolve(fixture.directory, "replay.json");
    // The replay CLI is exercised in-process: this case asserts the artifact it
    // writes, not the process boundary (owned by the spawn cases above).
    await runSafetyScoreV9ReplayCli(["--input", resolve(fixture.directory, "capture.json"), "--output", replayPath, "--published-at", String(fixture.base.clockSec)]);
    expect(JSON.parse(readFileSync(replayPath, "utf8")).pipeline.candidate.publicationGenerationId).toBe(fixture.candidate.publicationGenerationId);
  }, 30_000);
  it("exports the exact retained rows that the historical evaluator's own capture reader verifies and publishes", async () => {
    const fixture = await prepareSupplyAttributionReplayFixture();
    const planned = await fixture.plan();
    expect(planned.status, planned.stderr).toBe(0);
    const raw = JSON.parse(readFileSync(resolve(fixture.directory, "accepted.raw.json"), "utf8"));
    expect(raw[0].results.map((row: { key: string }) => row.key).sort()).toEqual([SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, fixture.entry.key].sort());
    // Mirrors the workflow's credential-free historical stage, with absolute paths and a separate directory.
    const historical = resolve(fixture.directory, "historical");
    mkdirSync(historical);
    await runReportCardsFixedInputCaptureCli(["--accepted-cache-export", resolve(fixture.directory, "accepted.raw.json"), "--output", resolve(historical, "capture.json")]);
    const compute = await fixture.run(["--mode", "compute", "--input", resolve(historical, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", historical]);
    expect(compute.status, compute.stderr).toBe(0);
    expect(JSON.parse(compute.stdout).acceptedPublicationVerified).toBe(true);
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
    for (const name of ["artifact.json", "artifact.verified.sha256"]) writeFileSync(resolve(fixture.directory, name), readFileSync(resolve(historical, name)));
    const publish = await fixture.invoke();
    expect(publish.status, publish.stderr).toBe(0);
  }, 60_000);
  it("fails plan explicitly on a legacy capture without a retained admission baseline", async () => {
    const fixture = await prepareSupplyAttributionReplayFixture();
    const { safetyScoreV9SupplyAttributionById, evidenceJournalById, supplyAttributionJournalById, pegProvenanceById } =
      (await parseSafetyScoreV9PublicationReplayCapture(fixture.entry.value, fixture.base)).fixedInput;
    const legacy = await buildFixedInputCacheEntry({
      schemaVersion: 2, sourceGeneration: fixture.candidate.publicationGenerationId,
      payload: { schemaVersion: 2, publicationGenerationId: fixture.candidate.publicationGenerationId,
        baseInputGenerationId: fixture.base.baseInputGenerationId, pipelineGapDigest: null,
        enrichment: { safetyScoreV9SupplyAttributionById, evidenceJournalById, supplyAttributionJournalById, pegProvenanceById }, transferMaterialityGeneration: null },
      label: "Legacy v2 delta",
    });
    const db = new DatabaseSync(fixture.databasePath);
    try { db.prepare("UPDATE cache SET value = ? WHERE key = ?").run(legacy.value, fixture.entry.key); } finally { db.close(); }
    const rejected = await fixture.plan();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("accepted-publication-replay-baseline-unavailable");
    expect(existsSync(resolve(fixture.directory, "accepted.raw.json"))).toBe(false);
  }, 30_000);
  it.each([
    ["retention clock", "accepted-publication-replay-retention-clock-mismatch"],
    ["publication generation", "accepted-publication-replay-capture-generation-mismatch"],
    ["missing publication", "accepted-publication-snapshot-unavailable"],
  ] as const)("rejects an accepted snapshot with %s mismatch", async (defect, reason) => {
    const fixture = await prepareSupplyAttributionReplayFixture();
    const changedDb = new DatabaseSync(fixture.databasePath);
    try {
      if (defect === "retention clock") {
        changedDb.prepare("UPDATE cache SET updated_at = updated_at + 1 WHERE key = ?").run(fixture.entry.key);
      } else if (defect === "publication generation") {
        const changedCandidate = { ...fixture.candidate, publicationGenerationId: `report-cards:v9:v1:${"f".repeat(64)}` };
        changedDb.prepare("UPDATE cache SET value = ? WHERE key = ?").run(await serializeSafetyScoreV9Publication(changedCandidate), SAFETY_SCORE_V9_CACHE_KEYS.publication);
      } else {
        changedDb.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.publication);
      }
      const rejected = await fixture.plan();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(reason);
    } finally { changedDb.close(); }
  }, 30_000);
  it("rejects a missing stamp before touching the remote store", () => {
    const fixture = setup();
    rmSync(resolve(fixture.directory, "artifact.verified.sha256"));
    const run = fixture.invokeSpawn();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("verification stamp missing");
    expect(existsSync(resolve(fixture.directory, "events.jsonl"))).toBe(false);
  });
  it("rejects a schema-valid hand-edited artifact rather than trusting a previous stamp", () => {
    const fixture = setup();
    const artifact = JSON.parse(fixture.bytes);
    artifact.computedAtSec++;
    writeFileSync(resolve(fixture.directory, "artifact.json"), JSON.stringify(artifact));
    const run = fixture.invokeSpawn();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("verification stamp mismatch");
    expect(existsSync(resolve(fixture.directory, "events.jsonl"))).toBe(false);
  });
  it.each(["sourceBaseInputGenerationId", "methodologyVersion"] as const)("rechecks %s against the publication", async field => {
    const fixture = setup();
    const artifact = JSON.parse(fixture.bytes);
    artifact[field] = field === "sourceBaseInputGenerationId" ? `report-cards-input:v1:${"f".repeat(64)}` : "different-methodology";
    writeFileSync(resolve(fixture.directory, "artifact.json"), JSON.stringify(artifact));
    const run = await fixture.invoke();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Publish source identity mismatch");
  });
  it("a compute without publication removes an old stamp and cannot subsequently publish", async () => {
    const fixture = setup();
    prepareComputeFixture(fixture.directory);
    const run = await fixture.run(["--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--out-dir", fixture.directory]);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
    const publish = await fixture.invoke();
    expect(publish.status).not.toBe(0);
    expect(publish.stderr).toContain("verification stamp missing");
  }, 30_000);
  it("publishes the exact artifact produced by a publication-equivalent compute", async () => {
    const fixture = setup();
    prepareComputeFixture(fixture.directory);
    const run = await fixture.run(["--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", fixture.directory]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).acceptedPublicationVerified).toBe(true);
    const publishedBytes = readFileSync(resolve(fixture.directory, "artifact.json"), "utf8");
    const publish = await fixture.invoke();
    expect(publish.status, publish.stderr).toBe(0);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const key = db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value;
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(key as string)?.value).toBe(publishedBytes);
    } finally { db.close(); }
  }, 30_000);
});

const admissionOf = (baseline: SafetyScoreV9AcceptedPublicationBaseline) => ({ sha256: sha256Hex(stableJsonStringifyV1(baseline)), baseline });

describe("dependency scenario accepted-publication grade-hold overlay", () => {
  const card = (score: number, grade: string) => ({ id: "test-asset", score, grade, ratingStatus: "rated", partialEvidence: null });
  const prior = { publicationGenerationId: "accepted-old", publishedAtSec: 1, policyVersion: "9", policyId: "p", policyDigest: "a".repeat(64),
    evaluationBuildDigest: "b".repeat(64), dexGenerationId: null,
    cards: [{ id: "test-asset", score: 80, grade: "A-", primaryRouteKey: null, diversificationRouteKey: null, primaryRouteCapacityUsd: null, pillarScores: null }] } as SafetyScoreV9AcceptedPublicationBaseline;
  const held = { ...card(70, "A-"), gradeHold: { rawGrade: "B", heldFromGenerationId: "accepted-old" } };
  const verify = (served: object, admission: unknown) => verifyAcceptedPublicationCards([card(70, "B")] as never, [served] as never, admission as never);

  it("reproduces raw70/B published as held A- from prior80/A- without copying the served grade", () => {
    expect(scoreToGrade(70)).toBe("B");
    expect(verify(held, admissionOf(prior)).get("test-asset")).toMatchObject({ score: 70, grade: "A-", gradeHold: held.gradeHold });
  });
  it.each([
    ["a legacy capture without baseline context", held, undefined, "accepted-publication-replay-baseline-unavailable"],
    ["a genuine bootstrap that cannot explain a hold", held, null, "Published baseline mismatch"],
    ["a hold naming another baseline", { ...held, gradeHold: { rawGrade: "B", heldFromGenerationId: "accepted-forged" } }, admissionOf(prior), "Published baseline mismatch"],
    ["a substituted prior grade", held, admissionOf({ ...prior, cards: [{ ...prior.cards[0]!, score: 72, grade: "B" }] }), "Published baseline mismatch"],
    ["an unheld served grade the baseline would hold", card(70, "B"), admissionOf(prior), "Published baseline mismatch"],
    ["a raw score change", { ...held, score: 71 }, admissionOf(prior), "Published baseline mismatch"],
  ] as const)("rejects %s", (_label, served, admission, reason) => {
    expect(() => verify(served, admission)).toThrow(reason);
  });
  it("confirms the next-band change once the baseline already computed it", () => {
    const confirmed: SafetyScoreV9AcceptedPublicationBaseline = { ...prior, cards: [{ ...prior.cards[0]!, score: 71, grade: "A-" }] };
    expect(verify(card(70, "B"), admissionOf(confirmed)).get("test-asset")?.grade).toBe("B");
  });
  it("keeps strict raw verification for legacy captures without holds", () => {
    expect(verify(card(70, "B"), undefined).get("test-asset")?.grade).toBe("B");
  });

  function heldComputeFixture() {
    const fixture = setup();
    const input = createReplayFixedInput(1_800_000_000);
    const candidate = buildSafetyScoreV9ReplayArtifact({ fixedInput: input, publishedAtSec: input.clockSec }).pipeline.candidate;
    const target = candidate.cards.find(row => row.ratingStatus === "rated" && row.score !== null)!;
    const priorScore = [target.score! + 10, target.score! - 10].find(score => score >= 0 && score <= 100 && scoreToGrade(score) !== scoreToGrade(target.score))!;
    const baseline = buildSafetyScoreV9AcceptedPublicationBaseline(candidate);
    const priorBaseline = { ...baseline, publicationGenerationId: "accepted-prior", publishedAtSec: input.clockSec - 1800,
      cards: baseline.cards.map(row => row.id === target.id ? { ...row, score: priorScore, grade: scoreToGrade(priorScore) } : row) };
    const served = applySafetyScoreV9GradeHysteresis(candidate, priorBaseline);
    expect(served.cards.find(row => row.id === target.id)?.gradeHold?.heldFromGenerationId).toBe("accepted-prior");
    const source = projectSafetyScoreV9PublicationToPublicSnapshot(served, { schemaVersion: 2, status: "current", acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: candidate.publishedAtSec, attemptedAtSec: candidate.publishedAtSec, heldSinceSec: null, reasons: [] });
    writeFileSync(resolve(fixture.directory, "publication.json"), JSON.stringify(source));
    const writeCapture = (extra: Record<string, unknown>) => writeFileSync(resolve(fixture.directory, "capture.json"), JSON.stringify({
      kind: "safety-score-v9-accepted-publication-capture", publicationGenerationId: candidate.publicationGenerationId,
      fixedInput: input, transferMaterialityGeneration: null, ...extra }));
    const compute = () => fixture.run(["--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", fixture.directory]);
    return { fixture, target, priorBaseline, writeCapture, compute };
  }
  it("verifies a held accepted publication from its retained baseline and stamps it", async () => {
    const { fixture, target, priorBaseline, writeCapture, compute } = heldComputeFixture();
    writeCapture({ sourceAdmissionBaseline: admissionOf(priorBaseline) });
    const run = await compute();
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).acceptedPublicationVerified).toBe(true);
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(true);
    const rows = JSON.parse(readFileSync(resolve(fixture.directory, "artifact.json"), "utf8")).scenarios.flatMap((scenario: { results: Array<{ assetId: string; publishedGrade: string }> }) => scenario.results);
    for (const row of rows.filter((row: { assetId: string }) => row.assetId === target.id)) expect(row.publishedGrade).toBe(scoreToGrade(priorBaseline.cards.find(card => card.id === target.id)!.score));
  }, 30_000);
  it.each([
    ["legacy capture without baseline", () => ({}), "accepted-publication-replay-baseline-unavailable"],
    ["tampered baseline checksum", (baseline: SafetyScoreV9AcceptedPublicationBaseline) => ({ sourceAdmissionBaseline: { ...admissionOf(baseline), baseline: { ...baseline, publicationGenerationId: "accepted-forged" } } }), "accepted-publication-replay-baseline-checksum-mismatch"],
    ["re-checksummed substituted baseline", (baseline: SafetyScoreV9AcceptedPublicationBaseline) => ({ sourceAdmissionBaseline: admissionOf({ ...baseline, publicationGenerationId: "accepted-forged" }) }), "Published baseline mismatch"],
  ] as const)("rejects a %s without a stamp", async (_label, extra, reason) => {
    const { fixture, priorBaseline, writeCapture, compute } = heldComputeFixture();
    writeCapture(extra(priorBaseline));
    const run = await compute();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(reason);
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
  }, 30_000);
});

describe("dependency scenario publication retention", () => {
  it("prunes only after both readbacks, retains the latest 24 payloads and leaves canonical rows untouched", async () => {
    const fixture = setup();
    const run = await fixture.invoke();
    expect(run.status, run.stderr).toBe(0);
    expect(fixture.events()).toEqual(["write-artifact", "read-artifact", "write-marker", "read-marker", "prune", "prune-chunks", "prune-writing"]);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const rows = db.prepare("SELECT key FROM cache WHERE key GLOB ? ORDER BY updated_at DESC, key DESC").all(`${artifactPrefix}*`);
      expect(rows).toHaveLength(24);
      expect(rows[0]?.key).toBe(fixture.publishedKey);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(fixture.publishedKey);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)?.value).toBe(fixture.bytes);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get("report-cards:v9")?.value).toBe("untouched-canonical");
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(`${artifactPrefix}old-16`)).toBeUndefined();
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(`${artifactPrefix}old-17`)?.value).toBe("old-payload-17");
    } finally { db.close(); }
  }, 30_000);
  it("protects the row the marker points to even when it changes to a row outside the retention window", async () => {
    const fixture = setup();
    const run = await fixture.invoke({ SCENARIO_TEST_MOVE_MARKER: `${artifactPrefix}old-00` });
    expect(run.status, run.stderr).toBe(0);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const marker = db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value;
      expect(marker).toBe(`${artifactPrefix}old-00`);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(marker as string)?.value).toBe("old-payload-0");
      expect(db.prepare("SELECT count(*) AS count FROM cache WHERE key GLOB ?").get(`${artifactPrefix}*`)?.count).toBe(25);
    } finally { db.close(); }
  }, 30_000);
  it("logs pruning failure without failing or rolling back an already verified publication", async () => {
    const fixture = setup();
    const run = await fixture.invoke({ SCENARIO_TEST_FAIL_PRUNE: "1" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("pruning failed; publication remains committed");
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(fixture.publishedKey);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)?.value).toBe(fixture.bytes);
      expect(db.prepare("SELECT count(*) AS count FROM cache WHERE key GLOB ?").get(`${artifactPrefix}*`)?.count).toBe(41);
    } finally { db.close(); }
  }, 30_000);
  it("never prunes or advances the marker after a failed immutable payload readback", async () => {
    const fixture = setup();
    const run = await fixture.invoke({ SCENARIO_TEST_BAD_READBACK: "1" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Readback mismatch");
    expect(fixture.events()).toEqual(["write-artifact", "read-artifact"]);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
    } finally { db.close(); }
  }, 30_000);
  it("retains manifest/latest/in-flight/recent sets and prunes aged orphan chunks", async () => {
    const fixture = setup();
    const db = new DatabaseSync(fixture.databasePath);
    const now = Math.floor(Date.now() / 1000);
    const aged = now - 2 * 86_400;
    const add = (id: string, index = 0, createdAt = aged) => db.prepare("INSERT INTO dependency_scenario_payload_chunks (payload_id,chunk_index,value,byte_length,sha256,created_at) VALUES (?,?,'old',3,?,?)").run(id, index, "0".repeat(64), createdAt);
    const retained = `${artifactPrefix}old-39`;
    const expired = `${artifactPrefix}old-01`;
    const latest = `${artifactPrefix}old-00`;
    const inFlight = `${artifactPrefix}in-flight`;
    const recent = `${artifactPrefix}recent`;
    const abandoned = `${artifactPrefix}abandoned`;
    add(retained); add(expired); add(latest); add(inFlight);
    add(recent); add(recent, 1, now); add(abandoned);
    db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}writing:live`, inFlight, now);
    db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}writing:abandoned`, abandoned, aged);
    db.close();
    const run = await fixture.invoke({ SCENARIO_TEST_MOVE_MARKER: latest });
    expect(run.status, run.stderr).toBe(0);
    const after = new DatabaseSync(fixture.databasePath);
    try {
      const ids = after.prepare("SELECT DISTINCT payload_id FROM dependency_scenario_payload_chunks ORDER BY payload_id").all().map(row => row.payload_id);
      expect(ids).toEqual([inFlight, latest, retained, recent].sort());
      expect(after.prepare("SELECT count(*) AS count FROM dependency_scenario_payload_chunks WHERE payload_id = ?").get(recent)?.count).toBe(2);
      expect(after.prepare("SELECT value FROM cache WHERE key = ?").get(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}writing:live`)?.value).toBe(inFlight);
      expect(after.prepare("SELECT value FROM cache WHERE key = ?").get(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}writing:abandoned`)).toBeUndefined();
    } finally { after.close(); }
  }, 30_000);
  it("bounds each chunk drain to 500 aged rows and protects chunks within the grace period", async () => {
    const fixture = setup();
    const db = new DatabaseSync(fixture.databasePath);
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare("INSERT INTO dependency_scenario_payload_chunks (payload_id,chunk_index,value,byte_length,sha256,created_at) VALUES (?,0,'old',3,?,?)");
    for (let index = 0; index < 600; index++) insert.run(`${artifactPrefix}orphan-${index}`, "0".repeat(64), now - 2 * 86_400);
    insert.run(`${artifactPrefix}at-grace`, "0".repeat(64), now - 86_400 + 60);
    db.close();
    const run = await fixture.invoke();
    expect(run.status, run.stderr).toBe(0);
    const after = new DatabaseSync(fixture.databasePath);
    try {
      expect(after.prepare("SELECT count(*) AS count FROM dependency_scenario_payload_chunks").get()?.count).toBe(101);
      expect(after.prepare("SELECT value FROM dependency_scenario_payload_chunks WHERE payload_id = ?").get(`${artifactPrefix}at-grace`)?.value).toBe("old");
    } finally { after.close(); }
  }, 30_000);
});

describe("dependency scenario chunk publication", () => {
  it.each([DEPENDENCY_SCENARIO_CHUNK_BYTES, DEPENDENCY_SCENARIO_CHUNK_BYTES + 1])("publishes the actual %i-byte boundary safely", async size => {
    const fixture = setup(size);
    const run = await fixture.invoke();
    expect(run.status, run.stderr).toBe(0);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const stored = String(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)?.value);
      if (size === DEPENDENCY_SCENARIO_CHUNK_BYTES) {
        expect(stored).toBe(fixture.bytes);
        expect(fixture.events()).not.toContain("write-chunk");
      } else {
        const chunks = db.prepare("SELECT chunk_index,value,byte_length,sha256 FROM dependency_scenario_payload_chunks WHERE payload_id = ? ORDER BY chunk_index").all(fixture.publishedKey);
        expect(chunks).toHaveLength(2);
        expect(reassembleDependencyScenarioPayload(JSON.parse(stored), chunks, fixture.publishedKey.slice(artifactPrefix.length))).toBe(fixture.bytes);
        expect(fixture.events()).toEqual(["read-capability", "probe-reader", "read-capability", "write-writing", "read-writing", "write-chunk", "write-chunk", "read-chunks", "read-capability", "probe-reader", "read-capability", "write-artifact", "read-artifact", "read-capability", "write-marker", "read-marker", "clear-writing", "prune", "prune-chunks", "prune-writing"]);
      }
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(fixture.publishedKey);
    } finally { db.close(); }
  }, 30_000);
  it.each(["missing", "hash", "whole-hash"])("never commits %s chunk readbacks", async defect => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1);
    const run = await fixture.invoke({ SCENARIO_TEST_BAD_CHUNKS: defect });
    expect(run.status).not.toBe(0);
    expect(fixture.events()).toEqual(["read-capability", "probe-reader", "read-capability", "write-writing", "read-writing", "write-chunk", "write-chunk", "read-chunks", "clear-writing"]);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)).toBeUndefined();
    } finally { db.close(); }
  }, 30_000);
  it("does not overwrite conflicting immutable chunks or move latest", async () => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      db.prepare("INSERT INTO dependency_scenario_payload_chunks (payload_id,chunk_index,value,byte_length,sha256) VALUES (?,0,'bad',3,?)").run(fixture.publishedKey, "0".repeat(64));
    } finally { db.close(); }
    expect((await fixture.invoke()).status).not.toBe(0);
    const after = new DatabaseSync(fixture.databasePath);
    try {
      expect(after.prepare("SELECT value FROM dependency_scenario_payload_chunks WHERE payload_id = ? AND chunk_index = 0").get(fixture.publishedKey)?.value).toBe("bad");
      expect(after.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
    } finally { after.close(); }
  }, 30_000);
});

describe("dependency scenario reader activation gate", () => {
  it.each(["missing-capability", "missing-version", "mismatched-version", "http-error", "network"])("rejects %s before any chunk publication writes", async mode => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1);
    const run = await fixture.invoke({ SCENARIO_TEST_READER: mode });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("dependency-scenarios-chunk-reader-unavailable");
    expect(fixture.events().filter(event => event.startsWith("write-"))).toEqual([]);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
      expect(db.prepare("SELECT count(*) AS count FROM dependency_scenario_payload_chunks").get()?.count).toBe(0);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)).toBeUndefined();
    } finally { db.close(); }
  }, 30_000);
  it.each(["missing", "malformed", "wrong-role", "wrong-clock"])("rejects a %s deploy marker without a positive reader claim", async defect => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      if (defect === "missing") db.prepare("DELETE FROM cache WHERE key = 'worker-active-version:public'").run();
      else if (defect === "malformed") db.prepare("UPDATE cache SET value = 'invalid' WHERE key = 'worker-active-version:public'").run();
      else if (defect === "wrong-role") db.prepare("UPDATE cache SET value = ? WHERE key = 'worker-active-version:public'").run(JSON.stringify({ worker: "heavy", scriptName: "stablecoin-heavy", workerVersion: readerVersion, activatedAt: 1000 }));
      else db.prepare("UPDATE cache SET updated_at = 1001 WHERE key = 'worker-active-version:public'").run();
    } finally { db.close(); }
    const run = await fixture.invoke();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("dependency-scenarios-chunk-reader-unavailable");
    expect(fixture.events()).toEqual(["read-capability"]);
  }, 30_000);
  it("keeps a fitting single-row artifact publishable with the legacy reader", async () => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES);
    const run = await fixture.invoke({ SCENARIO_TEST_READER: "missing-capability" });
    expect(run.status, run.stderr).toBe(0);
    expect(fixture.events()).not.toContain("probe-reader");
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)?.value).toBe(fixture.bytes);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(fixture.publishedKey);
    } finally { db.close(); }
  }, 30_000);
  it.each(["rollback", "expired"])("does not commit a staged payload after %s", async mode => {
    const fixture = setup(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1);
    const run = await fixture.invoke({ SCENARIO_TEST_READER: mode });
    expect(run.status).not.toBe(0);
    expect(fixture.events()).toContain("read-chunks");
    expect(fixture.events()).not.toContain("write-artifact");
    expect(fixture.events()).not.toContain("write-marker");
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
      expect(db.prepare("SELECT count(*) AS count FROM cache WHERE key GLOB ?").get(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}writing:*`)?.count).toBe(0);
    } finally { db.close(); }
  }, 30_000);
});
