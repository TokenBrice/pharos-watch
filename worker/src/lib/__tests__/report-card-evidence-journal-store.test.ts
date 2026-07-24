import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createReportCardEvidenceJournalV1,
  type ReportCardEvidenceJournalV1Payload,
} from "@shared/lib/report-card-evidence-journal";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET,
  REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC,
  appendReportCardEvidenceJournalV1,
  loadReportCardEvidenceJournalByIdV1,
} from "../report-card-evidence-journal-store";

const DIGEST = "a".repeat(64);
const MIGRATION = readFileSync(
  join(process.cwd(), "worker/migrations/0222_report_card_evidence_journal.sql"),
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

describe("report-card evidence journal store", () => {
  it("persists immutable attempts and loads the latest bounded canonical projection", async () => {
    const { sqlite, db } = openDb();
    try {
      const first = record("reserve-run:1", 100);
      const second = record("reserve-run:2", 200, {
        admissionCode: "reserve.admission.rejected-stale",
        fallbackCode: "reserve.fallback.curated",
        contentSha256: null,
      });
      const third = record("reserve-run:3", 300);

      await expect(
        appendReportCardEvidenceJournalV1(db, [third, first, second], 400),
      ).resolves.toEqual({ accepted: 3, assets: 1 });
      await expect(
        loadReportCardEvidenceJournalByIdV1(db, ["usdc-circle"], 400),
      ).resolves.toEqual({
        "usdc-circle": [second, third],
      });

      await expect(appendReportCardEvidenceJournalV1(db, [third], 401)).resolves.toEqual({
        accepted: 1,
        assets: 1,
      });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM report_card_evidence_journal").get(),
      ).toEqual({ count: 3 });

      const { journalId: _secondJournalId, ...secondPayload } = second;
      const conflicting = createReportCardEvidenceJournalV1({
        ...secondPayload,
        admissionCode: "reserve.admission.rejected-reconciliation",
        fallbackCode: "reserve.fallback.unavailable",
      });
      await expect(
        appendReportCardEvidenceJournalV1(db, [conflicting], 402),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it("prunes by the 32-row per-asset cap and 45-day retention window", async () => {
    const { sqlite, db } = openDb();
    try {
      const capped = Array.from(
        { length: REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET + 1 },
        (_, index) => record(`reserve-cap:${String(index).padStart(2, "0")}`, 100 + index),
      );
      await appendReportCardEvidenceJournalV1(db, capped, 1_000);
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM report_card_evidence_journal").get(),
      ).toEqual({ count: REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET });
      expect(
        sqlite
          .prepare("SELECT attempt_id FROM report_card_evidence_journal ORDER BY completed_at ASC LIMIT 1")
          .get(),
      ).toEqual({ attempt_id: "reserve-cap:01" });

      const oldNow = 2_000;
      sqlite.exec("DELETE FROM report_card_evidence_journal");
      await appendReportCardEvidenceJournalV1(db, [record("reserve-old", oldNow)], oldNow);
      const currentNow = oldNow + REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC + 1;
      await expect(
        loadReportCardEvidenceJournalByIdV1(db, ["usdc-circle"], currentNow),
      ).resolves.toEqual({});
      await appendReportCardEvidenceJournalV1(
        db,
        [record("reserve-current", currentNow)],
        currentNow,
      );
      expect(
        sqlite
          .prepare("SELECT attempt_id FROM report_card_evidence_journal ORDER BY attempt_id")
          .all(),
      ).toEqual([{ attempt_id: "reserve-current" }]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects inactive assets, oversized batches, and future records before D1 writes", async () => {
    const { sqlite, db } = openDb();
    try {
      const { journalId: _inactiveJournalId, ...inactivePayload } = record("reserve-inactive", 100);
      const inactive = createReportCardEvidenceJournalV1({
        ...inactivePayload,
        assetId: "not-a-tracked-asset",
      });
      await expect(appendReportCardEvidenceJournalV1(db, [inactive], 200)).rejects.toThrow(
        /inactive asset/,
      );
      await expect(
        appendReportCardEvidenceJournalV1(
          db,
          Array.from({ length: 49 }, (_, index) => record(`reserve-batch:${index}`, 100 + index)),
          200,
        ),
      ).rejects.toThrow(/exceeds 48 records/);
      await expect(
        appendReportCardEvidenceJournalV1(db, [record("reserve-future", 201)], 200),
      ).rejects.toThrow(/future record/);
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM report_card_evidence_journal").get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});
