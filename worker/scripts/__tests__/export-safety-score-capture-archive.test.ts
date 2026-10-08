import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { runSafetyScoreCaptureArchiveCli } from "../export-safety-score-capture-archive";
import { parseReportCardsAcceptedCacheExport, runReportCardsFixedInputCaptureCli } from "../capture-report-cards-fixed-input";
import { archiveObjectKey, decodeArchiveExport, parseArchiveBoundary, parseArchiveTimeBoundary, resolveArchiveBoundary, type SafetyScoreCaptureArchiveIndex } from "../lib/safety-score-capture-archive";
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

  it("lists identities with uniform 180-day lifecycle retention, not obsolete retention tiers", async () => {
    const row = indexRow();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const queryRaw = vi.fn((_sql: string) => JSON.stringify([{ success: true, results: [row] }]));
    await runSafetyScoreCaptureArchiveCli(["list", "--from", "2026-10-01", "--to", "2026-10-08", "--local"], { client: { queryRaw } });
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toEqual({ retention: "180-day-captures-lifecycle", generations: [row] });
    expect(queryRaw.mock.calls[0]![0]).toContain("ORDER BY published_at, generation_id LIMIT 1000");
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
    await runSafetyScoreCaptureArchiveCli(["list", "--gaps", "--from", "2026-10-01", "--to", "2026-10-08", "--local"], { client: { queryRaw } });
    const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
    if (!outputCall) throw new Error("Expected archive gap report output");
    const report = JSON.parse(String(outputCall[0]));
    expect(report.generations).toEqual([row]);
    expect(report.gaps).toHaveLength(1001);
    expect(report.gaps[0]).toMatchObject({ attempt_id: "missing-0000", generation_id: "missing-0000", published_at: from + 200 });
    const lastGap = report.gaps[report.gaps.length - 1];
    if (!lastGap) throw new Error("Expected a final archive gap");
    expect(lastGap.generation_id).toBe("missing-1000");
    expect(report.gapEvidence).toContain("120-day");
    expect(queryRaw.mock.calls).toHaveLength(3);
    expect(queryRaw.mock.calls.every(([sql]) => sql.startsWith("SELECT "))).toBe(true);
  });

  it("fails malformed/failed D1 reads instead of claiming an empty list", async () => {
    for (const value of [[], [{ success: false, results: [] }], [{ success: true }]]) {
      await expect(runSafetyScoreCaptureArchiveCli(["list", "--from", "2026-10-01", "--to", "2026-10-08"], {
        client: { queryRaw: () => JSON.stringify(value) },
      })).rejects.toThrow("capture-archive-query");
    }
  });

  it("rejects usage errors before remote reads", async () => {
    const queryRaw = vi.fn();
    for (const args of [["list", "--from", "2026-02-30", "--to", "2026-03-01"], ["export", "--generation", "g", "--output", "a", "--from", "2026-10-01"],
      ["boundary", "--before", "build:invalid"], ["boundary", "--before-time", "2026-10-08T12:00:00+00:00"],
      ["boundary", "--before-time", "2026-02-30T12:00:00Z"], ["boundary", "--before-time", "-1"],
      ["boundary", "--before-time", "999999999999999999999"], ["boundary", "--before", "2026-10-08", "--before-time", "2026-10-08T12:00:00Z"],
      ["export", "--generation", "g", "--output", "a", "--gaps"],
      ["list", "--from", "2026-10-01", "--from", "2026-10-02", "--to", "2026-10-08"], ["list", "extra"], ["list", "--unknown"]]) {
      await expect(runSafetyScoreCaptureArchiveCli(args, { client: { queryRaw } })).rejects.toThrow();
    }
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("capture archive boundary resolution", () => {
  const rows = [indexRow({ generation_id: "a", published_at: 100 }), indexRow({ generation_id: "b", published_at: 200 }),
    indexRow({ generation_id: "c", published_at: 300, methodology_version: "9.1", policy_digest: "d".repeat(64), evaluation_build_digest: "e".repeat(64) }),
    indexRow({ generation_id: "d", published_at: 400, methodology_version: "9.1", policy_digest: "d".repeat(64), evaluation_build_digest: "e".repeat(64) })];
  it("selects the 11:55 generation for a noon release, not previous-day 23:55 or post-release 12:05", async () => {
    const timeRows = [
      indexRow({ generation_id: "previous-day", published_at: Date.parse("2026-10-07T23:55:00Z") / 1000 }),
      indexRow({ generation_id: "pre-release", published_at: Date.parse("2026-10-08T11:55:00Z") / 1000 }),
      indexRow({ generation_id: "post-release", published_at: Date.parse("2026-10-08T12:05:00Z") / 1000 }),
    ];
    const instant = "2026-10-08T12:00:00Z";
    expect(resolveArchiveBoundary(timeRows, parseArchiveBoundary("2026-10-08"))?.generation_id).toBe("previous-day");
    for (const value of [instant, String(Date.parse(instant) / 1000)]) {
      expect(resolveArchiveBoundary(timeRows, parseArchiveTimeBoundary(value))?.generation_id).toBe("pre-release");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await runSafetyScoreCaptureArchiveCli(["boundary", "--before-time", value], {
        client: { queryRaw: () => JSON.stringify([{ success: true, results: timeRows }]) },
      });
      const outputCall = stdout.mock.calls[stdout.mock.calls.length - 1];
      if (!outputCall) throw new Error("Expected archive boundary output");
      expect(JSON.parse(String(outputCall[0])).generation_id).toBe("pre-release");
      stdout.mockRestore();
    }
    expect(resolveArchiveBoundary(timeRows, parseArchiveTimeBoundary("2026-10-08T11:55:00Z"))?.generation_id).toBe("previous-day");
  });
  it.each(["methodology:9.1", `policy:${"d".repeat(64)}`, `build:${"e".repeat(64)}`])("finds the last retained pre-change row for %s", (value) => {
    expect(resolveArchiveBoundary([...rows].reverse(), parseArchiveBoundary(value))?.generation_id).toBe("b");
  });
  it("uses a strict pre-date boundary and deterministic generation tie-breaks", () => {
    expect(resolveArchiveBoundary(rows, { dateSec: 300 })?.generation_id).toBe("b");
    expect(resolveArchiveBoundary([rows[1]!, { ...rows[1]!, generation_id: "z" }], { dateSec: 201 })?.generation_id).toBe("z");
  });
  it("does not invent a predecessor for an identity already active at the start of retained history", () => {
    expect(resolveArchiveBoundary(rows, parseArchiveBoundary("methodology:9.0"))).toBeNull();
    expect(resolveArchiveBoundary(rows, { dateSec: 100 })).toBeNull();
  });
  it("resolves the most recent transition when an identity recurs", () => {
    expect(resolveArchiveBoundary([...rows, indexRow({ generation_id: "e", published_at: 500 })], parseArchiveBoundary("methodology:9.0"))?.generation_id).toBe("d");
  });
});
