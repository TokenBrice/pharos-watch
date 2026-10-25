import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsdyAptosSupply } from "../usdy-aptos-supply";

const address = "0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc";
const type = `0x1::coin::CoinInfo<${address}::usdy::USDY>`;
const ledger = () => ({ chain_id: 1, ledger_version: "7764535205", ledger_timestamp: String(BigInt(Date.now()) * 1000n) });
const fixture = () => ({ type, data: { decimals: 6, symbol: "USDY", supply: { vec: [{
  aggregator: { vec: [] }, integer: { vec: [{ value: "1249289" }] },
}] } } });
const read = () => fetchUsdyAptosSupply(address, 6, new AbortController().signal);
afterEach(() => vi.unstubAllGlobals());
describe("USDY legacy Aptos Coin supply", () => {
  it("reads the exact resource at the observed ledger version", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ledger())).mockResolvedValueOnce(Response.json(fixture()));
    vi.stubGlobal("fetch", fetcher);
    expect(await read()).toBe(1249289n);
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(decodeURIComponent(url.pathname)).toContain(type);
    expect(url.searchParams.get("ledger_version")).toBe("7764535205");
  });
  it.each(["missing", "type", "scale", "symbol", "aggregator", "negative", "overflow", "wrong-chain", "stale"])("withholds %s evidence", async (failure) => {
    const head = ledger(), body = fixture();
    if (failure === "missing") body.data.supply.vec = [];
    if (failure === "type") body.type = "wrong";
    if (failure === "scale") body.data.decimals = 9;
    if (failure === "symbol") body.data.symbol = "wrong";
    if (failure === "aggregator") body.data.supply.vec[0].aggregator.vec.push({} as never);
    if (failure === "negative") body.data.supply.vec[0].integer.vec[0].value = "-1";
    if (failure === "overflow") body.data.supply.vec[0].integer.vec[0].value = (1n << 128n).toString();
    if (failure === "wrong-chain") head.chain_id = 2;
    if (failure === "stale") head.ledger_timestamp = "1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(head)).mockResolvedValueOnce(Response.json(body)));
    await expect(read()).rejects.toThrow();
  });
});
