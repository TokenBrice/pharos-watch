import { describe, expect, it } from "vitest";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { checkSupplyHistoryDailyCoverage } from "../canary-checks-supply";
import {
  buildSupplySnapshotCompletionMarker,
  buildSupplySnapshotCoverageExpectation,
} from "../supply-snapshot-completion";

const NOW = 1_790_000_000;
const TODAY = startOfUtcDaySec(new Date(NOW * 1000));
const IDS = Array.from({ length: 100 }, (_, index) => `coin-${String(index).padStart(3, "0")}`);

function marker(overrides: {
  snapshotDate?: number;
  ids?: string[];
  unavailableActiveIds?: string[];
} = {}) {
  const ids = overrides.ids ?? IDS;
  return {
    ...buildSupplySnapshotCompletionMarker({
      snapshotDate: overrides.snapshotDate ?? TODAY,
      coverage: buildSupplySnapshotCoverageExpectation(ids, []),
      accountedActiveCount: ids.length,
      ownedRowIds: ids,
      missingActiveIds: [],
      unavailableActiveIds: overrides.unavailableActiveIds ?? [],
    }),
    writtenRows: ids.length,
  };
}

function db(value: ReturnType<typeof marker> | null, persistedRows: number) {
  return mockD1([
    {
      match: "FROM cache WHERE key = ?",
      rows: value == null ? [] : [{
        key: "snapshot-supply:last-write",
        value: JSON.stringify(value),
        updated_at: NOW - 60,
      }],
    },
    {
      match: "SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?",
      first: { count: persistedRows },
      rows: [],
    },
  ]);
}

describe("supply history daily coverage canary", () => {
  it("passes when the marker's written proof and all active supply are present", async () => {
    expect(await checkSupplyHistoryDailyCoverage(db(marker(), IDS.length), NOW)).toMatchObject({
      status: "ok",
      executionStatus: "completed",
      metadata: {
        expectedDate: TODAY,
        snapshotDate: TODAY,
        writtenRows: IDS.length,
        persistedRows: IDS.length,
        unavailableCount: 0,
        band: "none",
      },
    });
  });

  it("degrades when today's marker is missing", async () => {
    expect(await checkSupplyHistoryDailyCoverage(db(null, 0), NOW)).toMatchObject({
      status: "degraded",
      error: "supply-snapshot-marker-missing",
    });
  });

  it("degrades when the marker is from an earlier day", async () => {
    expect(await checkSupplyHistoryDailyCoverage(db(marker({ snapshotDate: TODAY - 86_400 }), IDS.length), NOW))
      .toMatchObject({ status: "degraded", error: expect.stringContaining("supply snapshot is from") });
  });

  it("errors when persisted rows are fewer than the marker's written proof", async () => {
    expect(await checkSupplyHistoryDailyCoverage(db(marker(), IDS.length - 1), NOW)).toMatchObject({
      status: "error",
      error: `supply_history has ${IDS.length - 1} of ${IDS.length} written rows for the current snapshot`,
    });
  });

  it.each([
    { unavailable: 1, status: "degraded", band: "elevated" },
    { unavailable: 11, status: "error", band: "systemic" },
  ])("bands unavailable supply ($unavailable/100 as $band)", async ({ unavailable, status, band }) => {
    const report = await checkSupplyHistoryDailyCoverage(
      db(marker({ unavailableActiveIds: IDS.slice(0, unavailable) }), IDS.length),
      NOW,
    );
    expect(report).toMatchObject({
      status,
      metadata: { unavailableCount: unavailable, band },
    });
  });

  it("degrades when the marker predates the unavailable-supply evidence field", async () => {
    const legacy = marker();
    delete (legacy as { unavailableActiveIds?: string[] }).unavailableActiveIds;
    expect(await checkSupplyHistoryDailyCoverage(db(legacy, IDS.length), NOW)).toMatchObject({
      status: "degraded",
      error: "supply-snapshot-unavailable-evidence-missing",
    });
  });

  it("fails closed when the row-count read is unavailable", async () => {
    const database = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [{ key: "snapshot-supply:last-write", value: JSON.stringify(marker()), updated_at: NOW - 60 }],
      },
      {
        match: "SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?",
        first: { count: null },
        rows: [],
      },
    ]);
    expect(await checkSupplyHistoryDailyCoverage(database, NOW)).toMatchObject({
      status: "error",
      executionStatus: "failed",
      error: "supply-history-row-count-unavailable",
    });
  });
});
