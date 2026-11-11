import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USDY_SUI_COIN_TYPE } from "@shared/lib/onchain-supply-probe";
import { fetchUsdySuiSupply } from "../usdy-sui-supply";

const fixture = () => ({ data: {
  checkpoint: { timestamp: new Date().toISOString() }, coinMetadata: { decimals: 6, symbol: "USDY", supply: "9123456789000" },
} });
const read = () => fetchUsdySuiSupply(USDY_SUI_COIN_TYPE, 6, new AbortController().signal);
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(1_800_000_000_000));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("USDY Sui supply", () => {
  it("reads the exact coin's supply with its own checkpoint", async () => {
    vi.stubGlobal("fetch", async () => Response.json(fixture()));
    expect(await read()).toBe(9123456789000n);
  });
  it.each(["null", "scale", "symbol", "missing", "negative", "overflow", "stale", "future", "errors"])("rejects %s evidence", async (bad) => {
    const body = fixture(), coin = body.data.coinMetadata;
    if (bad === "scale") coin.decimals = 9;
    if (bad === "symbol") coin.symbol = "wrong";
    if (bad === "missing") Reflect.deleteProperty(coin, "supply");
    if (bad === "negative") coin.supply = "-1";
    if (bad === "overflow") coin.supply = "18446744073709551616";
    if (bad === "stale" || bad === "future") body.data.checkpoint.timestamp = new Date(Date.now() + (bad === "stale" ? -601_000 : 61_000)).toISOString();
    vi.stubGlobal("fetch", async () => Response.json(bad === "null" ? { data: { ...body.data, coinMetadata: null } }
      : bad === "errors" ? { ...body, errors: [{}] } : body));
    await expect(read()).rejects.toThrow();
  });
});
