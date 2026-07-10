import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: new Map(),
  TRACKED_STABLECOINS: [],
  ACTIVE_STABLECOINS: [{ id: "usdt-tether" }, { id: "usdc-circle" }],
  ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle"]),
}));

vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotChainSupply } from "../snapshot-chain-supply";

function completePayload() {
  return {
    peggedAssets: [
      {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        price: 1.0,
        pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          Ethereum: {
            current: 60,
            circulatingPrevDay: 60,
            circulatingPrevWeek: 60,
            circulatingPrevMonth: 60,
          },
          BSC: {
            current: 40,
            circulatingPrevDay: 40,
            circulatingPrevWeek: 40,
            circulatingPrevMonth: 40,
          },
          "Citrea Mainnet": {
            current: 10,
            circulatingPrevDay: 10,
            circulatingPrevWeek: 10,
            circulatingPrevMonth: 10,
          },
        },
        chains: ["ethereum", "bsc", "citrea"],
      },
      {
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        price: 1.0,
        pegType: "peggedUSD",
        circulating: { peggedUSD: 50 },
        chainCirculating: {},
        chains: [],
      },
    ],
  };
}

describe("snapshotChainSupply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T08:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns degraded when cache is missing", async () => {
    const db = mockD1();
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
  });

  it("normalizes chain display names through the canonical resolver before snapshotting", async () => {
    const payload = completePayload();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(3);

    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((entry) => entry.binds[0])).toEqual(["ethereum", "bsc", "citrea"]);
    expect(inserts.map((entry) => entry.binds[2])).toEqual([60, 40, 10]);
    expect(inserts.map((entry) => entry.binds[3])).toEqual([1, 1, 1]);
  });

  it("returns degraded when the stablecoins cache produces no valid chain rows", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          name: "USD Coin",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 50 },
          chainCirculating: {},
          chains: [],
        },
      ],
    };
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("no-valid-chain-rows");
  });

  it("blocks a partial active universe without sealing the day", async () => {
    const payload = completePayload();
    payload.peggedAssets.pop();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "partial_snapshot_blocked",
      presentActiveCount: 1,
      expectedActiveCount: 2,
      missingActiveIds: ["usdc-circle"],
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("snapshot-chain-supply:last-write"))).toBe(false);
  });

  it("accounts for an owned waiver until expiry and fails closed at expiry", async () => {
    const payload = completePayload();
    payload.peggedAssets.pop();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const waiver = {
      stablecoinId: "usdc-circle",
      owner: "data-platform",
      reason: "upstream supply unavailable",
      expiresAt: Date.UTC(2026, 2, 17) / 1000,
    };
    const buildDb = () => mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);

    const beforeExpiry = await snapshotChainSupply(buildDb(), undefined, {
      nowSec: waiver.expiresAt - 1,
      publicationWaivers: [waiver],
    });
    expect(beforeExpiry.itemCount).toBe(3);

    const atExpiry = await snapshotChainSupply(buildDb(), undefined, {
      nowSec: waiver.expiresAt,
      publicationWaivers: [waiver],
    });
    expect(atExpiry.status).toBe("degraded");
    expect(JSON.parse(atExpiry.metadata ?? "{}")).toMatchObject({
      reason: "partial_snapshot_blocked",
      missingActiveIds: ["usdc-circle"],
      expiredWaiverIds: ["usdc-circle"],
    });
  });

  it("retries a legacy same-day marker and then honors the exact-set marker", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const payload = completePayload();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const legacyDb = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
      },
      {
        match: "cache",
        matchBinds: ["snapshot-chain-supply:last-write"],
        rows: [],
        first: {
          key: "snapshot-chain-supply:last-write",
          value: JSON.stringify({ snapshotDate }),
          updated_at: freshUpdatedAt,
        },
      },
    ]);

    const retried = await snapshotChainSupply(legacyDb);
    expect(retried.itemCount).toBe(3);
    const markerWrite = legacyDb.getHistory().find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "snapshot-chain-supply:last-write"
    ));
    expect(JSON.parse(String(markerWrite?.binds[1]))).toMatchObject({
      snapshotDate,
      coverageVersion: 1,
      expectedActiveCount: 2,
      accountedActiveCount: 2,
      writtenChains: 3,
    });

    const exactDb = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
      },
      {
        match: "cache",
        matchBinds: ["snapshot-chain-supply:last-write"],
        rows: [],
        first: {
          key: "snapshot-chain-supply:last-write",
          value: JSON.stringify({
            snapshotDate,
            coverageVersion: 1,
            expectedActiveCount: 2,
            accountedActiveCount: 2,
          }),
          updated_at: freshUpdatedAt,
        },
      },
    ]);
    const skipped = await snapshotChainSupply(exactDb);
    expect(JSON.parse(skipped.metadata ?? "{}")).toMatchObject({ reason: "already_written_today" });
    expect(exactDb.getHistory().some((entry) => entry.sql.includes("chain_supply_history"))).toBe(false);
  });

  it("leaves the completion marker retryable when a chain batch write fails", async () => {
    const payload = completePayload();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
      },
      {
        match: "INSERT OR REPLACE INTO chain_supply_history",
        rows: [],
        throwError: new Error("chain write failed"),
      },
    ]);

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "db_write_failed" });
    expect(db.getHistory().some((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "snapshot-chain-supply:last-write"
    ))).toBe(false);
  });

  it("returns degraded when aborted", async () => {
    const db = mockD1();
    const controller = new AbortController();
    controller.abort();
    const result = await snapshotChainSupply(db, controller.signal);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "aborted" });
  });
});
