import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import {
  fetchEvmCallHexAtBlockMock,
  freshParent,
  makeOpenProtocolRedeemCircuitDb,
  resetAuthoritativePriceSourceMocks,
} from "./authoritative-price-sources.test-support";

import { mockD1 } from "@shared/test-utils/mock-d1";
import { resolveVaultNavSupplyPrice } from "../authoritative-price-sources/erc4626-nav";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { CIRCUIT_SOURCE } from "../constants";

const NOW_SEC = 1_800_000_000;

describe("resolveVaultNavSupplyPrice", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    resetAuthoritativePriceSourceMocks();
  });

  function previousPayload(nowSec: number): ReadonlyMap<string, PeggedAsset> {
    return new Map([["usdc-circle", freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec })]]);
  }

  it("admits AA supply through Idle CDO virtualPrice", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${1_115_108n.toString(16).padStart(64, "0")}`);
    const nowSec = NOW_SEC;
    const result = await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", previousPayload(nowSec));
    expect(result).toMatchObject({ source: "protocol-redeem", confidence: "high", metadata: { inheritedFrom: "usdc-circle" } });
    expect(result?.price).toBeCloseTo(1.115108 * 0.9999, 8);
    expect(fetchEvmCallHexAtBlockMock.mock.calls[0]).toEqual(expect.arrayContaining([
      "ethereum", "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
      "0x9290d427000000000000000000000000c26a6fa2c37b38e549a4a1807543801db684f99c",
    ]));
  });

  it("values sGHO through previewRedeem with its parent gate", async () => {
    const nowSec = NOW_SEC;
    const parent = freshParent("gho-aave", 0.9999, "coingecko+curve-onchain", { nowSec });
    const parents = new Map([[parent.id, parent]]);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${(102n * 10n ** 16n).toString(16).padStart(64, "0")}`);
    expect(await resolveVaultNavSupplyPrice("sgho-aave", parents)).toMatchObject({
      price: 1.02 * 0.9999, metadata: { navMethod: "previewRedeem" },
    });
    expect(fetchEvmCallHexAtBlockMock.mock.calls[0]).toEqual(expect.arrayContaining([
      "ethereum", "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d",
      `0x4cdad506${(10n ** 18n).toString(16).padStart(64, "0")}`,
    ]));
    fetchEvmCallHexAtBlockMock.mockClear();
    parents.set(parent.id, { ...parent, priceObservedAt: nowSec - 901 });
    expect(await resolveVaultNavSupplyPrice("sgho-aave", parents)).toBeNull();
    parents.set(parent.id, { ...parent, priceSource: "coingecko", priceConfidence: "single-source" });
    expect(await resolveVaultNavSupplyPrice("sgho-aave", parents)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("keeps AA unavailable when the exact CDO quote is unreadable", async () => {
    const nowSec = NOW_SEC;
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    expect(await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", previousPayload(nowSec))).toBeNull();
  });

  it.each([301, 900, 86400])("keeps live source budgets for a %ss-old composite", async (ageSec) => {
    const nowSec = NOW_SEC;
    const parent = freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
      nowSec, observedAt: nowSec - ageSec, priceSyncedAt: nowSec - 60,
    });
    expect(await resolveVaultNavSupplyPrice("eearn-ember", new Map([["usdc-circle", parent]]))).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it.each([0, 1])("bounds previous supply parents at two cadences + %ss", async (excess) => {
    const maxAgeSec = 2 * CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec;
    const nowSec = NOW_SEC;
    const parents = previousPayload(nowSec);
    Object.assign(parents.get("usdc-circle")!, { priceObservedAt: nowSec - maxAgeSec - excess, priceSyncedAt: nowSec - 900 });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${1_115_108n.toString(16).padStart(64, "0")}`);
    const result = await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", parents, undefined, undefined, undefined, parents);
    expect(result?.price ?? null).toBe(excess ? null : 1.115108 * 0.9999);
    expect(JSON.parse(log.mock.calls[log.mock.calls.length - 1]![0]).metadata).toMatchObject({
      accepted: !excess, reason: excess ? "freshness-stale_observed_at" : null,
      budget: "sync-stablecoins-previous-payload-supply-parent", maxAgeSec,
      generation: "previous-payload", parentPriceSyncedAt: parents.get("usdc-circle")!.priceSyncedAt,
    });
    expect(fetchEvmCallHexAtBlockMock.mock.calls.length).toBe(excess ? 0 : 1);
  });

  it("persists a live NAV rate from a previous parent", async () => {
    const oneShareUsdcRaw = 1_040_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = NOW_SEC;
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT INTO authoritative_vault_rates", rows: [] },
    ], { assertMatchesUsed: true });

    const override = await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db);

    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(override?.price).toBeCloseTo(1.04 * 0.9999, 6);
    const rateWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO authoritative_vault_rates"));
    expect(rateWrite?.binds[0]).toBe("eearn-ember");
    expect(rateWrite?.binds[1]).toBeCloseTo(1.04, 8);
  });

  it("falls back to the bounded cached vault rate when the live read fails", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = NOW_SEC;
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      {
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "eearn-ember", rate: 1.0392, observed_at: nowSec - 3600 }],
      },
    ], { assertMatchesUsed: true });

    const override = await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db);

    expect(override).toMatchObject({
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      metadata: { cachedVaultRate: { rate: 1.0392, rateObservedAt: nowSec - 3600 } },
    });
    expect(override?.price).toBeCloseTo(1.0392 * 0.9999, 6);
  });

  // The same-run parent shape fiat-cg builds from a direct CoinGecko quote (K-033).
  function sameRunParent(nowSec: number, ageSec: number, overrides: Partial<PeggedAsset> = {}, id = "yzusd-yuzu"): ReadonlyMap<string, PeggedAsset> {
    return new Map([[id, {
      id, name: id, symbol: id, price: 1, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: nowSec - ageSec, priceObservedAtMode: "upstream",
      priceSyncedAt: nowSec, ...overrides,
    }]]);
  }

  it.each([60, 900])("values syzUSD supply from a %ss-old same-run CoinGecko parent", async (ageSec) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${(1_050_000n * 10n ** 12n).toString(16).padStart(64, "0")}`);
    const nowSec = NOW_SEC;
    const override = await resolveVaultNavSupplyPrice("syzusd-yuzu", sameRunParent(nowSec, ageSec));
    expect(override).toMatchObject({
      source: "coingecko", confidence: "single-source", observedAt: nowSec - ageSec,
      metadata: { inheritedFrom: "yzusd-yuzu", parentSource: "coingecko", parentReplaySafe: true },
    });
    expect(override?.price).toBeCloseTo(1.05, 6);
  });

  it.each([
    ["901-second-old", { priceObservedAt: NOW_SEC - 901 }],
    ["future", { priceObservedAt: NOW_SEC + 3600 }],
    ["clockless", { priceObservedAt: undefined, priceUpdatedAt: undefined }],
    ["non-positive", { price: 0 }],
    ["low-volume", { priceSource: "coingecko-low-volume", priceConfidence: "fallback" as const }],
  ])("keeps syzUSD supply NAV unavailable for a %s parent", async (_label, overrides) => {
    const nowSec = NOW_SEC;
    expect(await resolveVaultNavSupplyPrice("syzusd-yuzu", sameRunParent(nowSec, 60, overrides))).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  describe.each(["sbold-k3-capital", "ybold-yearn", "susn-noon"])("%s single-source parent admission", (id) => {
    const parentId = id === "susn-noon" ? "usn-noon" : "bold-liquity";
    function admittedParent(ageSec: number, overrides: Partial<PeggedAsset> = {}): ReadonlyMap<string, PeggedAsset> {
      return sameRunParent(NOW_SEC, ageSec, overrides, parentId);
    }

    it.each([60, 900])("values a %ss-old same-run parent", async (ageSec) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${(1_087n * 10n ** 15n).toString(16).padStart(64, "0")}`);
      const nowSec = NOW_SEC;
      const override = await resolveVaultNavSupplyPrice(id, admittedParent(ageSec));
      expect(override).toMatchObject({
        price: 1.087, source: "coingecko", confidence: "single-source", observedAt: nowSec - ageSec,
        metadata: { inheritedFrom: parentId, parentSource: "coingecko", parentReplaySafe: true },
      });
    });

    it.each<[string, Partial<PeggedAsset>]>([
      ["stale", { priceObservedAt: NOW_SEC - 901 }],
      ["future", { priceObservedAt: NOW_SEC + 3600 }],
      ["clockless", { priceObservedAt: undefined }],
      ["non-positive", { price: 0 }],
      ["fallback", { priceConfidence: "fallback" }],
      ["low-volume", { priceSource: "coingecko-low-volume", priceConfidence: "fallback" }],
      ["non-replay-safe single-source", { priceSource: "coingecko-onchain" }],
      ["cached", { priceSource: "coingecko+cached", priceConfidence: "high" }],
    ])("withholds supply NAV for a %s single-source parent", async (_label, overrides) => {
      expect(await resolveVaultNavSupplyPrice(id, admittedParent(60, overrides))).toBeNull();
      expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    });

    it("withholds supply NAV without a single-source parent", async () => {
      expect(await resolveVaultNavSupplyPrice(id, new Map())).toBeNull();
      expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    });
  });

  it("values sUSN supply from a fresh replay-safe single-source USN quote", async () => {
    // 1.232847915 USN per sUSN, the reviewed 2026-10-29 convertToAssets read.
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${(1_232_847_915n * 10n ** 9n).toString(16).padStart(64, "0")}`);
    const nowSec = NOW_SEC;
    const override = await resolveVaultNavSupplyPrice("susn-noon", sameRunParent(nowSec, 60, {}, "usn-noon"));
    expect(override).toMatchObject({
      source: "coingecko", confidence: "single-source", observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "usn-noon", parentSource: "coingecko", parentReplaySafe: true, navMethod: "convertToAssets",
      },
    });
    expect(override?.price).toBeCloseTo(1.232847915, 8);
    expect(fetchEvmCallHexAtBlockMock.mock.calls[0]).toEqual(expect.arrayContaining([
      "ethereum", "0xe24a3dc889621612422a64e6388927901608b91d",
    ]));
  });

  it("fails closed without a vault config", async () => {
    const nowSec = NOW_SEC;

    expect(await resolveVaultNavSupplyPrice("not-a-vault-token", previousPayload(nowSec))).toBeNull();

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips live RPC while the grouped circuit is open and no cached rate is available", async () => {
    const nowSec = NOW_SEC;
    const db = makeOpenProtocolRedeemCircuitDb(nowSec);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("uses the durable supply-valuation NAV rate while live RPC circuit admission is blocked", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const nowSec = NOW_SEC;
      const circuit = JSON.stringify({
        state: "open", consecutiveFailures: 3, openedAt: nowSec,
        lastFailureAt: nowSec, lastSuccessAt: null,
      });
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`, circuit, nowSec,
      );
      sqlite.prepare("INSERT INTO authoritative_vault_rates (stablecoin_id, rate, observed_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "eearn-ember", 1.0392, nowSec - 3600, nowSec - 3600,
      );
      const override = await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db);
      expect(override).toMatchObject({
        price: 1.0392 * 0.9999, source: "protocol-redeem-cached-rate", confidence: "low", observedAt: nowSec - 3600,
      });
      expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(
        `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      )).toEqual({ value: circuit });
    } finally {
      sqlite.close();
    }
  });

  it("returns null and records a grouped failure when the live read fails with no cached rate", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = NOW_SEC;
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ], { assertMatchesUsed: true });

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
  });
});
