#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_SURFACE_DESCRIPTORS } from "@shared/lib/data-surface-descriptors";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC } from "@shared/lib/safety-score-capture-archive";
import { CliUsageError, parseStrictCliArgs, runDirectCli, writeFileResolved } from "../../scripts/lib/cli-args.mjs";
import { createR2MeasurementsClient } from "../../scripts/lib/r2-measurements-client";
import { CRON_RUNS_RETENTION_SEC } from "@shared/lib/retention-policy";
import { createWorkerD1Client, sqlString } from "./lib/remote-d1";
import { archiveObjectKey, decodeArchiveExport, mergeArchiveGapEvidence, parseArchiveBoundary, parseArchiveTimeBoundary, parseArchiveDate, resolveArchiveBoundary, SafetyScoreCaptureArchiveIndexSchema, SafetyScoreCaptureArchiveJournalGapSchema, SafetyScoreCaptureArchiveRecentCronEvidenceSchema, SafetyScoreCaptureArchiveRecentCronRowSchema, SafetyScorePublicationGenerationIdSchema, type ArchiveBoundary, type SafetyScoreCaptureArchiveCronGapEvidence, type SafetyScoreCaptureArchiveGap, type SafetyScoreCaptureArchiveIndex, type SafetyScoreCaptureArchiveJournalGap, type SafetyScoreCaptureArchiveRecentCronEvidence, type SafetyScoreCaptureArchiveRecentCronRow } from "./lib/safety-score-capture-archive";

const PAGE_SIZE = 1_000;
/** Authority for the producer job name; this CLI never re-types the cron vocabulary. */
const PUBLICATION_PRODUCER_JOB = DATA_SURFACE_DESCRIPTORS.reportCards.producerJob;
const GAP_EVIDENCE = "Gap generations are those with no archive index row, unioned from the 120-day accepted-attempt journal and productive compute-safety-score-v9 runs retained in cron_runs. Missing/pruned attempt rows, cron rows outside the retained cron window, index-present missing objects and unindexed R2 orphans are not detected; absent recent-cron evidence outside that window is not evidence of absence.";
const USAGE = `Usage: npx tsx worker/scripts/export-safety-score-capture-archive.ts <mode> [options]
  list --from YYYY-MM-DD --to YYYY-MM-DD [--gaps]
  boundary --before <YYYY-MM-DD|methodology:version|policy:sha256|build:sha256>
  boundary --before-time <Unix-seconds|ISO-8601-UTC-Z>
  export --generation <id> --output <file> [--cards-output <file>] [--source-dir <dir>]
Common: --database <name> (default stablecoin-db), --local (default remote), -h/--help.
Read-only D1 SELECTs. list window is [from,to), at most 180 days; best-effort archives use the external 180-day R2 lifecycle.
list --gaps unions the retained accepted-attempt journal with productive publication runs inside the retained cron window.
export reads R2 using R2_MEASUREMENTS_* credentials, or <source-dir>/<r2_key> offline.
`;

type Dependencies = {
  client?: { queryRaw(sql: string): string };
  getObject?: (key: string) => Promise<Uint8Array | null>;
  /** Retained-cron-window clock for `--gaps`; tests pin it, operators use the wall clock. */
  nowSec?: number;
};

