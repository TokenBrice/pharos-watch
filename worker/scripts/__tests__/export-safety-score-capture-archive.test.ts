import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { DATA_SURFACE_DESCRIPTORS } from "@shared/lib/data-surface-descriptors";
import { CRON_RUNS_RETENTION_SEC } from "../../src/cron/prune-cron-history";
import { runSafetyScoreCaptureArchiveCli } from "../export-safety-score-capture-archive";
import { parseReportCardsAcceptedCacheExport, runReportCardsFixedInputCaptureCli } from "../capture-report-cards-fixed-input";
import { archiveObjectKey, decodeArchiveExport, parseArchiveBoundary, resolveArchiveBoundary, type SafetyScoreCaptureArchiveIndex } from "../lib/safety-score-capture-archive";
import { makeV9FixedInput, v9TestClockSec } from "../../src/test-helpers/v9-fixed-input";
import { makeWorkerSafetyScoreV9Publication } from "../../src/test-helpers/report-cards-v9";
import { buildReportCardsFixedInputCacheEntry } from "../../src/test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9PublicationReplayCapture } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, serializeSafetyScoreV9Publication } from "../../src/lib/safety-score-v9/publication-codec";
import type { SafetyScoreCaptureArchiveObject } from "@shared/types/safety-score-capture-archive";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const CLOCK = v9TestClockSec();
const indexRow = (overrides: Partial<SafetyScoreCaptureArchiveIndex> = {}): SafetyScoreCaptureArchiveIndex => ({
  generation_id: "report-cards:v9:fixture-accepted", published_at: CLOCK, methodology_version: "9.0",
  policy_digest: "a".repeat(64), evaluation_build_digest: "b".repeat(64),
  r2_key: "unused", object_sha256: "c".repeat(64), object_bytes: 1, archived_at: CLOCK,
  ...overrides,
});
const PUBLICATION_PRODUCER_JOB = DATA_SURFACE_DESCRIPTORS.reportCards.producerJob;

