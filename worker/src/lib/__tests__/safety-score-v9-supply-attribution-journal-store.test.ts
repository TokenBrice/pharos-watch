import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createSupplyAttributionJournalV1,
  type SupplyAttributionJournalV1Payload,
} from "@shared/types/safety-score-v9-supply-attribution-journal";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  SUPPLY_ATTRIBUTION_JOURNAL_STORE_MAX_ROWS_PER_ASSET,
  SUPPLY_ATTRIBUTION_JOURNAL_STORE_RETENTION_SEC,
  appendSupplyAttributionJournalV1,
  loadSupplyAttributionJournalByIdV1,
} from "../safety-score-v9-supply-attribution-journal-store";

const DIGEST = "a".repeat(64);
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "worker/migrations/0223_safety_score_v9_supply_attribution_journal.sql",
  ),
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
  overrides: Partial<SupplyAttributionJournalV1Payload> = {},
) {
  return createSupplyAttributionJournalV1({
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: "wm-m0",
    attemptId,
    sourceId: "wm.reviewed-deployment-unit-partition.v1",
    sourceOriginClass: "onchain-observation",
    baseInputGenerationId: `report-cards-input:v1:${DIGEST}`,
    sourceGeneration: "report-cards:v8:fixture",
    registryFingerprint: DIGEST,
    routeInventoryDigest: DIGEST,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode: "supply-attribution.admission.accepted",
    fallbackCode: "supply-attribution.fallback.not-used",
    attemptedAtSec: completedAtSec - 1,
    completedAtSec,
    scoringClockSec: completedAtSec,
    sourceObservedAtSec: completedAtSec - 1,
    failedRouteId: null,
    contentSha256: DIGEST,
    ...overrides,
  });
}

describe("Safety Score V9 supply attribution journal store", () => {
  it("persists immutable attempts and loads only the latest bounded prior rows", async () => {
    const { sqlite, db } = openDb();
    try {
      const first = record("supply-attribution:1", 100);
      const second = record("supply-attribution:2", 200, {
        admissionCode: "supply-attribution.admission.rejected-stale",
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        sourceObservedAtSec: null,
        failedRouteId: null,
        contentSha256: null,
      });
      const third = record("supply-attribution:3", 300);
      await expect(
        appendSupplyAttributionJournalV1(db, [third, first, second], 400),
      ).resolves.toEqual({ accepted: 3, assets: 1 });
      await expect(
        loadSupplyAttributionJournalByIdV1(db, ["wm-m0"], 250),
      ).resolves.toEqual({ "wm-m0": [first, second] });
      await expect(
        appendSupplyAttributionJournalV1(db, [third], 401),
      ).resolves.toEqual({ accepted: 1, assets: 1 });
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM safety_score_v9_supply_attribution_journal",
          )
          .get(),
      ).toEqual({ count: 3 });

      const { journalId: _journalId, ...secondPayload } = second;
      const conflicting = createSupplyAttributionJournalV1({
        ...secondPayload,
        admissionCode:
          "supply-attribution.admission.rejected-reconciliation",
      });
      await expect(
        appendSupplyAttributionJournalV1(db, [conflicting], 402),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it("prunes by per-asset count and retention", async () => {
    const { sqlite, db } = openDb();
    try {
      const capped = Array.from(
        { length: SUPPLY_ATTRIBUTION_JOURNAL_STORE_MAX_ROWS_PER_ASSET + 1 },
        (_, index) =>
          record(
            `supply-attribution:cap:${String(index).padStart(2, "0")}`,
            100 + index,
          ),
      );
      await appendSupplyAttributionJournalV1(db, capped, 1_000);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM safety_score_v9_supply_attribution_journal",
          )
          .get(),
      ).toEqual({
        count: SUPPLY_ATTRIBUTION_JOURNAL_STORE_MAX_ROWS_PER_ASSET,
      });

      const currentNow =
        1_000 + SUPPLY_ATTRIBUTION_JOURNAL_STORE_RETENTION_SEC + 1;
      await appendSupplyAttributionJournalV1(
        db,
        [record("supply-attribution:current", currentNow)],
        currentNow,
      );
      expect(
        sqlite
          .prepare(
            "SELECT attempt_id FROM safety_score_v9_supply_attribution_journal",
          )
          .all(),
      ).toEqual([{ attempt_id: "supply-attribution:current" }]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects inactive assets and future records before writing", async () => {
    const { sqlite, db } = openDb();
    try {
      const { journalId: _journalId, ...payload } = record(
        "supply-attribution:inactive",
        100,
      );
      const inactive = createSupplyAttributionJournalV1({
        ...payload,
        assetId: "not-a-tracked-asset",
      });
      await expect(
        appendSupplyAttributionJournalV1(db, [inactive], 200),
      ).rejects.toThrow(/inactive asset/);
      await expect(
        appendSupplyAttributionJournalV1(
          db,
          [record("supply-attribution:future", 201)],
          200,
        ),
      ).rejects.toThrow(/future record/);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM safety_score_v9_supply_attribution_journal",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});
