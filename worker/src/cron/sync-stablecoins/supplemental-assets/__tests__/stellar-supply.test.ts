import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStellarSupply } from "../stellar-supply";

const issuer = "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6";
const contract = "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP";
const fixture = () => ({ _embedded: { records: [{
  asset_code: "USDY", asset_issuer: issuer, amount: "999999.0000000",
  balances: { authorized: "100.0000001", authorized_to_maintain_liabilities: "2.0000000", unauthorized: "3.0000000" },
  claimable_balances_amount: "4.0000000", liquidity_pools_amount: "5.0000000", contracts_amount: "6.0000002",
}] } });
const signal = () => new AbortController().signal;
const classicRead = () => fetchStellarSupply(`USDY-${issuer}`, 7, signal());
function scval(type: 3 | 10, n: bigint): string {
  const bytes = new Uint8Array(type === 3 ? 8 : 20), view = new DataView(bytes.buffer);
  view.setUint32(0, type);
  if (type === 3) view.setUint32(4, Number(n));
  else { view.setBigInt64(4, n >> 64n); view.setBigUint64(12, n & ((1n << 64n) - 1n)); }
  return btoa(String.fromCharCode(...bytes));
}
const simulation = (type: 3 | 10, n: bigint) => ({ jsonrpc: "2.0", id: 1, result: {
  latestLedger: 123, results: [{ auth: [], xdr: scval(type, n) }],
} });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Stellar supply", () => {
  it("sums all six disjoint Horizon amounts exactly, including SAC, pools and frozen balances", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(fixture())); vi.stubGlobal("fetch", fetcher);
    expect(await classicRead()).toBe(1200000003n);
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get("asset_issuer")).toBe(issuer);
    expect(url.searchParams.get("asset_code")).toBe("USDY");
  });
  it("admits an observed zero", async () => {
    const body = fixture(), asset = body._embedded.records[0];
    for (const key of Object.keys(asset.balances)) asset.balances[key as keyof typeof asset.balances] = "0.0000000";
    asset.claimable_balances_amount = asset.liquidity_pools_amount = asset.contracts_amount = "0.0000000";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    expect(await classicRead()).toBe(0n);
  });
  it.each([null, {}, { _embedded: { records: [] } }, { _embedded: { records: [{ ...fixture()._embedded.records[0], contracts_amount: undefined }] } },
    { _embedded: { records: [{ ...fixture()._embedded.records[0], asset_issuer: "other" }] } },
    { _embedded: { records: [{ ...fixture()._embedded.records[0], claimable_balances_amount: "-1.0000000" }] } }])(
    "rejects absent, malformed or mismatched Horizon evidence", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(classicRead()).rejects.toThrow();
    },
  );
  it.each([contract, `eurSAFO-${contract}`])("simulates Soroban decimals and total_supply for %s without submitting", async (address) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(simulation(3, 5n)))
      .mockResolvedValueOnce(Response.json(simulation(10, 33_000_000_000_000_000n)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchStellarSupply(address, 5, signal())).toBe(33_000_000_000_000_000n);
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(init.body).method).toBe("simulateTransaction");
    // Envelope/operation discriminants and exact contract bytes, independent of our encoder.
    const envelope = atob(JSON.parse(fetcher.mock.calls[1][1].body).params.transaction);
    expect(Buffer.from(envelope, "binary").toString("hex")).toBe(
      "0000000200000000" + "00".repeat(32) + "00000064000000000000000100000000000000000000000100000000000000180000000000000001"
      + "5ce11b32ac6592c49ca69b68e83c8df154da220cccea0f497a3531a5f664d37f"
      + "0000000c746f74616c5f737570706c7900000000000000000000000000000000",
    );
  });
  it.each([simulation(10, -1n), simulation(3, 5n), { error: { message: "unavailable" } },
    { ...simulation(10, 5n), result: { ...simulation(10, 5n).result, restorePreamble: {} } }])(
    "rejects malformed/failed Soroban reads", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(simulation(3, 5n))).mockResolvedValueOnce(Response.json(body)));
      await expect(fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
    },
  );
  it("rejects invalid checksums and classic scales before network intake", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchStellarSupply(contract.slice(0, -1) + "A", 5, signal())).rejects.toThrow("checksum");
    await expect(fetchStellarSupply(`USDY-${issuer}`, 5, signal())).rejects.toThrow("decimals");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["classic", "soroban"])("rejects oversized %s bodies", async (kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(64 * 1024 + 1))));
    await expect(kind === "classic" ? classicRead() : fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
  });
  it.each(["classic", "soroban"])("times out a stalled %s body", async (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))));
    const rejected = expect(kind === "classic" ? classicRead() : fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
  });
  it("propagates caller cancellation", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchStellarSupply(`USDY-${issuer}`, 7, controller.signal)).rejects.toThrow("cancelled");
  });
});
