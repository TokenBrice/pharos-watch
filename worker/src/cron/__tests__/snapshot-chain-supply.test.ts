import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type * as WorkerRuntimeRegistry from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  buildChainSupplySnapshotCompletionMarker,
  makeChainSupplySnapshotDb,
  makeSnapshotAsset,
} from "./snapshot-cron.test-support";

const mockD1 = makeChainSupplySnapshotDb;

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    { id: "usdt-tether", symbol: "USDT", flags: { pegCurrency: "USD" } },
    { id: "usdc-circle", symbol: "USDC", flags: { pegCurrency: "USD" } },
  ],
}));

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerRuntimeRegistry>();
  const metaById = new Map(actual.WORKER_ACTIVE_META_BY_ID);
  const usdc = metaById.get("usdc-circle")!;
  metaById.set("usdc-circle", {
    ...usdc, contracts: [{ chain: "Ethereum", address: "0x1", decimals: 6 }], tradedContracts: [],
  });
  metaById.set("missing-coin", {
    ...usdc, id: "missing-coin",
    contracts: [{ chain: "Ethereum", address: "0x1", decimals: 6 }],
    tradedContracts: [{ chain: "BSC", address: "0x2", decimals: 6 }],
  });
  return { ...actual, WORKER_ACTIVE_META_BY_ID: metaById };
});



import { snapshotChainSupply } from "../snapshot-chain-supply";
import type { StablecoinPublicationWaiver } from "../../lib/stablecoin-publication-coverage";
import { restoreFallbackCacheState } from "../sync-stablecoins/fallback";

import type { PeggedAsset } from "../sync-stablecoins/enrich-prices-shared";
const DEFAULT_REQUIRED_IDS = ["usdt-tether", "usdc-circle"] as const;

