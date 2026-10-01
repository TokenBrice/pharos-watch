import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
import { projectSafetyScoreV9PublicationToPublicSnapshot } from "../../src/lib/report-cards-v9-cache";
import { buildSafetyScoreV9PublicationReplayCapture } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY } from "../../src/lib/safety-score-v9/publication-codec";
import { makeV9FixedInput, makeXautObservation } from "../../src/test-helpers/v9-fixed-input";
import { normalizeFixedInput } from "../../src/lib/report-cards-fixed-input";
import { deriveXautRepresentationGroupSupplyAttribution } from "../../src/lib/safety-score-v9/xaut-supply-attribution-contract";
import { buildReportCardsFixedInputCacheEntry } from "../../src/test-helpers/report-cards-fixed-input";

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
const markerKey = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`;
const artifactPrefix = `${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:`;

// This Wrangler executable runs the publisher's actual SQL against SQLite,
// rather than returning mock echoes, and exposes readback/failure boundaries.
const WRANGLER_SIMULATOR = `#!/usr/bin/env node
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const sql = args.includes('--file') ? fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8') : args[args.indexOf('--command') + 1];
const db = new DatabaseSync(process.env.SCENARIO_TEST_DB);
const event = sql.startsWith('INSERT') ? (sql.includes(':latest') ? 'write-marker' : 'write-artifact') : sql.startsWith('DELETE') ? 'prune' : sql.includes(':latest') ? 'read-marker' : 'read-artifact';
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
 console.log(JSON.stringify([{results,success:true}]));
} else {
 db.exec(sql); console.log(JSON.stringify([{results:[],success:true}]));
}
db.close();
`;
function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "pharos-scenario-publish-"));
  temporaryDirectories.push(directory);
  const bin = resolve(directory, "bin");
  mkdirSync(bin);
  writeFileSync(resolve(bin, "npx"), WRANGLER_SIMULATOR);
  chmodSync(resolve(bin, "npx"), 0o755);
  const databasePath = resolve(directory, "cache.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  for (let index = 0; index < 40; index++) {
    db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(`${artifactPrefix}old-${String(index).padStart(2, "0")}`, `old-payload-${index}`, 1000 + index);
  }
  db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(markerKey, `${artifactPrefix}old-00`, 1000);
  db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run("report-cards:v9", "untouched-canonical", 1000);
  db.close();
  const source = makeReportCardsV9Response();
  const bytes = JSON.stringify({ schemaVersion: 1, sourcePublicationGenerationId: source.safetyScoreIdentity.publicationGenerationId, sourceBaseInputGenerationId: source.safetyScoreIdentity.baseInputGenerationId, evaluationBuildDigest: source.safetyScoreIdentity.evaluationBuildDigest, methodologyVersion: source.methodology.version, computedAtSec: 10_000, cohort: { rootIds: [], selection: "Publisher storage fixture" }, scenarios: [] });
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
  const invoke = (extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "worker/scripts/compute-dependency-scenarios.ts", "--mode", "publish", "--out-dir", directory], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCENARIO_TEST_DB: databasePath, SCENARIO_TEST_EVENTS: resolve(directory, "events.jsonl"), SCENARIO_TEST_MARKER_KEY: markerKey, ...extraEnv } });
  return { directory, databasePath, publishedKey, bytes, invoke, events: () => readFileSync(resolve(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}
function prepareComputeFixture(directory: string) {
  const input = createReplayFixedInput(1_800_000_000);
  const candidate = buildSafetyScoreV9ReplayArtifact({ fixedInput: input, publishedAtSec: input.clockSec }).pipeline.candidate;
  const source = projectSafetyScoreV9PublicationToPublicSnapshot(candidate, { schemaVersion: 1, status: "current", acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: candidate.publishedAtSec, attemptedAtSec: candidate.publishedAtSec, heldSinceSec: null, reasons: [] });
  writeFileSync(resolve(directory, "capture.json"), JSON.stringify(input));
  writeFileSync(resolve(directory, "publication.json"), JSON.stringify(source));
}

describe("dependency scenario accepted-publication verification stamp", () => {
  it("reproduces accepted compute-time supply attribution rather than the stripped base capture", async () => {
    const fixture = setup();
    // The current wM catalog has newly discovered routes without reviewed code
    // identities. Use the supported XAUT packet for this real-child-CLI replay.
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
    const source = projectSafetyScoreV9PublicationToPublicSnapshot(candidate, { schemaVersion: 1, status: "current", acceptedPublicationGenerationId: candidate.publicationGenerationId, acceptedAtSec: candidate.publishedAtSec, attemptedAtSec: candidate.publishedAtSec, heldSinceSec: null, reasons: [] });
    const invoke = () => spawnSync(process.execPath, ["--import", "tsx", "worker/scripts/compute-dependency-scenarios.ts", "--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", fixture.directory], { encoding: "utf8", timeout: 30_000 });
    writeFileSync(resolve(fixture.directory, "publication.json"), JSON.stringify(source));
    writeFileSync(resolve(fixture.directory, "capture.json"), JSON.stringify(base));
    const incomplete = invoke();
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain("factSetDigest");
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
    const entry = await buildSafetyScoreV9PublicationReplayCapture(candidate, fixedInput, null);
    const baseEntry = await buildReportCardsFixedInputCacheEntry(base);
    const newerEntry = await buildReportCardsFixedInputCacheEntry(createReplayFixedInput(base.clockSec + 1800));
    const db = new DatabaseSync(fixture.databasePath);
    try {
      for (const [key, value] of [[entry.key, entry.value], [SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, baseEntry.value], [newerEntry.key, newerEntry.value]]) {
        db.prepare("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)").run(key, value, base.clockSec);
      }
    } finally { db.close(); }
    const fetchShim = resolve(fixture.directory, "fetch.mjs");
    writeFileSync(fetchShim, `import { readFileSync } from 'node:fs'; globalThis.fetch = async () => new Response(readFileSync(process.env.SCENARIO_TEST_PUBLICATION, 'utf8'));`);
    const plan = spawnSync(process.execPath, ["--import", "tsx", "--import", fetchShim, "worker/scripts/compute-dependency-scenarios.ts", "--mode", "plan", "--out-dir", fixture.directory], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${resolve(fixture.directory, "bin")}:${process.env.PATH}`, PHAROS_API_KEY: "test-only", SCENARIO_TEST_PUBLICATION: resolve(fixture.directory, "publication.json"), SCENARIO_TEST_DB: fixture.databasePath, SCENARIO_TEST_EVENTS: resolve(fixture.directory, "events.jsonl") },
    });
    expect(plan.status, plan.stderr).toBe(0);
    const complete = invoke();
    expect(complete.status, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout).acceptedPublicationVerified).toBe(true);
    const replayPath = resolve(fixture.directory, "replay.json");
    const replay = spawnSync(process.execPath, ["--import", "tsx", "worker/scripts/replay-safety-score-v9.ts", "--input", resolve(fixture.directory, "capture.json"), "--output", replayPath, "--published-at", String(base.clockSec)], { encoding: "utf8", timeout: 30_000 });
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(readFileSync(replayPath, "utf8")).pipeline.candidate.publicationGenerationId).toBe(candidate.publicationGenerationId);
  }, 30_000);
  it("rejects a missing stamp before touching the remote store", () => {
    const fixture = setup();
    rmSync(resolve(fixture.directory, "artifact.verified.sha256"));
    const run = fixture.invoke();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("verification stamp missing");
    expect(existsSync(resolve(fixture.directory, "events.jsonl"))).toBe(false);
  });
  it("rejects a schema-valid hand-edited artifact rather than trusting a previous stamp", () => {
    const fixture = setup();
    const artifact = JSON.parse(fixture.bytes);
    artifact.computedAtSec++;
    writeFileSync(resolve(fixture.directory, "artifact.json"), JSON.stringify(artifact));
    const run = fixture.invoke();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("verification stamp mismatch");
    expect(existsSync(resolve(fixture.directory, "events.jsonl"))).toBe(false);
  });
  it.each(["sourceBaseInputGenerationId", "methodologyVersion"] as const)("rechecks %s against the publication", field => {
    const fixture = setup();
    const artifact = JSON.parse(fixture.bytes);
    artifact[field] = field === "sourceBaseInputGenerationId" ? `report-cards-input:v1:${"f".repeat(64)}` : "different-methodology";
    writeFileSync(resolve(fixture.directory, "artifact.json"), JSON.stringify(artifact));
    const run = fixture.invoke();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Publish source identity mismatch");
  });
  it("a compute without publication removes an old stamp and cannot subsequently publish", () => {
    const fixture = setup();
    prepareComputeFixture(fixture.directory);
    const run = spawnSync(process.execPath, ["--import", "tsx", "worker/scripts/compute-dependency-scenarios.ts", "--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--out-dir", fixture.directory], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(resolve(fixture.directory, "artifact.verified.sha256"))).toBe(false);
    const publish = fixture.invoke();
    expect(publish.status).not.toBe(0);
    expect(publish.stderr).toContain("verification stamp missing");
  }, 30_000);
  it("publishes the exact artifact produced by a publication-equivalent compute", () => {
    const fixture = setup();
    prepareComputeFixture(fixture.directory);
    const run = spawnSync(process.execPath, ["--import", "tsx", "worker/scripts/compute-dependency-scenarios.ts", "--mode", "compute", "--input", resolve(fixture.directory, "capture.json"), "--publication", resolve(fixture.directory, "publication.json"), "--out-dir", fixture.directory], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).acceptedPublicationVerified).toBe(true);
    const publishedBytes = readFileSync(resolve(fixture.directory, "artifact.json"), "utf8");
    const publish = fixture.invoke();
    expect(publish.status, publish.stderr).toBe(0);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const key = db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value;
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(key as string)?.value).toBe(publishedBytes);
    } finally { db.close(); }
  }, 30_000);
});

