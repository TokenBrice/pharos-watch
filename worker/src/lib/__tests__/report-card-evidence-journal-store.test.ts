import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createReportCardEvidenceJournalV1,
  type ReportCardEvidenceJournalV1,
  type ReportCardEvidenceJournalV1Payload,
} from "@shared/lib/report-card-evidence-journal";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC,
  loadReportCardEvidenceJournalByIdV1,
} from "../report-card-evidence-journal-store";

const DIGEST = "a".repeat(64);
const MIGRATION = readFileSync(
  join(process.cwd(), "worker/src/test-helpers/migration-fixtures/0222_report_card_evidence_journal.sql"),
  "utf8",
);

function openDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function record(
  attemptId: string,
  completedAtSec: number,
  overrides: Partial<ReportCardEvidenceJournalV1Payload> = {},
) {
  return createReportCardEvidenceJournalV1({
    schemaVersion: 1,
    lane: "reserve",
    assetId: "usdc-circle",
    attemptId,
    sourceId: "fixture-reserve-adapter",
    sourceOriginClass: "onchain-observation",
    attemptCode: "reserve.collector.attempted",
    admissionCode: "reserve.admission.accepted",
    fallbackCode: "reserve.fallback.not-used",
    attemptedAtSec: completedAtSec - 1,
    completedAtSec,
    sourceTimestampSec: completedAtSec - 1,
    sourceBlock: null,
    contentSha256: DIGEST,
    sidecarMaterializationSha256: null,
    ...overrides,
  });
}

/**
 * The producer-side writer was deleted with the retired V8 pipeline; the read
 * path stays live for the V9 compute cron, so rows are seeded directly with the
 * insert the store's bounded-journal config declares.
 */
function seed(sqlite: DatabaseSync, records: readonly ReportCardEvidenceJournalV1[], recordedAtSec: number): void {
  for (const entry of records) {
    const payloadJson = JSON.stringify(entry);
    sqlite
      .prepare(
        `INSERT INTO report_card_evidence_journal (
           journal_id, schema_version, lane, asset_id, attempt_id, attempted_at,
           completed_at, source_id, attempt_code, admission_code, fallback_code,
           payload_json, payload_bytes, recorded_at
         ) VALUES (?, 1, 'reserve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.journalId,
        entry.assetId,
        entry.attemptId,
        entry.attemptedAtSec,
        entry.completedAtSec,
        entry.sourceId,
        entry.attemptCode,
        entry.admissionCode,
        entry.fallbackCode,
        payloadJson,
        new TextEncoder().encode(payloadJson).byteLength,
        recordedAtSec,
      );
  }
}

describe("report-card evidence journal store", () => {
  it("loads the latest bounded canonical projection in completion order", async () => {
    const { sqlite, db } = openDb();
    try {
      const first = record("reserve-run:1", 100);
      const second = record("reserve-run:2", 200, {
        admissionCode: "reserve.admission.rejected-stale",
        fallbackCode: "reserve.fallback.curated",
        contentSha256: null,
      });
      const third = record("reserve-run:3", 300);
      seed(sqlite, [third, first, second], 400);

      await expect(
        loadReportCardEvidenceJournalByIdV1(db, ["usdc-circle"], 400),
      ).resolves.toEqual({
        "usdc-circle": [second, third],
      });
    } finally {
      sqlite.close();
    }
  });

  it("drops rows outside the 45-day retention window", async () => {
    const { sqlite, db } = openDb();
    try {
      const oldNow = 2_000;
      seed(sqlite, [record("reserve-old", oldNow)], oldNow);
      const currentNow = oldNow + REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC + 1;
      await expect(
        loadReportCardEvidenceJournalByIdV1(db, ["usdc-circle"], currentNow),
      ).resolves.toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("rejects reads for assets outside the active registry", async () => {
    const { sqlite, db } = openDb();
    try {
      await expect(
        loadReportCardEvidenceJournalByIdV1(db, ["not-a-tracked-asset"], 200),
      ).rejects.toThrow(/inactive asset/);
    } finally {
      sqlite.close();
    }
  });
});
