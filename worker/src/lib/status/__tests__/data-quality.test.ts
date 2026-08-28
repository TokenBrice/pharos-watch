import { describe, expect, it } from "vitest";
import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { getCirculatingRaw } from "@shared/lib/supply";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { BlacklistGapMetrics } from "../../blacklist-gaps";
import { getDataQuality } from "../data-quality";

const NOW = 1_775_890_000;

const emptyBlacklistMetrics: BlacklistGapMetrics = {
  totalEvents: 0,
  missingAmounts: 0,
  recentMissingAmounts: 0,
  recentWindowSec: BLACKLIST_RECENT_WINDOW_SEC,
  missingRatio: 0,
  unrecoverableMissingAmounts: 0,
  oldestRecoverableAgeSec: null,
  neverAttemptedCount: 0,
  repeatedFailureCount: 0,
  statusDistribution: {},
  sourceDistribution: {},
};

function stablecoinsPayload(): string {
  return JSON.stringify({
    peggedAssets: [
      {
        id: "usdt-tether",
        symbol: "USDT",
        price: 1,
        circulating: { peggedUSD: 100_000_000, peggedEUR: 100_000_000 },
      },
      {
        id: "null-bucket",
        symbol: "NULL",
        price: 1,
        circulating: { peggedUSD: null },
      },
      {
        id: "zero-bucket",
        symbol: "ZERO",
        price: 1,
        circulating: { peggedUSD: 0 },
      },
    ],
  });
}

describe("getDataQuality repair debt", () => {
  it("uses the DDR cache count when dual-written repair tasks are partial", async () => {
    const ddrDebt = {
      checkedAt: NOW - 300,
      count: 3,
      events: [
        { eventId: 101, reason: "incident-conflict" },
        { eventId: 102, reason: "incident-conflict" },
        { eventId: 103, reason: "incident-conflict" },
      ],
      eventsTruncated: false,
    };
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: stablecoinsPayload(),
            updated_at: NOW - 60,
          },
          {
            key: "ddr:repair-debt:v1",
            value: JSON.stringify(ddrDebt),
            updated_at: NOW - 300,
          },
        ],
      },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [],
        first: { cnt: 0 },
      },
      {
        match: "FROM worker_repair_tasks",
        rows: [
          {
            kind: "ddr-repair-required-event",
            open_count: 1,
            oldest_created_at: NOW - 120,
            next_attempt_at: null,
          },
        ],
      },
      {
        match: "MAX(updated_at) as latest",
        rows: [],
        first: { latest: NOW - 60, tracked: 3 },
      },
      {
        match: "HAVING latest_update < ?",
        rows: [],
        first: { cnt: 0 },
      },
      {
        match: "SELECT stablecoin_id, SUM(supply) as total_supply",
        rows: [
          { stablecoin_id: "usdt-tether", total_supply: 100_000_000 },
          { stablecoin_id: "null-bucket", total_supply: 100 },
          { stablecoin_id: "zero-bucket", total_supply: 100 },
        ],
      },
      {
        match: "blacklist-reconciliation-status-latest",
        rows: [
          {
            run_id: "run-1",
            manifest_id: "night-watch-usdt-tron-2026-07-09",
            manifest_sha256: "abc",
            status: "verified",
            time_travel_bookmark: "bookmark",
            expected_event_count: 86,
            present_event_count: 86,
            missing_event_count: 0,
            duplicate_identity_count: 0,
            expected_destroyed_amount_raw: 8_874_287_612_325,
            actual_destroyed_amount_raw: 8_874_287_612_325,
            balance_replay_expected_count: 70,
            balance_replay_matching_count: 70,
            unresolved_manifest_gap_count: 0,
            tron_cursor_after: 200,
            tron_safe_head: 200,
            arbitrum_min_cursor: 500,
            arbitrum_min_safe_head: 500,
            arbitrum_expected_config_count: 7,
            arbitrum_at_safe_head_count: 7,
            started_at: 100,
            completed_at: 200,
          },
        ],
      },
    ]);

    const quality = await getDataQuality(db, NOW, { blacklistMetrics: emptyBlacklistMetrics });

    expect(quality.ddrRepairDebtStatus).toBe("present");
    expect(quality.ddrRepairDebtCount).toBe(3);
    expect(quality.repairDebt).toMatchObject({
      status: "present",
      openCount: 3,
      source: "worker-repair-tasks+ddr-cache-fallback",
      byKind: {
        "ddr-repair-required-event": {
          openCount: 3,
          oldestAgeSec: 300,
        },
      },
    });
    expect(quality.blacklistReconciliation).toMatchObject({
      status: "verified",
      expectedEventCount: 86,
      presentEventCount: 86,
      unresolvedManifestGapCount: 0,
      tronAtSafeHead: true,
      arbitrumAtSafeHead: true,
    });
    expect(quality.onchainSupplyDivergences).toBe(1);
    expect(quality.onchainDivergenceRatio).toBe(1 / 3);

    const circulatingFixtures = [
      [{ peggedUSD: 100, peggedEUR: 25 }, 125],
      [{ peggedUSD: null as unknown as number }, 0],
      [{ peggedUSD: Number.NaN }, 0],
      [{ peggedUSD: 0 }, 0],
    ] as const;
    for (const [circulating, expected] of circulatingFixtures) {
      expect(getCirculatingRaw({ circulating })).toBe(expected);
    }
  });
});
