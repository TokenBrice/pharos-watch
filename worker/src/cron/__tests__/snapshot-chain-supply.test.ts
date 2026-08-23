import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import {
  buildChainSupplySnapshotCompletionMarker,
  makeChainSupplySnapshotDb,
  makeSnapshotAsset,
} from "./snapshot-cron.test-support";

const mockD1 = makeChainSupplySnapshotDb;

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [{ id: "usdt-tether" }, { id: "usdc-circle" }],
}));

vi.mock("@shared/lib/stablecoins/aggregate-registry", () => ({
  CORE_AGGREGATE_ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle"]),
}));

vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotChainSupply } from "../snapshot-chain-supply";
import type { StablecoinPublicationWaiver } from "../../lib/stablecoin-publication-coverage";

const DEFAULT_REQUIRED_IDS = ["usdt-tether", "usdc-circle"] as const;

const completionMarker = buildChainSupplySnapshotCompletionMarker;

function completePayload() {
  return {
    peggedAssets: [
      makeSnapshotAsset({
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
      }),
      makeSnapshotAsset({
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        price: 1.0,
        pegType: "peggedUSD",
        circulating: { peggedUSD: 50 },
        chainCirculating: {},
        chains: [],
      }),
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
    const db = mockD1({ stablecoins: { assets: payload, updatedAt: freshUpdatedAt } });
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(3);

    const inserts = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.binds.filter((_, index) => index % 4 === 0)).toEqual(["ethereum", "bsc", "citrea"]);
    expect(inserts[0]!.binds.filter((_, index) => index % 4 === 2)).toEqual([60, 40, 10]);
    expect(inserts[0]!.binds.filter((_, index) => index % 4 === 3)).toEqual([1, 1, 1]);
  });

  it("returns degraded when the stablecoins cache produces no valid chain rows", async () => {
    const payload = {
      peggedAssets: [
        makeSnapshotAsset({
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {},
          chains: [],
        }),
        makeSnapshotAsset({
          id: "usdc-circle",
          symbol: "USDC",
          name: "USD Coin",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 50 },
          chainCirculating: {},
          chains: [],
        }),
      ],
    };
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1({ stablecoins: { assets: payload, updatedAt: freshUpdatedAt } });

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("no-valid-chain-rows");
  });

  it("blocks a partial active universe without sealing the day", async () => {
    const payload = completePayload();
    payload.peggedAssets.pop();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1({ stablecoins: { assets: payload, updatedAt: freshUpdatedAt } });

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
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    const buildDb = () =>
      mockD1({ stablecoins: { assets: payload, updatedAt: freshUpdatedAt } });

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

  it("invalidates a same-count active-ID replacement", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1({
      stablecoins: { assets: completePayload(), updatedAt: freshUpdatedAt, first: false },
      cacheRows: [{
        key: "snapshot-chain-supply:last-write",
        value: completionMarker({ snapshotDate, requiredIds: ["usdt-tether", "eurt-test"] }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotChainSupply(db, undefined, { requiredActiveIds: DEFAULT_REQUIRED_IDS });

    expect(result.itemCount).toBe(3);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM chain_supply_history"))).toBe(true);
  });

  it("invalidates completion when an active asset is promoted", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const payload = completePayload();
    payload.peggedAssets.push(makeSnapshotAsset({
      id: "eurt-test",
      symbol: "EURT",
      name: "Euro Test",
      price: 1,
      pegType: "peggedEUR",
      circulating: { peggedUSD: 25 },
      chainCirculating: {
        Ethereum: {
          current: 25,
          circulatingPrevDay: 25,
          circulatingPrevWeek: 25,
          circulatingPrevMonth: 25,
        },
        BSC: {
          current: 0,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
        "Citrea Mainnet": {
          current: 0,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
      },
      chains: ["ethereum"],
    }));
    const db = mockD1({
      stablecoins: { assets: payload, updatedAt: freshUpdatedAt, first: false },
      cacheRows: [{
        key: "snapshot-chain-supply:last-write",
        value: completionMarker({ snapshotDate }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotChainSupply(db, undefined, {
      requiredActiveIds: [...DEFAULT_REQUIRED_IDS, "eurt-test"],
    });

    expect(result.itemCount).toBe(3);
    const inserts = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"));
    expect(inserts.flatMap((entry) => entry.binds)).toContain(85);
  });

  it("atomically drops a chain that disappears after an active asset is removed", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const payload = completePayload();
    payload.peggedAssets.push(makeSnapshotAsset({
      id: "eurt-test",
      symbol: "EURT",
      name: "Euro Test",
      price: 1,
      pegType: "peggedEUR",
      circulating: { peggedUSD: 25 },
      chainCirculating: {},
      chains: [],
    }));
    const previousIds = [...DEFAULT_REQUIRED_IDS, "eurt-test"];
    const db = mockD1({
      stablecoins: { assets: payload, updatedAt: freshUpdatedAt, first: false },
      cacheRows: [{
        key: "snapshot-chain-supply:last-write",
        value: completionMarker({
          snapshotDate,
          requiredIds: previousIds,
          ownedRowIds: ["bsc", "citrea", "ethereum", "polygon"],
          writtenChains: 4,
        }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotChainSupply(db, undefined, { requiredActiveIds: DEFAULT_REQUIRED_IDS });

    expect(result.itemCount).toBe(3);
    const history = db.getHistory();
    expect(
      history.some(
        (entry) => entry.sql.includes("DELETE FROM chain_supply_history") && entry.binds[0] === snapshotDate,
      ),
    ).toBe(true);
    expect(
      history
        .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"))
        .flatMap((entry) => entry.binds),
    ).not.toContain("polygon");
  });

  it("invalidates completion when an applied waiver owner or expiry changes", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = completePayload();
    payload.peggedAssets.pop();
    const originalWaiver: StablecoinPublicationWaiver = {
      stablecoinId: "usdc-circle",
      owner: "data-platform",
      reason: "upstream unavailable",
      expiresAt: nowSec + 3600,
    };
    const variants = [
      { ...originalWaiver, owner: "data-operations" },
      { ...originalWaiver, expiresAt: originalWaiver.expiresAt + 3600 },
    ];

    for (const currentWaiver of variants) {
      const db = mockD1({
        stablecoins: { assets: payload, updatedAt: nowSec - 60, first: false },
        cacheRows: [{
          key: "snapshot-chain-supply:last-write",
          value: completionMarker({ snapshotDate, appliedWaivers: [originalWaiver] }),
          updatedAt: nowSec - 60,
          first: false,
        }],
      });

      const result = await snapshotChainSupply(db, undefined, {
        nowSec,
        publicationWaivers: [currentWaiver],
      });

      expect(result.itemCount).toBe(3);
    }
  });

  it("retries a legacy same-day marker and then honors the identity-bound marker", async () => {
    const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
    const payload = completePayload();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const legacyDb = mockD1({
      stablecoins: { assets: payload, updatedAt: freshUpdatedAt },
      cacheRows: [{
        key: "snapshot-chain-supply:last-write",
        value: JSON.stringify({ snapshotDate, coverageVersion: 1, expectedActiveCount: 2, accountedActiveCount: 2 }),
        updatedAt: freshUpdatedAt,
      }],
    });

    const retried = await snapshotChainSupply(legacyDb);
    expect(retried.itemCount).toBe(3);
    const markerWrite = legacyDb
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "snapshot-chain-supply:last-write",
      );
    expect(JSON.parse(String(markerWrite?.binds[1]))).toMatchObject({
      snapshotDate,
      coverageVersion: 2,
      expectedActiveCount: 2,
      accountedActiveCount: 2,
      coverageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      ownedRowIds: ["bsc", "citrea", "ethereum"],
      writtenChains: 3,
    });

    const exactDb = mockD1({
      stablecoins: { assets: payload, updatedAt: freshUpdatedAt },
      cacheRows: [{
        key: "snapshot-chain-supply:last-write",
        value: completionMarker({ snapshotDate }),
        updatedAt: freshUpdatedAt,
      }],
    });
    const skipped = await snapshotChainSupply(exactDb);
    expect(JSON.parse(skipped.metadata ?? "{}")).toMatchObject({ reason: "already_written_today" });
    expect(exactDb.getHistory().some((entry) => entry.sql.includes("chain_supply_history"))).toBe(false);
  });

  it("leaves the completion marker retryable when a chain batch write fails", async () => {
    const payload = completePayload();
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1({
      stablecoins: { assets: payload, updatedAt: freshUpdatedAt },
      tables: [{
        match: "INSERT OR REPLACE INTO chain_supply_history",
        rows: [],
        throwError: new Error("chain write failed"),
      }],
    });
    const batches: D1PreparedStatement[][] = [];
    const originalBatch = db.batch.bind(db);
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batches.push(statements);
      return originalBatch(statements);
    }) as D1Database["batch"];

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "db_write_failed" });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((statement) => (statement as { sql?: string }).sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DELETE FROM chain_supply_history"),
        expect.stringContaining("INSERT OR REPLACE INTO chain_supply_history"),
        expect.stringContaining("INSERT OR REPLACE INTO cache"),
      ]),
    );
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