function insertCronRun(
  sqlite: DatabaseSync,
  run: { startedAt: number; metadata: string; status?: string; productive?: number },
): void {
  sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, productive) VALUES (?,?,?,?,?,?)`)
    .run(PUBLICATION_PRODUCER_JOB, run.startedAt, 1_000, run.status ?? "ok", run.metadata, run.productive ?? 1);
}

async function archiveFixture() {
  const base = makeV9FixedInput({ assetId: "wm-m0", clockSec: CLOCK });
  const publication = makeWorkerSafetyScoreV9Publication({
    baseInputGenerationId: base.baseInputGenerationId, publishedAtSec: CLOCK,
    publicationGenerationId: "report-cards:v9:fixture-accepted",
  });
  const baseEntry = await buildReportCardsFixedInputCacheEntry(base);
  const delta = await buildSafetyScoreV9PublicationReplayCapture(publication, base, null);
  const object: SafetyScoreCaptureArchiveObject = {
    schemaVersion: 1, generationId: publication.publicationGenerationId, publishedAt: CLOCK,
    methodologyVersion: publication.policyVersion, policyDigest: publication.policy.semanticDigest,
    evaluationBuildDigest: publication.evaluationBuildDigest,
    base: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, value: baseEntry.value, updatedAt: CLOCK },
    delta: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, value: delta.value, updatedAt: CLOCK },
    cards: { key: "report-cards:v9", value: await serializeSafetyScoreV9Publication(publication), updatedAt: CLOCK },
  };
  const bytes = Buffer.from(JSON.stringify(object));
  const row = indexRow({ methodology_version: object.methodologyVersion, policy_digest: object.policyDigest,
    evaluation_build_digest: object.evaluationBuildDigest, object_sha256: createHash("sha256").update(bytes).digest("hex"), object_bytes: bytes.length });
  row.r2_key = archiveObjectKey(row);
  return { object, bytes, row, base, publication };
}

afterEach(() => vi.restoreAllMocks());

describe("Safety Score capture archive export", () => {
  it("round-trips exact rows through the capture CLI parser and full envelope restoration, including offline export", async () => {
    const fixture = await archiveFixture();
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-archive-export-"));
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const source = resolve(dir, "objects", fixture.row.r2_key);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, fixture.bytes);
      const output = resolve(dir, "accepted.raw.json"), cards = resolve(dir, "cards.json"), capture = resolve(dir, "capture.json");
      const client = { queryRaw: vi.fn((_sql: string) => JSON.stringify([{ success: true, results: [fixture.row] }])) };
      const getObject = vi.fn();
      await runSafetyScoreCaptureArchiveCli(["export", "--local", "--source-dir", resolve(dir, "objects"), "--generation", fixture.row.generation_id,
        "--output", output, "--cards-output", cards], { client, getObject });
      const raw = JSON.parse(readFileSync(output, "utf8"));
      expect(raw[0].results).toHaveLength(2);
      expect(raw[0].results.map((row: { value: string }) => row.value)).toEqual([fixture.object.base.value, fixture.object.delta.value]);
      const parsed = await parseReportCardsAcceptedCacheExport(raw);
      expect(parsed.publicationGenerationId).toBe(fixture.row.generation_id);
      expect(parsed.fixedInput.baseInputGenerationId).toBe(fixture.base.baseInputGenerationId);
      await runReportCardsFixedInputCaptureCli(["--accepted-cache-export", output, "--output", capture]);
      expect(JSON.parse(readFileSync(capture, "utf8"))).toMatchObject({ kind: "safety-score-v9-accepted-publication-capture", publicationGenerationId: fixture.row.generation_id,
        fixedInput: { baseInputGenerationId: fixture.base.baseInputGenerationId, clockSec: CLOCK }, transferMaterialityGeneration: null });
      expect(JSON.parse(readFileSync(cards, "utf8"))).toEqual(fixture.publication);
      expect(getObject).not.toHaveBeenCalled();
      expect(client.queryRaw.mock.calls[0]![0]).toMatch(/^SELECT /u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a checksum mismatch without writing either output", async () => {
    const fixture = await archiveFixture();
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-archive-bad-sha-"));
    try {
      const output = resolve(dir, "raw.json"), cards = resolve(dir, "cards.json");
      await expect(runSafetyScoreCaptureArchiveCli(["export", "--generation", fixture.row.generation_id, "--output", output, "--cards-output", cards], {
        client: { queryRaw: () => JSON.stringify([{ success: true, results: [fixture.row] }]) },
        getObject: async () => Buffer.concat([fixture.bytes, Buffer.from(" ")]),
      })).rejects.toThrow("sha256-mismatch");
      expect(existsSync(output)).toBe(false); expect(existsSync(cards)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects an incorrect indexed byte count even when the exact object SHA matches", async () => {
    const fixture = await archiveFixture();
    await expect(decodeArchiveExport({ ...fixture.row, object_bytes: fixture.bytes.length + 1 }, fixture.bytes)).rejects.toThrow("capture-archive-byte-length-mismatch");
  });

  it("rejects index identity drift and mismatched retention clocks even with valid object SHA", async () => {
    const fixture = await archiveFixture();
    await expect(decodeArchiveExport({ ...fixture.row, policy_digest: "0".repeat(64) }, fixture.bytes)).rejects.toThrow("index-identity-mismatch");
    fixture.object.delta.updatedAt++;
    const bytes = Buffer.from(JSON.stringify(fixture.object));
    await expect(decodeArchiveExport({ ...fixture.row, object_bytes: bytes.length, object_sha256: createHash("sha256").update(bytes).digest("hex") }, bytes)).rejects.toThrow("retention-clock-mismatch");
  });

  it("reports accepted-attempt index gaps using real SQL, excluding held, archived and out-of-window rows across pages", async () => {
    const { sqlite } = fixtures.open();
    const from = Date.parse("2026-10-01T00:00:00Z") / 1000, to = Date.parse("2026-10-08T00:00:00Z") / 1000;
    const row = indexRow({ generation_id: "archived", published_at: from + 100 });
    sqlite.prepare(`INSERT INTO safety_score_capture_archive
      (generation_id,published_at,methodology_version,policy_digest,evaluation_build_digest,r2_key,object_sha256,object_bytes,archived_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(row.generation_id, row.published_at, row.methodology_version, row.policy_digest, row.evaluation_build_digest,
        row.r2_key, row.object_sha256, row.object_bytes, row.archived_at);
    const insert = sqlite.prepare(`INSERT INTO safety_score_publication_attempts
      (attempt_id,generation_id,attempted_at,published_at,outcome,hold_reason_codes_json,methodology_version,
       policy_digest,evaluation_build_digest,input_lineage_json,changed_cards,unchanged_cards)
      VALUES (?,?,?,?,?,'[]',?,?,?,'{}',?,?)`);
    for (const [id, time, outcome] of [["archived", from + 100, "accepted"], ["held", from + 100, "held"],
      ["before", from - 1, "accepted"], ["after", to, "accepted"]] as const) {
      insert.run(id, id, time, time, outcome, row.methodology_version, row.policy_digest, row.evaluation_build_digest,
        outcome === "accepted" ? 0 : null, outcome === "accepted" ? 1 : null);
    }
    for (let index = 0; index < 1001; index++) {
      const id = `missing-${String(index).padStart(4, "0")}`;
      // Unchanged accepted publications have attempts but no change-only journal cards.
      insert.run(id, id, from + 200, from + 200, "accepted", row.methodology_version, row.policy_digest, row.evaluation_build_digest, 0, 1);
    }
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((sql: string) => JSON.stringify([{ success: true, results: sqlite.prepare(sql).all() }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-10-01", "--to", "2026-10-08", "--local"],
      { client: { queryRaw }, nowSec: from + 3_600 });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.generations).toEqual([row]);
    expect(report.gaps).toHaveLength(1001);
    expect(report.gaps[0]).toMatchObject({
      generation_id: "missing-0000", evidence_sources: ["accepted-attempt-journal"],
      journal: { attempt_id: "missing-0000", published_at: from + 200 }, recent_cron_runs: [],
    });
    const lastGap = report.gaps[report.gaps.length - 1];
    if (!lastGap) throw new Error("Expected a final archive gap");
    expect(lastGap.generation_id).toBe("missing-1000");
    expect(report.gapEvidence).toContain("120-day");
    // One index page, two journal pages, and one empty retained-cron page.
    expect(queryRaw.mock.calls).toHaveLength(4);
    expect(queryRaw.mock.calls.every(([sql]) => sql.startsWith("SELECT "))).toBe(true);
    expect(report.recentCronEvidence).toMatchObject({
      job: PUBLICATION_PRODUCER_JOB, clock: "run-started-at", window: { fromSec: from, toSec: to }, coverage: "incomplete-window",
      retention: { sec: CRON_RUNS_RETENTION_SEC, earliestRetainedSec: from + 3_600 - CRON_RUNS_RETENTION_SEC, observedAtSec: from + 3_600 },
      rows: { productive: 0, validGeneration: 0, archiveIndexed: 0, missingGeneration: 0, malformedGeneration: 0, gapGenerations: 0 },
    });
  });

  it("surfaces a productive publication run missing from both the attempt journal and the archive index", async () => {
    const { sqlite } = fixtures.open();
    const from = Date.parse("2026-10-01T00:00:00Z") / 1000, to = Date.parse("2026-10-08T00:00:00Z") / 1000;
    const generationId = `report-cards:v9:v1:${"d".repeat(64)}`;
    insertCronRun(sqlite, { startedAt: from + 300, metadata: JSON.stringify({ publication: { publicationGenerationId: generationId } }) });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((sql: string) => JSON.stringify([{ success: true, results: sqlite.prepare(sql).all() }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-10-01", "--to", "2026-10-08", "--local"],
      { client: { queryRaw }, nowSec: from + 3_600 });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.gaps).toEqual([{
      generation_id: generationId, evidence_sources: ["recent-cron"], journal: null,
      recent_cron_runs: [{ run_id: 1, started_at: from + 300, status: "ok" }],
    }]);
    expect(report.recentCronEvidence.rows).toEqual({
      productive: 1, validGeneration: 1, archiveIndexed: 0, missingGeneration: 0, malformedGeneration: 0, gapGenerations: 1,
    });
  });

  it("deduplicates one generation reported by both evidence sources and by two productive runs", async () => {
    const { sqlite } = fixtures.open();
    const from = Date.parse("2026-10-01T00:00:00Z") / 1000, to = Date.parse("2026-10-08T00:00:00Z") / 1000;
    const generationId = `report-cards:v9:v1:${"e".repeat(64)}`;
    const row = indexRow({ generation_id: generationId, published_at: from + 200 });
    sqlite.prepare(`INSERT INTO safety_score_publication_attempts
      (attempt_id,generation_id,attempted_at,published_at,outcome,hold_reason_codes_json,methodology_version,
       policy_digest,evaluation_build_digest,input_lineage_json,changed_cards,unchanged_cards)
      VALUES (?,?,?,?,'accepted','[]',?,?,?,'{}',0,1)`)
      .run("attempt-a", generationId, row.published_at, row.published_at, row.methodology_version, row.policy_digest, row.evaluation_build_digest);
    const metadata = JSON.stringify({ publication: { publicationGenerationId: generationId } });
    insertCronRun(sqlite, { startedAt: from + 210, metadata });
    insertCronRun(sqlite, { startedAt: from + 240, metadata, status: "degraded" });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((sql: string) => JSON.stringify([{ success: true, results: sqlite.prepare(sql).all() }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-10-01", "--to", "2026-10-08", "--local"],
      { client: { queryRaw }, nowSec: from + 3_600 });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({
      generation_id: generationId, evidence_sources: ["accepted-attempt-journal", "recent-cron"],
      journal: { attempt_id: "attempt-a", published_at: from + 200 },
      recent_cron_runs: [{ run_id: 1, started_at: from + 210, status: "ok" }, { run_id: 2, started_at: from + 240, status: "degraded" }],
    });
    expect(report.recentCronEvidence.rows).toMatchObject({ productive: 2, validGeneration: 2, gapGenerations: 1 });
  });

  it("excludes missing and malformed generation ids with explicit accounting and ignores indexed or non-productive runs", async () => {
    const { sqlite } = fixtures.open();
    const from = Date.parse("2026-10-01T00:00:00Z") / 1000, to = Date.parse("2026-10-08T00:00:00Z") / 1000;
    const archived = indexRow({ generation_id: `report-cards:v9:v1:${"1".repeat(64)}`, published_at: from + 400 });
    sqlite.prepare(`INSERT INTO safety_score_capture_archive
      (generation_id,published_at,methodology_version,policy_digest,evaluation_build_digest,r2_key,object_sha256,object_bytes,archived_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(archived.generation_id, archived.published_at, archived.methodology_version, archived.policy_digest,
        archived.evaluation_build_digest, archived.r2_key, archived.object_sha256, archived.object_bytes, archived.archived_at);
    const gapGeneration = `report-cards:v9:v1:${"2".repeat(64)}`;
    insertCronRun(sqlite, { startedAt: from + 100, metadata: JSON.stringify({ sourceGenerationId: "report-cards:10.22:1" }) });
    insertCronRun(sqlite, { startedAt: from + 200, metadata: JSON.stringify({ publication: { publicationGenerationId: "report-cards:v9:legacy-clock" } }) });
    insertCronRun(sqlite, { startedAt: from + 400, metadata: JSON.stringify({ publication: { publicationGenerationId: archived.generation_id } }) });
    insertCronRun(sqlite, { startedAt: from + 500, metadata: JSON.stringify({ publication: { publicationGenerationId: gapGeneration } }) });
    insertCronRun(sqlite, { startedAt: to, metadata: JSON.stringify({ publication: { publicationGenerationId: `report-cards:v9:v1:${"3".repeat(64)}` } }) });
    insertCronRun(sqlite, { startedAt: from + 600, productive: 0, status: "skipped_neutral",
      metadata: JSON.stringify({ publication: { publicationGenerationId: `report-cards:v9:v1:${"4".repeat(64)}` } }) });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((sql: string) => JSON.stringify([{ success: true, results: sqlite.prepare(sql).all() }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-10-01", "--to", "2026-10-08", "--local"],
      { client: { queryRaw }, nowSec: from + 3_600 });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.gaps.map((gap: { generation_id: string }) => gap.generation_id)).toEqual([gapGeneration]);
    expect(report.recentCronEvidence.rows).toEqual({
      productive: 4, validGeneration: 2, archiveIndexed: 1, missingGeneration: 1, malformedGeneration: 1, gapGenerations: 1,
    });
  });

  it("reports absent older cron evidence instead of an empty complete window", async () => {
    const { sqlite } = fixtures.open();
    const observedAtSec = Date.parse("2026-10-18T00:00:00Z") / 1000;
    insertCronRun(sqlite, { startedAt: observedAtSec - 600,
      metadata: JSON.stringify({ publication: { publicationGenerationId: `report-cards:v9:v1:${"a".repeat(64)}` } }) });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((sql: string) => JSON.stringify([{ success: true, results: sqlite.prepare(sql).all() }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-01-01", "--to", "2026-01-08", "--local"],
      { client: { queryRaw }, nowSec: observedAtSec });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.gaps).toEqual([]);
    expect(report.recentCronEvidence).toMatchObject({
      window: null, coverage: "incomplete-window",
      retention: { observedAtSec, earliestRetainedSec: observedAtSec - CRON_RUNS_RETENTION_SEC },
      rows: { productive: 0, gapGenerations: 0 },
    });
    // Index page plus journal page only: an entirely retained-out window is never queried.
    expect(queryRaw.mock.calls).toHaveLength(2);
    expect(report.gapEvidence).toContain("not evidence of absence");
  });

  it("fails malformed/failed D1 reads instead of claiming an empty list", async () => {
    for (const value of [[], [{ success: false, results: [] }], [{ success: true }]]) {
      await expect(runSafetyScoreCaptureArchiveCli(["list", "--from", "2026-10-01", "--to", "2026-10-08"], {
        client: { queryRaw: () => JSON.stringify(value) },
      })).rejects.toThrow("capture-archive-query");
    }
  });

});

describe("capture archive boundary resolution", () => {
  const rows = [indexRow({ generation_id: "a", published_at: 100 }), indexRow({ generation_id: "b", published_at: 200 }),
    indexRow({ generation_id: "c", published_at: 300, methodology_version: "9.1", policy_digest: "d".repeat(64), evaluation_build_digest: "e".repeat(64) }),
    indexRow({ generation_id: "d", published_at: 400, methodology_version: "9.1", policy_digest: "d".repeat(64), evaluation_build_digest: "e".repeat(64) })];

  it("does not invent a predecessor for an identity already active at the start of retained history", () => {
    expect(resolveArchiveBoundary(rows, parseArchiveBoundary("methodology:9.0"))).toBeNull();
    expect(resolveArchiveBoundary(rows, { dateSec: 100 })).toBeNull();
  });
});
