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
const horizon = (age = 0) => ({ history_latest_ledger_closed_at: new Date(Date.now() - age * 1000).toISOString() });
const ledger = (age = 0) => ({ jsonrpc: "2.0", id: 1, result: { sequence: 123, closeTime: String(Math.floor(Date.now() / 1000) - age) } });
const classicFetcher = (body: unknown) => vi.fn().mockResolvedValueOnce(Response.json(horizon())).mockResolvedValueOnce(Response.json(body));
const freshnessCases = ["classic", "soroban"] as const;
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
    const fetcher = classicFetcher(fixture()); vi.stubGlobal("fetch", fetcher);
    expect(await classicRead()).toBe(1200000003n);
    expect(fetcher.mock.calls[0][0]).toBe("https://horizon.stellar.org");
    const url = new URL(fetcher.mock.calls[1][0]);
    expect(url.searchParams.get("asset_issuer")).toBe(issuer);
    expect(url.searchParams.get("asset_code")).toBe("USDY");
  });
  it("admits an observed zero", async () => {
    const body = fixture(), asset = body._embedded.records[0];
    for (const key of Object.keys(asset.balances)) asset.balances[key as keyof typeof asset.balances] = "0.0000000";
    asset.claimable_balances_amount = asset.liquidity_pools_amount = asset.contracts_amount = "0.0000000";
    vi.stubGlobal("fetch", classicFetcher(body));
    expect(await classicRead()).toBe(0n);
  });
  it.each([null, {}, { _embedded: { records: [] } }, { _embedded: { records: [{ ...fixture()._embedded.records[0], contracts_amount: undefined }] } },
    { _embedded: { records: [{ ...fixture()._embedded.records[0], asset_issuer: "other" }] } },
    { _embedded: { records: [{ ...fixture()._embedded.records[0], claimable_balances_amount: "-1.0000000" }] } }])(
    "rejects absent, malformed or mismatched Horizon evidence", async (body) => {
      vi.stubGlobal("fetch", classicFetcher(body));
      await expect(classicRead()).rejects.toThrow();
    },
  );
  it.each([contract, `eurSAFO-${contract}`])("simulates Soroban decimals and total_supply for %s without submitting", async (address) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(ledger())).mockResolvedValueOnce(Response.json(simulation(3, 5n)))
      .mockResolvedValueOnce(Response.json(simulation(10, 33_000_000_000_000_000n)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchStellarSupply(address, 5, signal())).toBe(33_000_000_000_000_000n);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).method)).toEqual(["getLatestLedger", "simulateTransaction", "simulateTransaction"]);
    // Envelope/operation discriminants and exact contract bytes, independent of our encoder.
    const envelope = atob(JSON.parse(fetcher.mock.calls[2][1].body).params.transaction);
    expect(Buffer.from(envelope, "binary").toString("hex")).toBe(
      "0000000200000000" + "00".repeat(32) + "00000064000000000000000100000000000000000000000100000000000000180000000000000001"
      + "5ce11b32ac6592c49ca69b68e83c8df154da220cccea0f497a3531a5f664d37f"
      + "0000000c746f74616c5f737570706c7900000000000000000000000000000000",
    );
  });
  it.each([simulation(10, -1n), simulation(3, 5n), { error: { message: "unavailable" } },
    { ...simulation(10, 5n), result: { ...simulation(10, 5n).result, restorePreamble: {} } }])(
    "rejects malformed/failed Soroban reads", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(ledger()))
        .mockResolvedValueOnce(Response.json(simulation(3, 5n))).mockResolvedValueOnce(Response.json(body)));
      await expect(fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
    },
  );
  it.each(freshnessCases)("checks %s ledger freshness boundaries", async kind => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    for (const age of [600, -60, 601, -61]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(kind === "classic" ? horizon(age) : ledger(age)));
      if (kind === "classic") fetcher.mockResolvedValueOnce(Response.json(fixture()));
      else fetcher.mockResolvedValueOnce(Response.json(simulation(3, 5n))).mockResolvedValueOnce(Response.json(simulation(10, 1n)));
      vi.stubGlobal("fetch", fetcher);
      const result = kind === "classic" ? classicRead() : fetchStellarSupply(contract, 5, signal());
      if (age > 600 || age < -60) {
        await expect(result).rejects.toThrow("stellar-ledger-stale-or-future");
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else await expect(result).resolves.toBe(kind === "classic" ? 1200000003n : 1n);
    }
  });
  it.each(freshnessCases)("rejects missing, malformed or failed %s ledger evidence", async kind => {
    const malformed = kind === "classic" ? { history_latest_ledger_closed_at: "invalid" }
      : { ...ledger(), result: { ...ledger().result, closeTime: "invalid" } };
    for (const response of [Response.json(null), Response.json({}), Response.json(malformed), new Response("unavailable", { status: 503 })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));
      await expect(kind === "classic" ? classicRead() : fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
    }
  });
  it.each([[122, 123], [123, 122]])("rejects simulation ledgers %s/%s older than the fresh head or each other", async (scaleLedger, supplyLedger) => {
    const scale = simulation(3, 5n), supply = simulation(10, 1n);
    scale.result.latestLedger = scaleLedger; supply.result.latestLedger = supplyLedger;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(ledger()))
      .mockResolvedValueOnce(Response.json(scale)).mockResolvedValueOnce(Response.json(supply)));
    await expect(fetchStellarSupply(contract, 5, signal())).rejects.toThrow("stellar-ledger-regressed");
  });
  it("rejects invalid checksums and classic scales before network intake", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchStellarSupply(contract.slice(0, -1) + "A", 5, signal())).rejects.toThrow("checksum");
    await expect(fetchStellarSupply(`USDY-${issuer}`, 5, signal())).rejects.toThrow("decimals");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([["classic", 0], ["classic", 1], ["soroban", 0], ["soroban", 1], ["soroban", 2]] as const)(
    "bounds %s response %s bodies and timeouts", async (kind, index) => {
      for (const stalled of [false, true]) {
        vi.useFakeTimers();
        const responses = kind === "classic" ? [Response.json(horizon()), Response.json(fixture())]
          : [Response.json(ledger()), Response.json(simulation(3, 5n)), Response.json(simulation(10, 1n))];
        responses[index] = stalled ? new Response(new ReadableStream({ start() {} })) : new Response(" ".repeat(64 * 1024 + 1));
        const fetcher = vi.fn();
        for (const response of responses) fetcher.mockResolvedValueOnce(response);
        vi.stubGlobal("fetch", fetcher);
        const rejected = expect(kind === "classic" ? classicRead() : fetchStellarSupply(contract, 5, signal())).rejects.toThrow();
        if (stalled) await vi.advanceTimersByTimeAsync(10_001);
        await rejected;
        vi.useRealTimers();
      }
    },
  );
  it("propagates caller cancellation", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchStellarSupply(`USDY-${issuer}`, 7, controller.signal)).rejects.toThrow("cancelled");
  });
});
