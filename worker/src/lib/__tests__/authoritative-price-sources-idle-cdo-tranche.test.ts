import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  freshParent,
  resetAuthoritativePriceSourceMocks,
  unpricedChild,
} from "./authoritative-price-sources.test-support";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";
import { CACHED_VAULT_RATE_MAX_AGE_SEC } from "../authoritative-price-sources/helpers";
import { idleCdoTrancheProvider } from "../authoritative-price-sources/idle-cdo-tranche";
import { encodeUint256 } from "../evm-selectors";

const ID = "aa-falconx-mev-capital";
const NOW = 1_800_000_000;

function contextWithParent(parent: PeggedAsset = freshParent("usdc-circle", 0.98, "coingecko+pyth", { nowSec: NOW })): LivePriceContext {
  return {
    assetsById: new Map([[parent.id, parent]]),
    vaultRateWrites: new Map(),
  };
}

describe("idleCdoTrancheProvider", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes the six-decimal tranche virtual price, values it with the trusted parent and records the fresh rate", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(1_234_567n)}`);
    const context = contextWithParent();

    const result = await idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context);
    expect(result).toMatchObject({
      price: 1.234567 * 0.98,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: NOW - 60,
      observedAtMode: "upstream",
      metadata: { inheritedFrom: "usdc-circle", parentReplaySafe: true },
    });
    expect(context.vaultRateWrites?.get(ID)).toEqual({ rate: 1.234567, observedAt: NOW });
  });

  it("cannot promote a valid tranche rate when the USDC parent is untrusted", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(1_234_567n)}`);
    const context = contextWithParent(freshParent("usdc-circle", 0.98, "cached", { nowSec: NOW }));

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
    expect(context.lastUntrustedParent).toMatchObject({ parentId: "usdc-circle" });
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("rescues a missing price after an RPC failure with explicitly degraded cached-rate provenance", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("RPC unavailable"));
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toMatchObject({
      price: 1.2 * 0.98,
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC,
      observedAtMode: "local_fetch",
      metadata: {
        inheritedFrom: "usdc-circle",
        cachedVaultRate: { rate: 1.2, rateObservedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC },
      },
    });
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("rejects a cached rate one second beyond its freshness budget and preserves the RPC error", async () => {
    const error = new Error("RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - CACHED_VAULT_RATE_MAX_AGE_SEC - 1 }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).rejects.toBe(error);
  });

  it("does not replace an existing usable market price with a cached tranche rate", async () => {
    const error = new Error("RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    const context = contextWithParent();
    context.vaultRateCache = new Map([[ID, { rate: 1.2, observedAt: NOW - 300 }]]);

    await expect(idleCdoTrancheProvider.fetchLivePrice!(
      freshParent(ID, 1.05, "coingecko", { nowSec: NOW }), context,
    )).rejects.toBe(error);
  });

  it.each([0n, 499_999n, 10_000_001n])("rejects a zero or untrusted virtual price (%s) without publishing a fresh rate", async (raw) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(raw)}`);
    const context = contextWithParent();

    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
    expect(context.vaultRateWrites?.get(ID)).toBeUndefined();
  });

  it("returns unavailable for an unknown tranche or missing parent", async () => {
    const context = { assetsById: new Map() };
    await expect(idleCdoTrancheProvider.fetchLivePrice!(asset("unknown-tranche"), context)).resolves.toBeNull();
    await expect(idleCdoTrancheProvider.fetchLivePrice!(unpricedChild(ID), context)).resolves.toBeNull();
  });
});
