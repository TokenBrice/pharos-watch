import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import type * as FetchRetry from "../../../lib/fetch-retry";
import { fetchCoinGeckoMarketData, fetchSupplementalTrackedTokens } from "../supplemental-assets";
import { makePeggedAsset } from "./_fixtures";

const providers = vi.hoisted(() => ({
  gold: vi.fn(), silver: vi.fn(), fiat: vi.fn(), allowed: vi.fn(), outcome: vi.fn(), fetch: vi.fn(),
}));
vi.mock("../supplemental-assets/gold", () => ({ fetchGoldTokens: providers.gold }));
vi.mock("../supplemental-assets/silver", () => ({ fetchSilverTokens: providers.silver }));
vi.mock("../supplemental-assets/fiat-cg", () => ({
  FIAT_CG_METAS: [{ geckoId: "fixture-fiat" }], fetchFiatCoinGeckoTokens: providers.fiat,
}));
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: providers.allowed, recordOutcomeSafe: providers.outcome,
}));
vi.mock("../../../lib/fetch-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof FetchRetry>();
  return { ...actual, fetchTextWithRetry: providers.fetch };
});

describe("supplemental source coordinator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    providers.allowed.mockResolvedValue(true);
    providers.outcome.mockResolvedValue(undefined);
  });

  it("awaits each family before starting the next and preserves the separate outputs", async () => {
    const order: string[] = [];
    const gold = [makePeggedAsset({ id: "gold-fixture" })];
    const silver = [makePeggedAsset({ id: "silver-fixture" })];
    const fiat = [makePeggedAsset({ id: "fiat-fixture" })];
    providers.gold.mockImplementation(async () => { order.push("gold-start"); await Promise.resolve(); order.push("gold-end"); return gold; });
    providers.silver.mockImplementation(async () => { order.push("silver-start"); await Promise.resolve(); order.push("silver-end"); return silver; });
    providers.fiat.mockImplementation(async () => { order.push("fiat-start"); return fiat; });
    expect(await fetchSupplementalTrackedTokens({})).toEqual({ goldTokens: gold, silverTokens: silver, fiatCgTokens: fiat });
    expect(order).toEqual(["gold-start", "gold-end", "silver-start", "silver-end", "fiat-start"]);
  });

  it("does not start provider families when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchSupplementalTrackedTokens({}, controller.signal)).rejects.toThrow();
    expect(providers.gold).not.toHaveBeenCalled();
    expect(providers.silver).not.toHaveBeenCalled();
    expect(providers.fiat).not.toHaveBeenCalled();
  });

  it("retains upstream market-cap clocks and records successful parsing", async () => {
    const db = mockD1([]);
    const quote = { "fixture-fiat": { usd: 1.1, usd_market_cap: 900, last_updated_at: 1_777_000_000 } };
    providers.fetch.mockResolvedValue({ response: new Response(JSON.stringify(quote)), body: JSON.stringify(quote) });
    expect(await fetchCoinGeckoMarketData(db)).toEqual(quote);
    expect(providers.outcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_MCAP, true);
  });

  it("keeps an open-circuit read unavailable without recording a fictitious successful fetch", async () => {
    providers.allowed.mockResolvedValue(false);
    expect(await fetchCoinGeckoMarketData(mockD1([]))).toEqual({});
    expect(providers.fetch).not.toHaveBeenCalled();
    expect(providers.outcome).not.toHaveBeenCalled();
  });

  it("rejects a corrupt response instead of publishing synthetic market-cap values", async () => {
    const db = mockD1([]);
    providers.fetch.mockResolvedValue({ response: new Response("invalid-json"), body: "invalid-json" });
    expect(await fetchCoinGeckoMarketData(db)).toEqual({});
    expect(providers.outcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_MCAP, false);
  });
});
