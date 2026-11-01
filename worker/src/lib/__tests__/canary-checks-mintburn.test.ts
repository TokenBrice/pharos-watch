import { describe, expect, it } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  BLACKLIST_ROSTER_BASELINE_KEY,
  MINT_BURN_PUBLICATION_BASELINE_KEY,
  checkBlacklistRosterCoverage,
  checkMintBurnPublicationCoverage,
} from "../canary-checks-mintburn";
import { aggregateFlowCacheKey } from "../mint-burn-flow-cache-keys";
import {
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
} from "../blacklist-cache-keys";

const NOW = 1_775_900_000;
const MAX_AGE_SEC = 8 * 3600;

function mintBurnPayload(overrides: {
  admittedCount?: number;
  legCount?: number;
  pendingAdmissionCount?: number;
  disabledCount?: number;
  admittedPairs?: Array<[string, string]>;
  coinIds?: string[];
  score?: number | null;
  watermarkAgeSec?: number;
  watermarkUnavailableReason?: string | null;
  legs?: unknown[];
} = {}) {
  const admittedPairs = overrides.admittedPairs ?? [["usdt-tether", "ethereum"], ["usdc-circle", "ethereum"]];
  const admittedCount = overrides.admittedCount ?? admittedPairs.length;
  return {
    publication: {
      evaluatedAt: NOW - 60,
      requiredBaselineSec: 90 * 86400,
      freshnessBudgetSec: MAX_AGE_SEC,
      legsScope: "non-admitted",
      legCount: overrides.legCount ?? admittedCount,
      admittedCount,
      pendingAdmissionCount: overrides.pendingAdmissionCount ?? 0,
      disabledCount: overrides.disabledCount ?? 0,
      admittedPairs,
      legs: overrides.legs ?? [],
    },
    gauge: { score: overrides.score === undefined ? 42 : overrides.score },
    coins: (overrides.coinIds ?? [...new Set(admittedPairs.map(([id]) => id))])
      .map((stablecoinId) => ({ stablecoinId })),
    window: {
      start: NOW - 24 * 3600,
      end: NOW - 3600,
      semantics: "closed-utc-hours",
      watermark: {
        timestamp: NOW - (overrides.watermarkAgeSec ?? 3600),
        ageSec: overrides.watermarkAgeSec ?? 3600,
        maxAgeSec: MAX_AGE_SEC,
        unavailableReason: overrides.watermarkUnavailableReason ?? null,
      },
    },
  };
}

function blacklistSnapshot(overrides: {
  totalEvents?: number;
  balanceRows?: number;
  supportedConfigs?: number;
} = {}) {
  return {
    version: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
    materializedAt: NOW - 60,
    freshnessTs: NOW - 60,
    payload: {
      totalEvents: overrides.totalEvents ?? 12_345,
      freezeLedgerMeta: { totalRows: overrides.balanceRows ?? 42 },
      coverage: { counts: { supportedConfigs: overrides.supportedConfigs ?? 51 } },
      refresh: { observedAt: NOW - 60, behindConfigs: [] },
    },
  };
}

function cacheRow(key: string, value: unknown): MockTableConfig {
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: [key],
    rows: [{ key, value: JSON.stringify(value), updated_at: NOW - 60 }],
  };
}

function cacheLookup(rows: Array<{ key: string; value: unknown }>): MockTableConfig {
  return {
    match: "FROM cache WHERE key = ?",
    rows: rows.map((row) => ({
      key: row.key,
      value: JSON.stringify(row.value),
      updatedAt: NOW - 60,
      updated_at: NOW - 60,
    })),
  };
}

function dbFor(rows: Array<{ key: string; value: unknown }>) {
  return mockD1([
    cacheLookup(rows),
    { match: "INSERT INTO cache", rows: [] },
  ]);
}

