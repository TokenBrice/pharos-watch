import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchEvmCallHexAtBlockMock,
  freshParent,
  makeOpenProtocolRedeemCircuitDb,
  resetAuthoritativePriceSourceMocks,
} from "./authoritative-price-sources.test-support";

import { mockD1 } from "@shared/test-utils/mock-d1";
import { getFreshSingleSourceNavParentId, resolveVaultNavSupplyPrice } from "../authoritative-price-sources/erc4626-nav";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { CIRCUIT_SOURCE } from "../constants";

describe("resolveVaultNavSupplyPrice", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  function previousPayload(nowSec: number): ReadonlyMap<string, PeggedAsset> {
    return new Map([["usdc-circle", freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec })]]);
  }

  it("admits AA supply valuation through its exact Idle CDO virtualPrice route", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${1_115_108n.toString(16).padStart(64, "0")}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", previousPayload(nowSec));
    expect(result).toMatchObject({ source: "protocol-redeem", confidence: "high", metadata: { inheritedFrom: "usdc-circle" } });
    expect(result?.price).toBeCloseTo(1.115108 * 0.9999, 8);
    expect(fetchEvmCallHexAtBlockMock.mock.calls[0]).toEqual(expect.arrayContaining([
      "ethereum", "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
      "0x9290d427000000000000000000000000c26a6fa2c37b38e549a4a1807543801db684f99c",
    ]));
  });

  it("keeps AA unavailable when its parent is stale or the exact CDO quote is unreadable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const stale = new Map([["usdc-circle", freshParent("usdc-circle", 1, "coingecko+pyth", {
      nowSec, observedAt: nowSec - 3 * 3600, priceSyncedAt: nowSec - 3 * 3600,
    })]]);
    expect(await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", stale)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    expect(await resolveVaultNavSupplyPrice("aa-falconx-mev-capital", previousPayload(nowSec))).toBeNull();
  });

  it.each([301, 900, 86400])("withholds supply NAV for a %ss-old composite despite a recent sync", async (ageSec) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const parent = freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
      nowSec, observedAt: nowSec - ageSec, priceSyncedAt: nowSec - 60,
    });
    expect(await resolveVaultNavSupplyPrice("eearn-ember", new Map([["usdc-circle", parent]]))).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("resolves a live NAV supply price from the previous payload parent and persists the rate", async () => {
    const oneShareUsdcRaw = 1_040_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);
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
    const nowSec = Math.floor(Date.now() / 1000);
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

  it("exposes only configured fresh single-source NAV parents", () => {
    expect(getFreshSingleSourceNavParentId("syzusd-yuzu")).toBe("yzusd-yuzu");
    expect(getFreshSingleSourceNavParentId("senpathusd-sentora")).toBe("pathusd-bridge");
    expect(getFreshSingleSourceNavParentId("sbold-k3-capital")).toBe("bold-liquity");
    expect(getFreshSingleSourceNavParentId("ybold-yearn")).toBe("bold-liquity");
    expect(getFreshSingleSourceNavParentId("eearn-ember")).toBeNull();
    expect(getFreshSingleSourceNavParentId("sgho-aave")).toBeNull();
    expect(getFreshSingleSourceNavParentId("not-a-vault-token")).toBeNull();
  });

  // The same-run parent shape fiat-cg builds from a direct CoinGecko quote (K-033).
  function sameRunParent(nowSec: number, ageSec: number, overrides: Partial<PeggedAsset> = {}): ReadonlyMap<string, PeggedAsset> {
    return new Map([["yzusd-yuzu", {
      id: "yzusd-yuzu", name: "Yuzu USD", symbol: "YZUSD", price: 1, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: nowSec - ageSec, priceObservedAtMode: "upstream",
      priceSyncedAt: nowSec, ...overrides,
    }]]);
  }

  it.each([60, 900])("values syzUSD supply from a %ss-old same-run CoinGecko parent", async (ageSec) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${(1_050_000n * 10n ** 12n).toString(16).padStart(64, "0")}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const override = await resolveVaultNavSupplyPrice("syzusd-yuzu", sameRunParent(nowSec, ageSec));
    expect(override).toMatchObject({
      source: "coingecko", confidence: "single-source", observedAt: nowSec - ageSec,
      metadata: { inheritedFrom: "yzusd-yuzu", parentSource: "coingecko", parentReplaySafe: true },
    });
    expect(override?.price).toBeCloseTo(1.05, 6);
  });

  it.each([
    ["901-second-old", { priceObservedAt: Math.floor(Date.now() / 1000) - 901 }],
    ["future", { priceObservedAt: Math.floor(Date.now() / 1000) + 3600 }],
    ["clockless", { priceObservedAt: undefined, priceUpdatedAt: undefined }],
    ["non-positive", { price: 0 }],
    ["low-volume", { priceSource: "coingecko-low-volume", priceConfidence: "fallback" as const }],
  ])("keeps syzUSD supply NAV unavailable for a %s parent", async (_label, overrides) => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(await resolveVaultNavSupplyPrice("syzusd-yuzu", sameRunParent(nowSec, 60, overrides))).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  describe.each(["sbold-k3-capital", "ybold-yearn"])("%s BOLD parent admission", (id) => {
    function boldParent(ageSec: number, overrides: Partial<PeggedAsset> = {}): ReadonlyMap<string, PeggedAsset> {
      const nowSec = Math.floor(Date.now() / 1000);
      return new Map([["bold-liquity", {
        ...sameRunParent(nowSec, ageSec).get("yzusd-yuzu")!,
        id: "bold-liquity", name: "Liquity BOLD", symbol: "BOLD", ...overrides,
      }]]);
    }

    it.each([60, 900])("values supply from a %ss-old same-run direct CoinGecko BOLD quote", async (ageSec) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${(1_087n * 10n ** 15n).toString(16).padStart(64, "0")}`);
      const nowSec = Math.floor(Date.now() / 1000);
      const override = await resolveVaultNavSupplyPrice(id, boldParent(ageSec));
      expect(override).toMatchObject({
        price: 1.087, source: "coingecko", confidence: "single-source", observedAt: nowSec - ageSec,
        metadata: { inheritedFrom: "bold-liquity", parentSource: "coingecko", parentReplaySafe: true },
      });
    });

    it.each<[string, Partial<PeggedAsset>]>([
      ["stale", { priceObservedAt: Math.floor(Date.now() / 1000) - 901 }],
      ["future", { priceObservedAt: Math.floor(Date.now() / 1000) + 3600 }],
      ["clockless", { priceObservedAt: undefined }],
      ["non-positive", { price: 0 }],
      ["fallback", { priceConfidence: "fallback" }],
      ["low-volume", { priceSource: "coingecko-low-volume", priceConfidence: "fallback" }],
      ["non-replay-safe single-source", { priceSource: "coingecko-onchain" }],
      ["cached", { priceSource: "coingecko+cached", priceConfidence: "high" }],
    ])("withholds supply NAV for a %s BOLD parent", async (_label, overrides) => {
      expect(await resolveVaultNavSupplyPrice(id, boldParent(60, overrides))).toBeNull();
      expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    });

    it("withholds supply NAV without a BOLD parent", async () => {
      expect(await resolveVaultNavSupplyPrice(id, new Map())).toBeNull();
      expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    });
  });

  it("fails closed without a parent row, a trusted parent, or a vault config", async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", new Map())).toBeNull();
    expect(
      await resolveVaultNavSupplyPrice("not-a-vault-token", previousPayload(nowSec)),
    ).toBeNull();

    const staleParent: ReadonlyMap<string, PeggedAsset> = new Map([[
      "usdc-circle",
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
        nowSec,
        observedAt: nowSec - 3 * 3600,
        priceSyncedAt: nowSec - 3 * 3600,
      }),
    ]]);
    expect(await resolveVaultNavSupplyPrice("eearn-ember", staleParent)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips live RPC while the grouped circuit is open and no cached rate is available", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeOpenProtocolRedeemCircuitDb(nowSec);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("uses the durable supply-valuation NAV rate while live RPC circuit admission is blocked", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
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
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ], { assertMatchesUsed: true });

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
  });
});
