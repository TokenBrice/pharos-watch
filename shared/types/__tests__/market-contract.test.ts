import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLACKLIST_STABLECOINS,
  BlacklistSummaryResponseSchema,
  DepegEventSchema,
  DepegEventStoredSnapshotSchema,
  DepegPendingIncidentSchema,
} from "../market";

const baseEvent = {
  id: 1,
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  pegType: "peggedUSD",
  direction: "below" as const,
  peakDeviationBps: 120,
  startedAt: 1_700_000_000,
  endedAt: 1_700_086_400,
  startPrice: 1,
  peakPrice: 0.98,
  recoveryPrice: 1,
  pegReference: 1,
  source: "live" as const,
};

const baseIncident = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  direction: "below" as const,
  firstSeenAt: 1_700_000_000,
  lastSeenAt: 1_700_003_600,
  firstSeenBps: 40,
  lastSeenBps: 55,
  peakSeenBps: 60,
  reason: "threshold-crossing",
  ageSec: 3_600,
  expiresAt: 1_700_007_200,
  availableConfirmationCategories: [],
  missingConfirmationCategories: [],
};

describe("depeg chronology contract", () => {
  it("accepts a well-ordered closed event and a still-open incident", () => {
    expect(DepegEventSchema.safeParse(baseEvent).success).toBe(true);
    expect(DepegPendingIncidentSchema.safeParse(baseIncident).success).toBe(true);
  });

  it("rejects a reversed event timeline instead of publishing a negative duration", () => {
    const reversed = DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt - 1 });
    expect(reversed.success).toBe(false);
    expect(reversed.error!.issues.some((issue) => issue.path.includes("endedAt"))).toBe(true);

    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: null }).success).toBe(true);
  });

  it("rejects reversed pending-incident windows", () => {
    expect(
      DepegPendingIncidentSchema.safeParse({ ...baseIncident, lastSeenAt: baseIncident.firstSeenAt - 1 }).success,
    ).toBe(false);
    expect(
      DepegPendingIncidentSchema.safeParse({ ...baseIncident, expiresAt: baseIncident.lastSeenAt - 1 }).success,
    ).toBe(false);
    expect(
      DepegPendingIncidentSchema.safeParse({
        ...baseIncident,
        lastSeenAt: baseIncident.firstSeenAt,
        expiresAt: baseIncident.lastSeenAt,
      }).success,
    ).toBe(true);
  });

  it("rejects non-integer or negative event timestamps", () => {
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: 1_700_000_000.5 }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: -1 }).success).toBe(false);
  });

  it("parses every current build-time archive row under the chronology contract", () => {
    const archiveDir = join("data", "depeg-events");
    expect(existsSync(archiveDir)).toBe(true);
    const files = readdirSync(archiveDir).filter((name) => name.endsWith(".json") && name !== "index.json");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const parsed = DepegEventStoredSnapshotSchema.safeParse(
        JSON.parse(readFileSync(join(archiveDir, name), "utf8")),
      );
      expect(parsed.success, name).toBe(true);
    }
  });
});

describe("blacklist summary cache contract", () => {
  it("parses a cache payload whose quarterly record still carries only pre-addition symbols", () => {
    const body = {
      stats: {
        usdcBlacklisted: 1,
        usdtBlacklisted: 2,
        goldBlacklisted: 3,
        frozenAddresses: 4,
        destroyedTotal: 5,
        activeAddressCount: 6,
        activeFrozenTotal: 7,
        activeAmountGapCount: 8,
        trackedAddressCount: 9,
        trackedFrozenTotal: 10,
        trackedAmountGapCount: 11,
        recentCount: 12,
        recentCount24h: 13,
        recentFreezeCount24h: 0,
        recentFreezeCount7d: 0,
        recentFreezeAmount24hUsd: 0,
        recentFreezeAmount7dUsd: 0,
        recoverableGapCount: 14,
        perCoinBlacklistCounts: {},
        perCoinTotalEvents: {},
        perCoinFrozenAddressCount: {},
        perCoinFrozenTotal: {},
        perCoinDestroyedTotal: {},
        perCoinQuarterlyEventTypes: {
          USDC: [{ quarter: "2026-Q1", blacklist: 1, unblacklist: 0, destroy: 0 }],
          "NOT-YET-TRACKED": [{ quarter: "2026-Q2", blacklist: 1, unblacklist: 0, destroy: 0 }],
        },
      },
      chart: [],
      chains: [],
      totalEvents: 12,
    };
    const parsed = BlacklistSummaryResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data!.stats.perCoinQuarterlyEventTypes)).toContain("NOT-YET-TRACKED");
    expect(BLACKLIST_STABLECOINS.includes("NOT-YET-TRACKED" as never)).toBe(false);
  });
});
