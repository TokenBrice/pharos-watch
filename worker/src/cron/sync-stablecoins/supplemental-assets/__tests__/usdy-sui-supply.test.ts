import { afterEach, describe, expect, it, vi } from "vitest";
import { USDY_SUI_COIN_TYPE } from "@shared/lib/onchain-supply-probe";
import { fetchUsdySuiSupply } from "../usdy-sui-supply";

const fixture = () => ({ data: {
  checkpoint: { timestamp: new Date().toISOString() }, coinMetadata: { decimals: 6, symbol: "USDY", supply: "9123456789000" },
} });
const read = () => fetchUsdySuiSupply(USDY_SUI_COIN_TYPE, 6, new AbortController().signal);
afterEach(() => vi.unstubAllGlobals());
describe("USDY Sui supply", () => {
  it("reads the exact coin's supply with its own checkpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(fixture())));
    expect(await read()).toBe(9123456789000n);
  });
  it.each(["null", "scale", "symbol", "missing", "negative", "overflow", "stale", "future", "errors"])("rejects %s evidence", async (failure) => {
    const body = fixture();
    if (failure === "scale") body.data.coinMetadata.decimals = 9;
    if (failure === "symbol") body.data.coinMetadata.symbol = "wrong";
    if (failure === "missing") Reflect.deleteProperty(body.data.coinMetadata, "supply");
    if (failure === "negative") body.data.coinMetadata.supply = "-1";
    if (failure === "overflow") body.data.coinMetadata.supply = "18446744073709551616";
    if (failure === "stale" || failure === "future") body.data.checkpoint.timestamp = new Date(Date.now() + (failure === "stale" ? -601_000 : 61_000)).toISOString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(failure === "null" ? { data: { ...body.data, coinMetadata: null } }
      : failure === "errors" ? { ...body, errors: [{}] } : body)));
    await expect(read()).rejects.toThrow();
  });
});