export async function runSafetyScoreCaptureArchiveCli(argv: readonly string[], dependencies: Dependencies = {}): Promise<void> {
  const { values, positionals } = parseStrictCliArgs(argv, { allowPositionals: true, options: {
    from: { type: "string" }, to: { type: "string" }, before: { type: "string" }, "before-time": { type: "string" }, gaps: { type: "boolean" },
    generation: { type: "string" }, output: { type: "string" }, "cards-output": { type: "string" },
    "source-dir": { type: "string" }, database: { type: "string" }, local: { type: "boolean" },
  }, conflicts: [["before", "before-time"]] });
  if (values.help) { process.stdout.write(USAGE); return; }
  const mode = positionals[0];
  if (positionals.length !== 1 || !["list", "boundary", "export"].includes(mode ?? "")) throw new CliUsageError("Exactly one mode is required: list, boundary, export");
  const allowed = mode === "list" ? ["from", "to", "gaps"] : mode === "boundary" ? ["before", "before-time"] : ["generation", "output", "cards-output", "source-dir"];
  for (const key of Object.keys(values)) {
    if (!["help", "database", "local", ...allowed].includes(key)) throw new CliUsageError(`--${key} is not valid for ${mode}`);
  }
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string") throw new CliUsageError(`--${name} is required`);
    return value;
  };
  let from = 0, to = 0;
  let boundary: ArchiveBoundary | undefined;
  try {
    if (mode === "list") {
      from = parseArchiveDate(required("from")); to = parseArchiveDate(required("to"));
      if (to <= from || to - from > SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC) throw new Error("Date range must be positive and at most 180 days");
    } else if (mode === "boundary") {
      boundary = values["before-time"] !== undefined ? parseArchiveTimeBoundary(required("before-time")) : parseArchiveBoundary(required("before"));
    } else {
      required("generation"); required("output");
      if (values["cards-output"] !== undefined && resolve(required("output")) === resolve(required("cards-output"))) throw new Error("--output and --cards-output must be different files");
    }
  } catch (error) { throw new CliUsageError(error instanceof Error ? error.message : String(error)); }
  const client = dependencies.client ?? createWorkerD1Client(typeof values.database === "string" ? values.database : "stablecoin-db", values.local === true ? "local" : "remote");
  const select = <T>(sql: string, schema: { parse(value: unknown): T }): T[] => {
    const raw: unknown = JSON.parse(client.queryRaw(sql));
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error("capture-archive-query-envelope-invalid");
    const envelope = raw[0] as { success?: boolean; results?: unknown[] };
    if (envelope.success !== true || !Array.isArray(envelope.results)) throw new Error("capture-archive-query-failed");
    return envelope.results.map((row) => schema.parse(row));
  };
  if (mode === "export") {
    // SAFETY: generation is a SQL literal escaped by sqlString; table and limit are constants.
    const rows = select(`SELECT * FROM safety_score_capture_archive WHERE generation_id = ${sqlString(required("generation"))} LIMIT 1`, SafetyScoreCaptureArchiveIndexSchema);
    const row = rows[0];
    if (!row) throw new Error("capture-archive-generation-not-found");
    if (row.r2_key !== archiveObjectKey(row)) throw new Error("capture-archive-object-key-mismatch");
    const bytes = typeof values["source-dir"] === "string"
      ? readFileSync(resolve(values["source-dir"], row.r2_key))
      : await (dependencies.getObject ?? ((key: string) => createR2MeasurementsClient().get(key)))(row.r2_key);
    if (bytes === null) throw new Error("capture-archive-object-not-found");
    const exported = await decodeArchiveExport(row, bytes);
    writeFileResolved(required("output"), `${JSON.stringify(exported.cacheExport)}\n`);
    if (typeof values["cards-output"] === "string") writeFileResolved(values["cards-output"], `${JSON.stringify(exported.cards)}\n`);
    process.stdout.write(`${JSON.stringify({ generationId: row.generation_id, output: values.output, cardsOutput: values["cards-output"] ?? null })}\n`);
    return;
  }
  const rows: SafetyScoreCaptureArchiveIndex[] = [];
  let cursor = "";
  while (true) {
    // SAFETY: dates are validated UTC integer seconds; cursor clocks come from integer-guarded rows,
    // generation literals use sqlString; table, order, and page size are constants.
    const page = select(`SELECT * FROM safety_score_capture_archive WHERE 1 = 1
      ${mode === "list" ? `AND published_at >= ${from} AND published_at < ${to}` : ""} ${cursor}
      ORDER BY published_at, generation_id LIMIT ${PAGE_SIZE}`, SafetyScoreCaptureArchiveIndexSchema);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (published_at, generation_id) > (${last.published_at}, ${sqlString(last.generation_id)})`;
  }
  if (boundary) {
    const row = resolveArchiveBoundary(rows, boundary);
    if (!row) throw new Error("capture-archive-boundary-not-found: no retained predecessor");
    process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
  } else {
    let gaps: SafetyScoreCaptureArchiveGap[] = [];
    let recentCronEvidence: SafetyScoreCaptureArchiveRecentCronEvidence | undefined;
    if (values.gaps === true) {
      const journalGaps: SafetyScoreCaptureArchiveJournalGap[] = [];
      cursor = "";
      while (true) {
        // SAFETY: from/to and cursor clocks are validated integer seconds; cursor strings use sqlString.
        // Table/column names, accepted outcome, ordering and page limit are fixed, not user identifiers.
        const page = select(`SELECT a.attempt_id, a.generation_id, a.attempted_at, a.published_at,
          a.methodology_version, a.policy_digest, a.evaluation_build_digest
          FROM safety_score_publication_attempts a
          WHERE a.outcome = 'accepted' AND a.published_at >= ${from} AND a.published_at < ${to}
            AND NOT EXISTS (SELECT 1 FROM safety_score_capture_archive c WHERE c.generation_id = a.generation_id) ${cursor}
          ORDER BY a.published_at, a.generation_id, a.attempt_id LIMIT ${PAGE_SIZE}`, SafetyScoreCaptureArchiveJournalGapSchema);
        journalGaps.push(...page);
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursor = `AND (a.published_at, a.generation_id, a.attempt_id) > (${last.published_at}, ${sqlString(last.generation_id)}, ${sqlString(last.attempt_id)})`;
      }
      const observedAtSec = dependencies.nowSec ?? Math.floor(Date.now() / 1000);
      const earliestRetainedSec = observedAtSec - CRON_RUNS_RETENTION_SEC;
      const windowFrom = Math.max(from, earliestRetainedSec);
      const recentRows: SafetyScoreCaptureArchiveRecentCronRow[] = [];
      cursor = "";
      if (windowFrom < to) {
        while (true) {
          // SAFETY: window/cursor clocks are validated integer seconds, the job literal is sqlString-escaped,
          // and the JSON paths, job filter, ordering and page limit are fixed constants.
          const page = select(`SELECT x.run_id, x.started_at, x.status, x.generation_id,
            EXISTS (SELECT 1 FROM safety_score_capture_archive c WHERE c.generation_id = x.generation_id) AS archive_indexed
            FROM (
              SELECT id AS run_id, started_at, status,
                COALESCE(json_extract(metadata, '$.publication.publicationGenerationId'),
                         json_extract(metadata, '$.diagnostics.publication.publicationGenerationId')) AS generation_id
              FROM cron_runs
              WHERE job = ${sqlString(PUBLICATION_PRODUCER_JOB)} AND productive = 1
                AND started_at >= ${windowFrom} AND started_at < ${to}
            ) x
            WHERE 1 = 1 ${cursor}
            ORDER BY x.started_at, x.run_id LIMIT ${PAGE_SIZE}`, SafetyScoreCaptureArchiveRecentCronRowSchema);
          recentRows.push(...page);
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1]!;
          cursor = `AND (x.started_at, x.run_id) > (${last.started_at}, ${last.run_id})`;
        }
      }
      const cronGaps: SafetyScoreCaptureArchiveCronGapEvidence[] = [];
      let productive = 0, validGeneration = 0, archiveIndexed = 0, missingGeneration = 0, malformedGeneration = 0;
      for (const row of recentRows) {
        productive += 1;
        if (row.generation_id == null) { missingGeneration += 1; continue; }
        const generationId = SafetyScorePublicationGenerationIdSchema.safeParse(row.generation_id);
        if (!generationId.success) { malformedGeneration += 1; continue; }
        validGeneration += 1;
        if (row.archive_indexed === 1) { archiveIndexed += 1; continue; }
        cronGaps.push({ generation_id: generationId.data, run_id: row.run_id, started_at: row.started_at, status: row.status });
      }
      gaps = mergeArchiveGapEvidence(journalGaps, cronGaps);
      recentCronEvidence = SafetyScoreCaptureArchiveRecentCronEvidenceSchema.parse({
        job: PUBLICATION_PRODUCER_JOB,
        clock: "run-started-at",
        window: windowFrom < to ? { fromSec: windowFrom, toSec: to } : null,
        retention: { sec: CRON_RUNS_RETENTION_SEC, earliestRetainedSec, observedAtSec },
        coverage: from < earliestRetainedSec ? "incomplete-window" : "complete-window",
        rows: { productive, validGeneration, archiveIndexed, missingGeneration, malformedGeneration,
          gapGenerations: new Set(cronGaps.map((row) => row.generation_id)).size },
      });
    }
    process.stdout.write(`${JSON.stringify({ retention: "180-day-captures-lifecycle", generations: rows,
      ...(values.gaps === true ? { gaps, gapEvidence: GAP_EVIDENCE, recentCronEvidence } : {}),
    }, null, 2)}\n`);
  }
}

runDirectCli(import.meta.url, () => runSafetyScoreCaptureArchiveCli(process.argv.slice(2)));