const completionMarker = (options: Parameters<typeof buildChainSupplySnapshotCompletionMarker>[0]) =>
  JSON.stringify({
    ...JSON.parse(buildChainSupplySnapshotCompletionMarker(options)),
    chainObservationAdmissionVersion: 1,
  });

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


  it("defers copied fallback chain histories instead of importing prior current as a fresh observation", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const previous = completePayload();
      previous.peggedAssets[1] = makeSnapshotAsset({
        id: "usdc-circle", circulating: { peggedUSD: 100_000_000 },
        supplyObservedAt: nowSec - 60, chainCirculating: { Ethereum: { current: 100_000_000 } }, chains: ["Ethereum"],
      });
      const put = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      put.run("stablecoins", JSON.stringify(previous), nowSec - 60);
      const fresh: PeggedAsset = {
        id: "usdc-circle", name: "USD Coin", symbol: "USDC",
        circulating: { peggedUSD: 150_000_000 }, supplySource: "coingecko-fallback",
        supplyObservedAt: nowSec - 10, chainCirculating: {}, chains: [],
      };
      await restoreFallbackCacheState({ db, assets: [fresh] });
      expect(fresh.circulating).toEqual({ peggedUSD: 150_000_000 });
      expect(fresh.supplyObservedAt).toBe(nowSec - 10);
      put.run("stablecoins", JSON.stringify({ peggedAssets: [previous.peggedAssets[0], fresh] }), nowSec);
      const result = await snapshotChainSupply(db, undefined, { nowSec, requiredActiveIds: DEFAULT_REQUIRED_IDS });
      expect(JSON.parse(result.metadata!)).toMatchObject({ deferredChains: { ethereum: ["usdc-circle"] } });
      expect(sqlite.prepare("SELECT chain_id FROM chain_supply_history WHERE chain_id = 'ethereum'").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects daily chain subtotals for an omitted quarantined contributor with preserved null identity", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = completePayload();
      payload.peggedAssets[1] = makeSnapshotAsset({
        id: "usdc-circle", circulating: { peggedUSD: 100_000_000 }, supplyObservedAt: nowSec - 900,
        supplyRestored: true, chainCirculating: { Sonic: { current: null }, Ethereum: { current: 20_000_000 } },
        chains: ["Sonic", "Ethereum"],
      });
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", JSON.stringify(payload), nowSec);
      const result = await snapshotChainSupply(db, undefined, { nowSec, requiredActiveIds: DEFAULT_REQUIRED_IDS });
      expect(JSON.parse(result.metadata!)).toMatchObject({
        restoredOnlyIds: ["usdc-circle"], deferredChains: { sonic: ["usdc-circle"], ethereum: ["usdc-circle"] },
      });
      expect(sqlite.prepare("SELECT chain_id FROM chain_supply_history WHERE chain_id IN ('sonic', 'ethereum')").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
  it.each([false, true])(
    "publishes unaffected chains for a restored small-asset cohort and recovers same-day (prior row: %s)",
    async (hasPriorRow) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
        const payload = completePayload();
        const healthyChains = [
          "ethereum", "arbitrum", "base", "optimism", "polygon", "avalanche",
          "bsc", "gnosis", "tron", "aptos", "sui", "solana", "near", "algorand",
        ];
        payload.peggedAssets[0]!.chainCirculating = Object.fromEntries(
          healthyChains.map((chainId) => [chainId, { chainId, current: 1_000_000_000 }]),
        );
        payload.peggedAssets[1]!.chainCirculating = { Ethereum: { current: 20_000_000_000 } };
        // Production-shaped attribution: HBD/MXNE have no chain partition;
        // PGOLD's restored partition spans these four known chains.
        const smallAssets = [
          makeSnapshotAsset({ id: "hbd-hive", circulating: { peggedUSD: 30_000_000 }, chainCirculating: {} }),
          makeSnapshotAsset({ id: "mxne-real-mxn", circulating: { peggedUSD: 1_000_000 }, chainCirculating: {} }),
          makeSnapshotAsset({
            id: "pgold-pleasing",
            circulating: { peggedUSD: 84_000_000 },
            chainCirculating: {
              Arbitrum: { current: 79_000_000 },
              Ethereum: { current: 500_000 },
              ApeChain: { current: 200 },
              "Pharos Network": { chainId: "pharos", current: 4_000_000 },
            },
          }),
        ];
        for (const asset of smallAssets) {
          Object.assign(asset, { supplyRestored: true, supplyObservedAt: nowSec - 144_443 });
        }
        payload.peggedAssets.push(...smallAssets);
        const requiredActiveIds = payload.peggedAssets.map((asset) => String(asset.id));
        const putCache = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
        putCache.run("stablecoins", JSON.stringify(payload), nowSec);
        if (hasPriorRow) {
          sqlite.prepare(
            "INSERT INTO chain_supply_history (chain_id, snapshot_date, total_usd, stablecoin_count) VALUES (?, ?, ?, ?)",
          ).run("ethereum", snapshotDate, 21_000_400_000, 3);
        }
        const result = await snapshotChainSupply(db, undefined, { nowSec, requiredActiveIds });
        expect(result.status).toBe("ok");
        expect(result.itemCount).toBe(12);
        expect(JSON.parse(result.metadata!)).toMatchObject({
          reason: "chain_observations_partially_deferred",
          quality: "partial",
          restoredOnlyIds: ["hbd-hive", "mxne-real-mxn", "pgold-pleasing"],
          deferredChains: {
            apechain: ["pgold-pleasing"], arbitrum: ["pgold-pleasing"],
            ethereum: ["pgold-pleasing"], pharos: ["pgold-pleasing"],
          },
        });
        const rows = () => sqlite.prepare(
          "SELECT chain_id, total_usd, stablecoin_count FROM chain_supply_history ORDER BY chain_id",
        ).all();
        expect(rows()).toEqual([
          ...healthyChains.filter((chainId) => !["ethereum", "arbitrum"].includes(chainId)).map((chain_id) => ({
            chain_id, total_usd: 1_000_000_000, stablecoin_count: 1,
          })),
          ...(hasPriorRow ? [{ chain_id: "ethereum", total_usd: 21_000_400_000, stablecoin_count: 3 }] : []),
        ].sort((a, b) => a.chain_id.localeCompare(b.chain_id)));
        const marker = () => JSON.parse(String(sqlite.prepare(
          "SELECT value FROM cache WHERE key = 'snapshot-chain-supply:last-write'",
        ).get()!.value));
        expect(marker().chainObservationAdmissionVersion).toBeUndefined();
        // Later slots must not move already-admitted chains to later observations.
        payload.peggedAssets[0]!.chainCirculating = Object.fromEntries(
          healthyChains.map((chainId) => [chainId, { chainId, current: chainId === "base" ? 2_000_000_000 : 1_000_000_000 }]),
        );
        putCache.run("stablecoins", JSON.stringify(payload), nowSec + 30);
        const retry = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 30, requiredActiveIds });
        expect(retry.status).toBe("ok");
        expect(retry.itemCount).toBe(0);
        expect(rows().find((row) => row.chain_id === "base")!.total_usd).toBe(1_000_000_000);

        for (const asset of smallAssets) {
          Object.assign(asset, { supplyRestored: false, supplyObservedAt: nowSec + 60 });
        }
        putCache.run("stablecoins", JSON.stringify(payload), nowSec + 60);
        const recovered = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 60, requiredActiveIds });
        expect(recovered.status).toBe("ok");
        expect(recovered.itemCount).toBe(4);
        expect(rows().find((row) => row.chain_id === "base")!.total_usd).toBe(1_000_000_000);
        expect(rows().filter((row) => ["ethereum", "arbitrum", "apechain", "pharos"].includes(String(row.chain_id)))).toEqual([
          { chain_id: "apechain", total_usd: 200, stablecoin_count: 1 },
          { chain_id: "arbitrum", total_usd: 1_079_000_000, stablecoin_count: 2 },
          { chain_id: "ethereum", total_usd: 21_000_500_000, stablecoin_count: 3 },
          { chain_id: "pharos", total_usd: 4_000_000, stablecoin_count: 1 },
        ]);
        expect(marker().chainObservationAdmissionVersion).toBe(1);
        expect(JSON.parse((await snapshotChainSupply(
          db, undefined, { nowSec: nowSec + 60, requiredActiveIds },
        )).metadata!).reason).toBe("already_written_today");
        const sealedRows = rows();
        const sealedMarker = sqlite.prepare(
          "SELECT value, updated_at FROM cache WHERE key = 'snapshot-chain-supply:last-write'",
        ).get();
        Object.assign(smallAssets[2]!, { supplyRestored: true });
        payload.peggedAssets[0]!.chainCirculating = Object.fromEntries(
          healthyChains.map((chainId) => [chainId, { chainId, current: 3_000_000_000 }]),
        );
        putCache.run("stablecoins", JSON.stringify(payload), nowSec + 120);
        const laterPartial = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 120, requiredActiveIds });
        expect(JSON.parse(laterPartial.metadata!).reason).toBe("already_written_today");
        expect(laterPartial.itemCount).toBe(0);
        expect(rows()).toEqual(sealedRows);
        expect(sqlite.prepare(
          "SELECT value, updated_at FROM cache WHERE key = 'snapshot-chain-supply:last-write'",
        ).get()).toEqual(sealedMarker);
      } finally {
        sqlite.close();
      }
    },
  );

  it.each(["restored", "stale", "missing"] as const)(
    "preserves all affected rows on %s chain input and replaces a legacy marker on recovery",
    async (unavailable) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const snapshotDate = Date.UTC(2026, 2, 16) / 1000;
        const payload = completePayload();
        payload.peggedAssets[1]!.chainCirculating = { Ethereum: { current: 50 } };
        Object.assign(payload.peggedAssets[0]!, {
          supplyRestored: unavailable === "restored",
          supplyObservedAt: unavailable === "missing" ? nowSec : nowSec - 6 * 86400,
          ...(unavailable === "missing" ? { chainCirculating: { Ethereum: { current: null } } } : {}),
        });
        const marker = buildChainSupplySnapshotCompletionMarker({ snapshotDate });
        const putCache = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
        putCache.run("stablecoins", JSON.stringify(payload), nowSec);
        putCache.run("snapshot-chain-supply:last-write", marker, nowSec - 900);
        sqlite.prepare(
          "INSERT INTO chain_supply_history (chain_id, snapshot_date, total_usd, stablecoin_count) VALUES (?, ?, ?, ?)",
        ).run("ethereum", snapshotDate, 99, 2);

        const blocked = await snapshotChainSupply(db, undefined, { nowSec });
        expect(blocked.status).toBe("degraded");
        expect(JSON.parse(blocked.metadata ?? "{}")).toMatchObject({
          reason: "chain_observations_unavailable",
          deferredChainIds: expect.arrayContaining(["ethereum"]),
          [unavailable === "restored" ? "restoredOnlyIds" : unavailable === "stale" ? "staleSupplyIds" : "missingSupplyIds"]:
            ["usdt-tether"],
        });
        expect(sqlite.prepare("SELECT total_usd FROM chain_supply_history").all()).toEqual([{ total_usd: 99 }]);
        expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(
          "snapshot-chain-supply:last-write",
        )).toEqual({ value: marker, updated_at: nowSec - 900 });

        Object.assign(payload.peggedAssets[0]!, {
          supplyRestored: false,
          supplyObservedAt: nowSec + 60,
          chainCirculating: { Ethereum: { current: 70 } },
        });
        putCache.run("stablecoins", JSON.stringify(payload), nowSec + 60);
        const recovered = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 60 });
        expect(recovered.itemCount).toBe(1);
        expect(sqlite.prepare("SELECT chain_id, total_usd, stablecoin_count FROM chain_supply_history").all()).toEqual([
          { chain_id: "ethereum", total_usd: 120, stablecoin_count: 2 },
        ]);
        const saved = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(
          "snapshot-chain-supply:last-write",
        )!;
        expect(saved.updated_at).toBe(nowSec + 60);
        expect(JSON.parse(String(saved.value))).toMatchObject({
          snapshotDate, accountedActiveCount: 2, ownedRowIds: ["ethereum"], chainObservationAdmissionVersion: 1,
        });
        payload.peggedAssets[0]!.chainCirculating = { Ethereum: { current: 900 } };
        putCache.run("stablecoins", JSON.stringify(payload), nowSec + 120);
        const unchanged = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 120 });
        expect(JSON.parse(unchanged.metadata ?? "{}").reason).toBe("already_written_today");
        expect(sqlite.prepare("SELECT total_usd FROM chain_supply_history").all()).toEqual([{ total_usd: 120 }]);
      } finally {
        sqlite.close();
      }
    },
  );

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

  it("skips once the stablecoins cache is older than two producer intervals (>1800s)", async () => {
    const payload = completePayload();
    const staleUpdatedAt = Math.floor(Date.now() / 1000) - 1801;
    const db = mockD1({ stablecoins: { assets: payload, updatedAt: staleUpdatedAt } });
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "cache_stale" });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"))).toBe(false);
  });

  it("still snapshots a cache age of 1799s (boundary below the two-interval skip gate)", async () => {
    const payload = completePayload();
    const boundaryUpdatedAt = Math.floor(Date.now() / 1000) - 1799;
    const db = mockD1({ stablecoins: { assets: payload, updatedAt: boundaryUpdatedAt } });
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(3);
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

  it("blocks a systemic publication gap without sealing the day", async () => {
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
    expect(beforeExpiry.itemCount).toBe(2);

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

  it.each([
    { missingCount: 1, band: "routine", status: "ok" },
    { missingCount: 4, band: "elevated", status: "degraded" },
  ])("defers only known chains for a $band absence and admits them after recovery", async ({
    missingCount, band, status,
  }) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = completePayload();
      const fillerIds = Array.from({ length: 393 }, (_, index) => `filler-${index}`);
      const requiredActiveIds = [...DEFAULT_REQUIRED_IDS, ...fillerIds, "missing-coin"];
      payload.peggedAssets.push(...fillerIds.slice(0, fillerIds.length - missingCount + 1)
        .map((id) => makeSnapshotAsset({ id, chainCirculating: {} })));
      const put = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      put.run("stablecoins", JSON.stringify(payload), nowSec);
      const options = { nowSec, requiredActiveIds };
      const first = await snapshotChainSupply(db, undefined, options);
      expect(first.status).toBe(status);
      expect(first.itemCount).toBe(1);
      expect(JSON.parse(first.metadata!)).toMatchObject({
        publicationGap: { band, missingActiveCount: missingCount },
        deferredChains: { ethereum: ["missing-coin"], bsc: ["missing-coin"] },
        ...(band === "elevated" ? { reason: "publication_gap_elevated" } : {}),
      });
      expect(sqlite.prepare("SELECT chain_id, total_usd FROM chain_supply_history").all())
        .toEqual([{ chain_id: "citrea", total_usd: 10 }]);
      const saved = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")!;
      expect(JSON.parse(String(saved.value))).toMatchObject({
        expectedActiveCount: 396, accountedActiveCount: 396 - missingCount,
        ownedRowIds: ["citrea"], chainObservationProgressVersion: 1,
        missingActiveIds: expect.arrayContaining(["missing-coin"]),
      });
      expect(JSON.parse(String(saved.value)).chainObservationAdmissionVersion).toBeUndefined();
      payload.peggedAssets[0]!.chainCirculating = {
        Ethereum: { current: 70 }, BSC: { current: 40 }, "Citrea Mainnet": { current: 20 },
      };
      put.run("stablecoins", JSON.stringify(payload), nowSec + 60);
      const retry = await snapshotChainSupply(db, undefined, { ...options, nowSec: nowSec + 60 });
      expect(retry.status).toBe(status);
      expect(retry.itemCount).toBe(0);
      expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")).toEqual(saved);
      payload.peggedAssets.push(makeSnapshotAsset({
        id: "missing-coin", chainCirculating: { Ethereum: { current: 50 }, BSC: { current: 5 } },
      }));
      put.run("stablecoins", JSON.stringify(payload), nowSec + 120);
      const recovered = await snapshotChainSupply(db, undefined, { ...options, nowSec: nowSec + 120 });
      expect(recovered.itemCount).toBe(2);
      expect(sqlite.prepare("SELECT chain_id, total_usd FROM chain_supply_history ORDER BY chain_id").all()).toEqual([
        { chain_id: "bsc", total_usd: 45 },
        { chain_id: "citrea", total_usd: 10 },
        { chain_id: "ethereum", total_usd: 120 },
      ]);
      expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")).toEqual({ updated_at: nowSec + 120 });
    } finally {
      sqlite.close();
    }
  });

  it("names an absent unmapped HBD without inventing a tracked-chain contribution", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = completePayload();
      const fillerIds = Array.from({ length: 393 }, (_, index) => `filler-${index}`);
      payload.peggedAssets.push(...fillerIds.map((id) => makeSnapshotAsset({ id, chainCirculating: {} })));
      const requiredActiveIds = [...DEFAULT_REQUIRED_IDS, ...fillerIds, "hbd-hive"];
      const put = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      put.run("stablecoins", JSON.stringify(payload), nowSec);
      const first = await snapshotChainSupply(db, undefined, { nowSec, requiredActiveIds });
      expect(first.status).toBe("ok");
      expect(first.itemCount).toBe(3);
      expect(JSON.parse(first.metadata!)).toMatchObject({
        absentUnmappedIds: ["hbd-hive"], deferredChainIds: [],
        publicationGap: { band: "routine", missingActiveIds: ["hbd-hive"] },
      });
      const marker = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")!;
      const retry = await snapshotChainSupply(db, undefined, { nowSec, requiredActiveIds });
      expect(retry.itemCount).toBe(0);
      expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")).toEqual(marker);
      payload.peggedAssets.push(makeSnapshotAsset({ id: "hbd-hive", chainCirculating: {} }));
      put.run("stablecoins", JSON.stringify(payload), nowSec + 60);
      const recovered = await snapshotChainSupply(db, undefined, { nowSec: nowSec + 60, requiredActiveIds });
      expect(recovered.itemCount).toBe(0);
      expect(JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get("snapshot-chain-supply:last-write")!.value))).toMatchObject({
        accountedActiveCount: 396, missingActiveIds: [], chainObservationAdmissionVersion: 1,
      });
    } finally {
      sqlite.close();
    }
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

      expect(result.itemCount).toBe(2);
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
