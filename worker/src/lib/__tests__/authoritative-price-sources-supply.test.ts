import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchEvmCallHexAtBlockMock,
  freshParent,
  makeOpenProtocolRedeemCircuitDb,
  resetAuthoritativePriceSourceMocks,
} from "./authoritative-price-sources.test-support";

import { mockD1 } from "@shared/test-utils/mock-d1";
import { resolveVaultNavSupplyPrice } from "../authoritative-price-sources/erc4626-nav";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

describe("resolveVaultNavSupplyPrice", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  function previousPayload(nowSec: number): ReadonlyMap<string, PeggedAsset> {
    return new Map([["usdc-circle", freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec })]]);
  }

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

  it("skips the resolver while the grouped protocol-redeem circuit is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeOpenProtocolRedeemCircuitDb(nowSec);

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns null and records a grouped failure when the live read fails with no cached rate", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "FROM authoritative_vault_rates", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ], { assertMatchesUsed: true });

    expect(await resolveVaultNavSupplyPrice("eearn-ember", previousPayload(nowSec), db)).toBeNull();
  });
});
