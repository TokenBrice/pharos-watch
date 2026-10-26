import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsdyAptosSupply } from "../usdy-aptos-supply";

const address = "0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc";
const type = `0x1::coin::CoinInfo<${address}::usdy::USDY>`;
const ledger = () => ({ chain_id: 1, ledger_version: "7764535205", ledger_timestamp: String(BigInt(Date.now()) * 1000n) });
const fixture = () => ({ type, data: { decimals: 6, symbol: "USDY", supply: { vec: [{
  aggregator: { vec: [] }, integer: { vec: [{ value: "1249289" }] },
}] } } });
const supplyView = (value = "1683249289") => [{ vec: [value] }];
const read = () => fetchUsdyAptosSupply(address, 6, new AbortController().signal);
afterEach(() => vi.unstubAllGlobals());
describe("USDY Aptos Coin and paired fungible-asset supply", () => {
  it("reads complete supply and identity at the same observed ledger version", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ledger())).mockResolvedValueOnce(Response.json(fixture()))
      .mockResolvedValueOnce(Response.json(supplyView()));
    vi.stubGlobal("fetch", fetcher);
    expect(await read()).toBe(1683249289n);
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(decodeURIComponent(url.pathname)).toContain(type);
    expect(url.searchParams.get("ledger_version")).toBe("7764535205");
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get("ledger_version")).toBe("7764535205");
    expect(fetcher.mock.calls[2][1].method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      function: "0x1::coin::supply", type_arguments: [`${address}::usdy::USDY`], arguments: [],
    });
  });
  it.each(["type", "scale", "symbol", "wrong-chain", "stale"])("withholds %s evidence", async (failure) => {
    const head = ledger(), body = fixture();
    if (failure === "type") body.type = "wrong";
    if (failure === "scale") body.data.decimals = 9;
    if (failure === "symbol") body.data.symbol = "wrong";
    if (failure === "wrong-chain") head.chain_id = 2;
    if (failure === "stale") head.ledger_timestamp = "1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(head)).mockResolvedValueOnce(Response.json(body)));
    await expect(read()).rejects.toThrow();
  });
  it.each([null, [], [{ vec: [] }], [{ vec: ["1", "2"] }], ...["-1", "1.5", "1e6", (1n << 128n).toString(), 123]
    .map(value => [{ vec: [value] }])])("withholds missing or invalid view supply %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(ledger())).mockResolvedValueOnce(Response.json(fixture()))
      .mockResolvedValueOnce(Response.json(body)));
    await expect(read()).rejects.toThrow();
  });
  it("retains observed zero and never falls back to legacy supply on a failed view", async () => {
    for (const response of [Response.json(supplyView("0")), new Response("unavailable", { status: 503 })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(ledger())).mockResolvedValueOnce(Response.json(fixture()))
        .mockResolvedValueOnce(response));
      if (response.ok) expect(await read()).toBe(0n);
      else await expect(read()).rejects.toThrow();
    }
  });
});