describe("dependency scenario publication retention", () => {
  it("prunes only after both readbacks, retains the latest 24 payloads and leaves canonical rows untouched", () => {
    const fixture = setup();
    const run = fixture.invoke();
    expect(run.status, run.stderr).toBe(0);
    expect(fixture.events()).toEqual(["write-artifact", "read-artifact", "write-marker", "read-marker", "prune"]);
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
  it("protects the row the marker points to even when it changes to a row outside the retention window", () => {
    const fixture = setup();
    const run = fixture.invoke({ SCENARIO_TEST_MOVE_MARKER: `${artifactPrefix}old-00` });
    expect(run.status, run.stderr).toBe(0);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      const marker = db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value;
      expect(marker).toBe(`${artifactPrefix}old-00`);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(marker as string)?.value).toBe("old-payload-0");
      expect(db.prepare("SELECT count(*) AS count FROM cache WHERE key GLOB ?").get(`${artifactPrefix}*`)?.count).toBe(25);
    } finally { db.close(); }
  }, 30_000);
  it("logs pruning failure without failing or rolling back an already verified publication", () => {
    const fixture = setup();
    const run = fixture.invoke({ SCENARIO_TEST_FAIL_PRUNE: "1" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("pruning failed; publication remains committed");
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(fixture.publishedKey);
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(fixture.publishedKey)?.value).toBe(fixture.bytes);
      expect(db.prepare("SELECT count(*) AS count FROM cache WHERE key GLOB ?").get(`${artifactPrefix}*`)?.count).toBe(41);
    } finally { db.close(); }
  }, 30_000);
  it("never prunes or advances the marker after a failed immutable payload readback", () => {
    const fixture = setup();
    const run = fixture.invoke({ SCENARIO_TEST_BAD_READBACK: "1" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Readback mismatch");
    expect(fixture.events()).toEqual(["write-artifact", "read-artifact"]);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT value FROM cache WHERE key = ?").get(markerKey)?.value).toBe(`${artifactPrefix}old-00`);
    } finally { db.close(); }
  }, 30_000);
});