describe("mint/burn publication coverage canary", () => {
  it("accepts a complete admitted publication with a fresh watermark", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{ key: aggregateFlowCacheKey(24), value: mintBurnPayload() }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "ok",
      executionStatus: "completed",
      metadata: { admittedCount: 2, admittedCoinCount: 2, coinCount: 2 },
    });
  });

  it("errors when the published admission counts disagree with the roster", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{
        key: aggregateFlowCacheKey(24),
        value: mintBurnPayload({ admittedCount: 1, pendingAdmissionCount: 1, legCount: 3 }),
      }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      severity: "error",
      error: expect.stringContaining("do not equal legCount"),
    });
  });

  it("errors when the published coin scope omits an admitted coin", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{
        key: aggregateFlowCacheKey(24),
        value: mintBurnPayload({ coinIds: ["usdt-tether"] }),
      }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("do not match admitted coin scope"),
    });
  });

  it("degrades a null gauge score for admitted coins", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{ key: aggregateFlowCacheKey(24), value: mintBurnPayload({ score: null }) }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "degraded",
      error: expect.stringContaining("gauge score is unavailable"),
    });
  });

  it("errors when the common watermark exceeds its budget", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{ key: aggregateFlowCacheKey(24), value: mintBurnPayload({ watermarkAgeSec: MAX_AGE_SEC + 1 }) }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("watermark is"),
    });
  });

  it("degrades when a single leg is quarantined from the watermark", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([{
        key: aggregateFlowCacheKey(24),
        value: mintBurnPayload({
          legs: [{
            configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
            status: "pending-admission",
            reason: "reactivation-pending",
          }],
        }),
      }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "degraded",
      metadata: { quarantinedConfigs: ["ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7"] },
    });
  });

  it("errors when the admitted roster falls below the persisted high-water baseline", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([
        {
          key: MINT_BURN_PUBLICATION_BASELINE_KEY,
          value: { admittedCount: 10, observedAt: NOW - 3600 },
        },
        {
          key: aggregateFlowCacheKey(24),
          value: mintBurnPayload({
            admittedPairs: [["usdt-tether", "ethereum"]],
            coinIds: ["usdt-tether"],
          }),
        },
      ]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("admitted roster fell from 10 to 1"),
    });
  });

  it("does not treat a missing aggregate cache as healthy coverage", async () => {
    const result = await checkMintBurnPublicationCoverage(dbFor([]), NOW);
    expect(result).toMatchObject({
      status: "degraded",
      error: "mint-burn-publication-cache-missing",
    });
  });

  it("keeps the high-water observation clock while the admitted roster does not grow", async () => {
    const db = dbFor([
      {
        key: MINT_BURN_PUBLICATION_BASELINE_KEY,
        value: { admittedCount: 2, observedAt: NOW - 3 * 3600 },
      },
      { key: aggregateFlowCacheKey(24), value: mintBurnPayload() },
    ]);

    await checkMintBurnPublicationCoverage(db, NOW);

    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === MINT_BURN_PUBLICATION_BASELINE_KEY);
    expect(JSON.parse(String(write?.binds[1]))).toEqual({ admittedCount: 2, observedAt: NOW - 3 * 3600 });
  });

  it("lets a high-water baseline expire after seven days without a new high", async () => {
    const result = await checkMintBurnPublicationCoverage(
      dbFor([
        {
          key: MINT_BURN_PUBLICATION_BASELINE_KEY,
          value: { admittedCount: 10, observedAt: NOW - 8 * 86_400 },
        },
        {
          key: aggregateFlowCacheKey(24),
          value: mintBurnPayload({
            admittedPairs: [["usdt-tether", "ethereum"]],
            coinIds: ["usdt-tether"],
          }),
        },
      ]),
      NOW,
    );
    expect(result).toMatchObject({ status: "ok" });
  });

  it("reports a failed baseline read instead of a healthy result", async () => {
    const db = mockD1([
      cacheRow(aggregateFlowCacheKey(24), mintBurnPayload()),
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [MINT_BURN_PUBLICATION_BASELINE_KEY],
        throwError: new Error("D1 unavailable"),
        rows: [],
      },
    ]);
    const result = await checkMintBurnPublicationCoverage(db, NOW);
    expect(result).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "mint-burn-publication-baseline-unavailable",
    });
  });
});

describe("blacklist roster coverage canary", () => {
  it("accepts a published summary with events, balances, and configs", async () => {
    const result = await checkBlacklistRosterCoverage(
      dbFor([{ key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, value: blacklistSnapshot() }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "ok",
      metadata: { totalEvents: 12_345, balanceRows: 42, supportedConfigs: 51 },
    });
  });

  it("errors when the published event population is empty", async () => {
    const result = await checkBlacklistRosterCoverage(
      dbFor([{ key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, value: blacklistSnapshot({ totalEvents: 0 }) }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("event population is empty"),
    });
  });

  it("errors when the freeze ledger has no current-balance rows", async () => {
    const result = await checkBlacklistRosterCoverage(
      dbFor([{ key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, value: blacklistSnapshot({ balanceRows: 0 }) }]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("no current-balance rows"),
    });
  });

  it("errors when the event population regresses below the persisted baseline", async () => {
    const result = await checkBlacklistRosterCoverage(
      dbFor([
        {
          key: BLACKLIST_ROSTER_BASELINE_KEY,
          value: { totalEvents: 10_000, observedAt: NOW - 3600 },
        },
        {
          key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
          value: blacklistSnapshot({ totalEvents: 5_000 }),
        },
      ]),
      NOW,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("event population fell from 10000 to 5000"),
    });
  });

  it("reports an unreadable snapshot as a failed observation, not healthy", async () => {
    const result = await checkBlacklistRosterCoverage(dbFor([]), NOW);
    expect(result).toMatchObject({
      status: "error",
      executionStatus: "failed",
      executionFailureReason: "blacklist-summary-snapshot-unavailable",
    });
  });

  it("keeps the high-water observation clock while the event population does not grow", async () => {
    const db = dbFor([
      {
        key: BLACKLIST_ROSTER_BASELINE_KEY,
        value: { totalEvents: 12_345, observedAt: NOW - 3 * 3600 },
      },
      { key: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, value: blacklistSnapshot() },
    ]);

    await checkBlacklistRosterCoverage(db, NOW);

    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === BLACKLIST_ROSTER_BASELINE_KEY);
    expect(JSON.parse(String(write?.binds[1]))).toEqual({ totalEvents: 12_345, observedAt: NOW - 3 * 3600 });
  });
});
