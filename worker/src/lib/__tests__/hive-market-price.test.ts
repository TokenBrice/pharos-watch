import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import samples from "./fixtures/hive-market-samples.json";
import { HiveMarketDiagnosticSchema } from "@shared/types/hive-market-price";
import { fetchHiveNativeHbdPrice, HIVE_MARKET_POLICY, type HiveUsdParent } from "../hive-market-price";

const NOW = 1_792_391_400;
const date = (time: number) => new Date(time * 1000).toISOString().slice(0, 19);
const parent = (): HiveUsdParent => ({ id: "hive", price: 0.05, observedAt: NOW - 3, observedAtMode: "upstream" });
function row(side: "bid" | "ask", price: number, hbd = 500_000) {
  return { real_price: String(price), hbd, hive: Math.floor(hbd / price), order_price: side === "bid" ? { base: `${(price * 1000).toFixed(3)} HBD`, quote: "1000.000 HIVE" } : { base: "1000.000 HIVE", quote: `${(price * 1000).toFixed(3)} HBD` } };
}
function sample() {
  return {
    head: { head_block_number: 123, time: date(NOW) },
    book: { bids: [row("bid", 0.0499)], asks: [row("ask", 0.0501)] },
    ticker: { hbd_volume: "1000.000 HBD", hive_volume: "20000.000 HIVE" },
    trades: [{ date: date(NOW - 5), current_pays: "1000.000 HBD", open_pays: "20000.000 HIVE", maker: "alice", taker: "bob" }],
  };
}
function mockSample(data: { head: unknown; book: unknown; ticker: unknown; trades: unknown }, postHead = data.head) {
  const heads = new Map<string, number>();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const { id, method } = JSON.parse(init.body as string);
    const headCount = heads.get(url) ?? 0;
    if (method === "condenser_api.get_dynamic_global_properties") heads.set(url, headCount + 1);
    const values: Record<string, unknown> = {
      "condenser_api.get_dynamic_global_properties": headCount === 0 ? data.head : postHead,
      "condenser_api.get_order_book": data.book,
      "condenser_api.get_ticker": data.ticker,
      "condenser_api.get_recent_trades": data.trades,
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: values[method] }));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Hive native market admission", () => {
  it("inverts HBD/HIVE, preserves parent time, and reports executable reversed bounds", async () => {
    mockSample(sample());
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(result.quote).toEqual({ price: 1, observedAt: NOW - 3, observedAtMode: "local_fetch" });
    expect(result.diagnostic).toMatchObject({ bidDepthHbd: 500, askDepthHbd: 500, volumeHbd: 1000, usdBid: 0.05 / 0.0501, usdAsk: 0.05 / 0.0499, rpcCount: 5, rejectionReason: null });
    expect(HiveMarketDiagnosticSchema.safeParse(result.diagnostic).success).toBe(true);
  });
  it.each(samples.samples.map((value, index) => [index, value] as const))("admits captured live sample %i without treating identical fill tuples as extra proof", async (_index, data) => {
    const time = Math.floor(Date.parse(data.retrievedAt) / 1000);
    vi.setSystemTime(time * 1000);
    mockSample(data);
    const result = await fetchHiveNativeHbdPrice({ ...parent(), price: 0.04872914, observedAt: time - 4 });
    expect(result.diagnostic.rejectionReason).toBeNull();
    expect(result.quote?.price).toBeCloseTo(0.9866216936, 8);
    expect(result.diagnostic.volumeHbd).toBeGreaterThanOrEqual(1000);
    expect(result.diagnostic.duplicateTradeRows).toBeGreaterThan(0);
  });
  it("rejects the prior failed-depth book without a second node or original-amount inflation", async () => {
    const data = sample();
    const fetcher = mockSample({ ...data, book: samples.priorBook });
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(result.diagnostic.rejectionReason).toBe("insufficient_depth");
    expect(result.diagnostic.bidDepthHbd).toBeCloseTo(448.939, 3);
    expect(result.diagnostic.askDepthHbd).toBeCloseTo(104.488, 3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([499_999, 500_000])("enforces milliunit depth boundary %i", async (depth) => {
    const data = sample(); data.book.bids[0].hbd = depth;
    mockSample(data);
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(result.diagnostic.rejectionReason).toBe(depth === 500_000 ? null : "insufficient_depth");
  });
  it.each([0.049, 0.048999, 0.051, 0.051001])("counts exact band boundaries but not outside: %s", async (price) => {
    const data = sample();
    const side = price < 0.05 ? "bids" : "asks";
    data.book[side][0].hbd = 1;
    data.book[side].push(row(side === "bids" ? "bid" : "ask", price, 499_999));
    mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe(price === 0.049 || price === 0.051 ? null : "insufficient_depth");
  });
  it.each([999, 1000])("treats capped depth as a lower bound: %i milliunits per row", async (amount) => {
    const data = sample(); data.book.asks = Array.from({ length: 500 }, () => row("ask", 0.0501, amount));
    mockSample(data);
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(result.diagnostic.askDepthComplete).toBe(false);
    expect(result.diagnostic.rejectionReason).toBe(amount === 1000 ? null : "depth_unproven");
  });
  it.each(["NaN", "Infinity", "-1", "5e-2", "", " 0.0499"])("rejects non-decimal price %j", async (price) => {
    const data = sample(); data.book.bids[0].real_price = price;
    mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("invalid_response");
  });
  it.each([-1, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5])("rejects unsafe inventory %s", async (amount) => {
    const data = sample(); data.book.asks[0].hbd = amount; mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("invalid_response");
  });
  it.each(["HIVE", "SBD", "USDT"])("enforces order symbol direction %s", async (symbol) => {
    const data = sample(); data.book.bids[0].order_price.base = `49.900 ${symbol}`; mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("invalid_response");
  });
  it.each(["empty", "crossed", "unsorted", "wide"])("rejects %s book", async (kind) => {
    const data = sample();
    if (kind === "empty") data.book.asks = [];
    if (kind === "crossed") data.book.bids = [row("bid", 0.051)];
    if (kind === "unsorted") data.book.bids.push(row("bid", 0.05));
    if (kind === "wide") data.book.asks = [row("ask", 0.06)];
    mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe(({ empty: "book_empty", crossed: "book_crossed", unsorted: "invalid_response", wide: "spread_exceeded" })[kind]);
  });
});

describe("trade and parent clocks", () => {
  it.each([899, 900, 901])("enforces recent trade age %i", async (age) => {
    const data = sample(); data.trades[0].date = date(NOW - age); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe(age <= 900 ? null : "trade_stale");
  });
  it("counts the opposite payment orientation exactly once and tolerates diagnostic ticker disagreement", async () => {
    const data = sample(); data.trades[0].current_pays = "20000.000 HIVE"; data.trades[0].open_pays = "1000.000 HBD"; data.ticker.hbd_volume = "1234.000 HBD"; mockSample(data);
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(result.quote?.price).toBe(1); expect(result.diagnostic.tickerVolumeDifferenceHbd).toBe(234);
  });
  it("filters self-trades and duplicate tuples, but retains distinct fills at the same timestamp", async () => {
    const data = sample(); data.trades[0].current_pays = "500.000 HBD"; data.trades[0].open_pays = "10000.000 HIVE";
    data.trades.push({ ...data.trades[0] }); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("volume_unproven");
    data.trades.push({ ...data.trades[0], maker: "carol" }); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).quote?.price).toBe(1);
    data.trades.forEach((trade) => { trade.taker = trade.maker; }); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("trade_stale");
  });
  it.each([86400, 86401])("includes exact daily window boundary %i", async (age) => {
    const data = sample(); data.trades[0].current_pays = "1.000 HBD"; data.trades[0].open_pays = "20.000 HIVE";
    data.trades.push({ ...data.trades[0], date: date(NOW - age), current_pays: "999.000 HBD", open_pays: "19980.000 HIVE" }); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe(age === 86400 ? null : "insufficient_volume");
  });
  it("reports an incomplete capped volume proof, not zero or a total", async () => {
    const data = sample(); data.trades = Array.from({ length: 1000 }, (_, i) => ({ ...data.trades[0], maker: `maker${i}`, current_pays: "0.999 HBD", open_pays: "19.980 HIVE" })); mockSample(data);
    const result = await fetchHiveNativeHbdPrice(parent()); expect(result.diagnostic).toMatchObject({ volumeHbd: 999, volumeComplete: false, rejectionReason: "volume_unproven" });
  });
  it("rejects an untraded book dislocation", async () => {
    const data = sample(); data.trades[0].open_pays = "25000.000 HIVE"; mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("trade_book_divergence");
  });
  it.each([300, 301, -60, -61])("enforces signed parent age %i", async (age) => {
    mockSample(sample()); const result = await fetchHiveNativeHbdPrice({ ...parent(), observedAt: NOW - age });
    expect(result.diagnostic.parent.ageSec).toBe(age);
    expect(result.diagnostic.rejectionReason).toBe(age > 300 || age < -60 ? "hive_usd_stale" : null);
    if (age < 0 && result.quote) expect(result.quote.observedAt).toBe(NOW);
  });
  it.each([{ id: "hive_dollar" }, { id: "USDT" }, { price: 0 }, { price: NaN }, { observedAt: null }, { observedAtMode: "local_fetch" }])("fails closed without an independently observed exact HIVE/USD parent: %j", async (override) => {
    const fetcher = mockSample(sample());
    expect((await fetchHiveNativeHbdPrice({ ...parent(), ...override })).diagnostic.rejectionReason).toBe("hive_usd_unavailable"); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("bounded serial transport", () => {
  it("fails over as a whole sample and never joins bodies across nodes", async () => {
    const data = sample(); const healthy = mockSample(data);
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push(url);
      const request = JSON.parse(init.body as string);
      if (url.includes("hive.blog")) return new Response("bad", { status: 503 });
      const values: Record<string, unknown> = { get_dynamic_global_properties: data.head, get_order_book: data.book, get_ticker: data.ticker, get_recent_trades: data.trades };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: values[request.method.split(".")[1]] }));
    }));
    const result = await fetchHiveNativeHbdPrice(parent()); expect(result.quote?.price).toBe(1); expect(seen).toHaveLength(6); expect(result.diagnostic.node).toBe("api.deathwing.me"); expect(healthy).not.toHaveBeenCalled();
  });
  it.each(["id", "error", "json", "429", "oversize"])("bounds failure %s to two nodes and cleans bodies", async (kind) => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => {
      if (kind === "oversize" || kind === "429") return new Response(new ReadableStream({ cancel }), { status: kind === "429" ? 429 : 200, headers: { "Content-Length": String(HIVE_MARKET_POLICY.maxResponseBytes + 1) } });
      return new Response(kind === "json" ? "{" : JSON.stringify(kind === "id" ? { jsonrpc: "2.0", id: 0, result: sample().head } : { jsonrpc: "2.0", id: fetcher.mock.calls.length, error: { code: -1 } }));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchHiveNativeHbdPrice(parent());
    expect(fetcher).toHaveBeenCalledTimes(2); expect(result.quote).toBeNull();
    expect(result.diagnostic.rejectionReason).toBe(kind === "429" ? "rate_limited" : kind === "error" ? "rpc_error" : "invalid_response");
    if (kind === "oversize" || kind === "429") expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("times out stalled bodies and never requests a third node", async () => {
    const cancel = vi.fn(); const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }))); vi.stubGlobal("fetch", fetcher);
    const pending = fetchHiveNativeHbdPrice(parent()); await vi.advanceTimersByTimeAsync(6001);
    expect((await pending).diagnostic.rejectionReason).toBe("rpc_timeout"); expect(fetcher).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("honors inherited abort and an already-expired absolute deadline before transport", async () => {
    const fetcher = mockSample(sample()); const controller = new AbortController(); controller.abort();
    expect((await fetchHiveNativeHbdPrice(parent(), { signal: controller.signal })).diagnostic.rejectionReason).toBe("aborted");
    expect((await fetchHiveNativeHbdPrice(parent(), { deadlineMs: Date.now() - 1 })).diagnostic.rejectionReason).toBe("deadline_exceeded"); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["abort", "deadline"])("cancels an in-flight body on inherited %s", async (mode) => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = fetchHiveNativeHbdPrice(parent(), { signal: controller.signal, deadlineMs: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1);
    if (mode === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).diagnostic.rejectionReason).toBe(mode === "abort" ? "aborted" : "deadline_exceeded");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rechecks the parent at composition after a moving sample", async () => {
    const fetcher = mockSample(sample(), { head_block_number: 124, time: date(NOW + 2) });
    const implementation = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (JSON.parse(init.body as string).id === 5) vi.setSystemTime((NOW + 2) * 1000);
      return implementation(url, init);
    });
    const result = await fetchHiveNativeHbdPrice({ ...parent(), observedAt: NOW - 299 });
    expect(result.diagnostic).toMatchObject({ rejectionReason: "hive_usd_stale", sampleDurationMs: 2000, parent: { ageSec: 301 } });
    expect(result.quote).toBeNull();
  });
  it("distinguishes unavailable inventory from an observed empty side", async () => {
    const data = sample();
    data.book.bids[0].hbd = 0; mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic).toMatchObject({ bidDepthHbd: 0, rejectionReason: "insufficient_depth" });
    Reflect.deleteProperty(data.book.bids[0], "hbd"); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic).toMatchObject({ bidDepthHbd: null, rejectionReason: "invalid_response" });
  });
  it("rejects stale and regressing heads without accepting fresh order creation as freshness", async () => {
    const data = sample(); data.head.time = date(NOW - 61); mockSample(data);
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("head_stale");
    data.head.time = date(NOW); mockSample(data, { ...data.head, head_block_number: 122 });
    expect((await fetchHiveNativeHbdPrice(parent())).diagnostic.rejectionReason).toBe("head_stale");
  });
});
