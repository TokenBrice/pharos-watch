import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import capture from "./fixtures/coinbase-oned-por.json";
import { COINBASE_ONED_POR_URL, fetchCoinbaseOnedPorReserves, parseCoinbaseOnedPor } from "../coinbase-oned-por";

const payload = capture.capture.payload;
const now = Date.parse("2026-10-03T07:21:00Z") / 1000;
const config: LiveReservesConfig = {
  adapter: "coinbase-oned-por", version: 1, semantics: "single-asset",
  inputs: { primary: { kind: "http-json", url: COINBASE_ONED_POR_URL } },
};
function changed(change: (por: typeof payload.data.proofOfReserves) => void) {
  const copy = structuredClone(payload);
  change(copy.data.proofOfReserves);
  return copy;
}
afterEach(() => vi.unstubAllGlobals());

describe("Coinbase ONED source-native GraphQL reserves", () => {
  it("reconciles complete Base stock and USDC wallet census using the source UTC clock", () => {
    const result = parseCoinbaseOnedPor(payload, now);
    expect(result.metadata).toMatchObject({
      supplyTokens: 11857520.01,
      sourceTimestamp: Date.parse("2026-10-03T07:20:20Z") / 1000,
      details: { reportedReserveUsdc: 11857520.082376, publishedReserveWalletCount: 5 },
    });
    expect(result.slices).toEqual([expect.objectContaining({ coinId: "usdc-circle", depType: "wrapper", pct: 100 })]);
    expect(result.metadata).not.toHaveProperty("redemption");
  });
  it("rejects schema drift and partial GraphQL data, with stable machine reasons", () => {
    expect(() => parseCoinbaseOnedPor({ data: {} }, now)).toThrow("coinbase-oned-por:schema-drift");
    expect(() => parseCoinbaseOnedPor({ ...payload, errors: [{ message: "PersistedQueryNotFound" }] }, now)).toThrow("coinbase-oned-por:persisted-query-drift");
    expect(() => parseCoinbaseOnedPor({ ...payload, errors: [{ message: "wallet read failed" }] }, now)).toThrow("coinbase-oned-por:graphql-error");
  });
  it("rejects nonmatching native deployment and reserve denominations", () => {
    expect(() => parseCoinbaseOnedPor(changed((p) => { p.wrappedAssetsByNetwork[0].contractAddress = "0x0000000000000000000000000000000000000001"; }), now)).toThrow("coinbase-oned-por:deployment-mismatch");
    expect(() => parseCoinbaseOnedPor(changed((p) => { p.reserveAddresses[0].balance.currency = "USDT"; }), now)).toThrow("coinbase-oned-por:schema-drift");
  });
  it("rejects omitted or duplicate wallets rather than admitting partial reserves", () => {
    expect(() => parseCoinbaseOnedPor(changed((p) => { p.reserveAddresses.pop(); }), now)).toThrow("coinbase-oned-por:wallet-census-mismatch");
    expect(() => parseCoinbaseOnedPor(changed((p) => { p.reserveAddresses[1].address = p.reserveAddresses[0].address; }), now)).toThrow("coinbase-oned-por:wallet-census-mismatch");
  });
  it("rejects stale, future and invalid-calendar source timestamps", () => {
    expect(() => parseCoinbaseOnedPor(payload, now + 4 * 86400)).toThrow("coinbase-oned-por:stale-source");
    expect(() => parseCoinbaseOnedPor(payload, 0)).toThrow("coinbase-oned-por:future-source");
    expect(() => parseCoinbaseOnedPor(changed((p) => { p.lastUpdatedAt = "2026-02-30T07:20:20Z"; }), now)).toThrow("coinbase-oned-por:schema-drift");
  });
  it("rejects query hash changes before transport and HTTP errors without stale fallback", async () => {
    const fetcher = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const altered = { ...config, inputs: { primary: { kind: "http-json" as const, url: COINBASE_ONED_POR_URL.replace("f26fac8f", "00000000") } } };
    await expect(fetchCoinbaseOnedPorReserves({} as StablecoinMeta, altered, new AbortController().signal)).rejects.toThrow("coinbase-oned-por:persisted-query-drift");
    await expect(fetchCoinbaseOnedPorReserves({} as StablecoinMeta, config, new AbortController().signal)).rejects.toThrow("coinbase-oned-por:http-error");
  });
  it("classifies malformed JSON in a successful HTTP response as source schema drift", async () => {
    vi.stubGlobal("fetch", async () => new Response("not-json", { status: 200 }));
    await expect(fetchCoinbaseOnedPorReserves({} as StablecoinMeta, config, new AbortController().signal)).rejects.toThrow("coinbase-oned-por:schema-drift");
  });
});
