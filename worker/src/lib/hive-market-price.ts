import type { HiveMarketDiagnostic, HiveMarketRejection, HiveNativePriceQuote } from "@shared/types/hive-market-price";
import { fetchJsonWithRetry } from "./fetch-retry";
import { isResponseBodyTooLargeError } from "./response-body";

export const HIVE_MARKET_POLICY = Object.freeze({
  headMaxAgeSec: 60, headFutureSkewSec: 15, sampleMaxMs: 30_000,
  spreadMax: 0.01, depthBand: 0.02, depthMinHbd: 500,
  volumeWindowSec: 86_400, volumeMinHbd: 1_000, tradeMaxAgeSec: 900,
  tradeDivergenceMax: 0.02, parentMaxAgeSec: 300, parentFutureSkewSec: 60,
  sourceMaxAgeSec: 900, rpcTimeoutMs: 3_000, observerTimeoutMs: 20_000,
  maxResponseBytes: 1024 * 1024, bookLimit: 500, tradeLimit: 1000,
});
const NODES = ["https://api.hive.blog", "https://api.deathwing.me"] as const;
const METHODS = ["get_dynamic_global_properties", "get_order_book", "get_ticker", "get_recent_trades", "get_dynamic_global_properties"];
const FAILOVER_REASONS: Partial<Record<HiveMarketRejection, true>> = {
  rpc_timeout: true, rpc_error: true, rate_limited: true, invalid_response: true, head_stale: true,
};
export interface HiveUsdParent { id: string; price: number; observedAt: number | null; observedAtMode: string | null }
export interface HiveMarketResult { quote: HiveNativePriceQuote | null; diagnostic: HiveMarketDiagnostic; transportHealthy: boolean }
class Rejected extends Error {
  constructor(readonly reason: HiveMarketRejection) { super(reason); }
}
function reject(reason: HiveMarketRejection): never { throw new Rejected(reason); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid_response");
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+|)$/.test(value)) reject("invalid_response");
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) reject("invalid_response");
  return n;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) reject("invalid_response");
  return value;
}
function asset(value: unknown, symbol: "HBD" | "HIVE", allowZero = false): number {
  if (typeof value !== "string") reject("invalid_response");
  const match = /^(\d+)\.(\d{3}) (HBD|HIVE)$/.exec(value);
  if (!match || match[3] !== symbol) reject("invalid_response");
  const milli = Number(match[1]) * 1000 + Number(match[2]);
  if (!Number.isSafeInteger(milli) || milli < 0 || (!allowZero && milli === 0)) reject("invalid_response");
  return milli;
}
function parseHiveTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) reject("invalid_response");
  const ms = Date.parse(`${value}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value) reject("invalid_response");
  return ms / 1000;
}
function readHead(value: unknown, now: number) {
  const row = object(value);
  const head = { number: integer(row.head_block_number), time: parseHiveTime(row.time) };
  if (now - head.time > HIVE_MARKET_POLICY.headMaxAgeSec || head.time - now > HIVE_MARKET_POLICY.headFutureSkewSec) reject("head_stale");
  return head;
}

function inspectHiveBook(value: unknown, packet: HiveMarketDiagnostic): void {
  const book = object(value);
  const sides = [book.bids, book.asks];
  const parsed = sides.map((side, index) => {
    if (!Array.isArray(side) || side.length > HIVE_MARKET_POLICY.bookLimit) reject("invalid_response");
    if (!side.length) reject("book_empty");
    let previous = index === 0 ? Infinity : 0;
    return side.map((entry) => {
      const row = object(entry);
      const price = positive(row.real_price);
      const order = object(row.order_price);
      const base = asset(order.base, index === 0 ? "HBD" : "HIVE");
      const quote = asset(order.quote, index === 0 ? "HIVE" : "HBD");
      const ratio = index === 0 ? base / quote : quote / base;
      if (Math.abs(price / ratio - 1) > 1e-10 || (index === 0 ? price > previous : price < previous)) reject("invalid_response");
      previous = price;
      const hbd = integer(row.hbd);
      integer(row.hive);
      return { price, hbd };
    });
  });
  const [bids, asks] = parsed;
  const bid = bids[0].price;
  const ask = asks[0].price;
  if (bid >= ask) reject("book_crossed");
  const mid = (bid + ask) / 2;
  Object.assign(packet, { bid, ask, mid, spread: (ask - bid) / mid });
  if (packet.spread! > HIVE_MARKET_POLICY.spreadMax) reject("spread_exceeded");
  const depths = parsed.map((side, index) => {
    const inBand = (price: number) => index === 0 ? price >= mid * (1 - HIVE_MARKET_POLICY.depthBand) : price <= mid * (1 + HIVE_MARKET_POLICY.depthBand);
    let milli = 0;
    for (const row of side) if (inBand(row.price)) milli = integer(milli + row.hbd);
    return { hbd: milli / 1000, complete: side.length < HIVE_MARKET_POLICY.bookLimit || !inBand(side[side.length - 1].price) };
  });
  Object.assign(packet, { bidDepthHbd: depths[0].hbd, askDepthHbd: depths[1].hbd, bidDepthComplete: depths[0].complete, askDepthComplete: depths[1].complete });
  for (const depth of depths) if (depth.hbd < HIVE_MARKET_POLICY.depthMinHbd) reject(depth.complete ? "insufficient_depth" : "depth_unproven");
}

function inspectHiveTrades(value: unknown, now: number, packet: HiveMarketDiagnostic): void {
  if (!Array.isArray(value) || value.length > HIVE_MARKET_POLICY.tradeLimit) reject("invalid_response");
  let previous = Infinity;
  let oldest: number | null = null;
  let latest: { time: number; rate: number } | null = null;
  let milli = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const entry of value) {
    const row = object(entry);
    const time = parseHiveTime(row.date);
    if (time > previous || time > now + HIVE_MARKET_POLICY.headFutureSkewSec) reject("invalid_response");
    previous = time;
    oldest = time;
    if (typeof row.maker !== "string" || !row.maker || typeof row.taker !== "string" || !row.taker) reject("invalid_response");
    const currentIsHbd = typeof row.current_pays === "string" && row.current_pays.endsWith(" HBD");
    const hbd = asset(currentIsHbd ? row.current_pays : row.open_pays, "HBD");
    const hive = asset(currentIsHbd ? row.open_pays : row.current_pays, "HIVE");
    if (row.maker === row.taker) continue;
    // The RPC has no fill ID. Identical tuples are ambiguous, so count one in
    // the proven lower bound, not once per timestamp (distinct fills survive).
    const key = JSON.stringify([time, row.maker, row.taker, row.current_pays, row.open_pays]);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    latest ??= { time, rate: hbd / hive };
    if (time >= now - HIVE_MARKET_POLICY.volumeWindowSec) milli = integer(milli + hbd);
  }
  const windowComplete = value.length < HIVE_MARKET_POLICY.tradeLimit || (oldest != null && oldest <= now - HIVE_MARKET_POLICY.volumeWindowSec);
  Object.assign(packet, { volumeHbd: milli / 1000, volumeComplete: windowComplete && duplicates === 0, duplicateTradeRows: duplicates, tradeAgeSec: latest ? now - latest.time : null });
  if (!latest || now - latest.time > HIVE_MARKET_POLICY.tradeMaxAgeSec) reject("trade_stale");
  if (Math.abs(latest.rate / packet.mid! - 1) > HIVE_MARKET_POLICY.tradeDivergenceMax) reject("trade_book_divergence");
  if (milli / 1000 < HIVE_MARKET_POLICY.volumeMinHbd) reject(packet.volumeComplete ? "insufficient_volume" : "volume_unproven");
}

function admitParent(parent: HiveUsdParent | undefined, now: number, packet: HiveMarketDiagnostic): asserts parent is HiveUsdParent & { observedAt: number } {
  if (!parent || parent.id !== "hive" || !Number.isFinite(parent.price) || parent.price <= 0 || parent.observedAtMode !== "upstream" || parent.observedAt == null || !Number.isFinite(parent.observedAt) || parent.observedAt <= 0) reject("hive_usd_unavailable");
  packet.parent = { id: "hive", source: "coingecko", price: parent.price, observedAt: parent.observedAt, ageSec: now - parent.observedAt };
  if (packet.parent.ageSec! > HIVE_MARKET_POLICY.parentMaxAgeSec || packet.parent.ageSec! < -HIVE_MARKET_POLICY.parentFutureSkewSec) reject("hive_usd_stale");
}
function emptyPacket(generation: number): HiveMarketDiagnostic {
  return {
    stablecoinId: "hbd-hive", source: "hive-native-cg", generation, policyVersion: 1, policy: HIVE_MARKET_POLICY,
    node: null, methods: METHODS.map((method) => `condenser_api.${method}`), rpcCount: 0,
    preHead: null, postHead: null, bookRetrievedAt: null, sampleDurationMs: null,
    pair: "HBD/HIVE", units: "HBD per HIVE", bid: null, ask: null, mid: null, spread: null,
    bidDepthHbd: null, askDepthHbd: null, bidDepthComplete: null, askDepthComplete: null,
    tradeAgeSec: null, volumeHbd: null, volumeComplete: null, duplicateTradeRows: null,
    tickerVolumeHbd: null, tickerVolumeDifferenceHbd: null,
    parent: { id: "hive", source: "coingecko", price: null, observedAt: null, ageSec: null },
    formula: "HIVE_USD / ((bid_HBD_per_HIVE + ask_HBD_per_HIVE) / 2)",
    price: null, usdBid: null, usdAsk: null, observedAt: null, observedAtMode: "local_fetch", rejectionReason: null,
  };
}
export async function fetchHiveNativeHbdPrice(parent: HiveUsdParent | undefined, options: { signal?: AbortSignal; deadlineMs?: number; generation?: number } = {}): Promise<HiveMarketResult> {
  const started = Date.now();
  const deadline = Math.min(options.deadlineMs ?? Infinity, started + HIVE_MARKET_POLICY.observerTimeoutMs);
  const generation = options.generation ?? Math.floor(started / 1000);
  let packet = emptyPacket(generation);
  let rpcCount = 0;
  for (const node of NODES) {
    packet = emptyPacket(generation);
    packet.node = new URL(node).host;
    const sampleStarted = Date.now();
    try {
      if (options.signal?.aborted) reject("aborted");
      if (Date.now() >= deadline) reject("deadline_exceeded");
      admitParent(parent, Date.now() / 1000, packet);
      const rpc = async (method: string, params: number[] = []): Promise<unknown> => {
        if (options.signal?.aborted) reject("aborted");
        if (Date.now() >= deadline) reject("deadline_exceeded");
        const id = ++rpcCount;
        packet.rpcCount = rpcCount;
        let status: number | null = null;
        try {
          const result = await fetchJsonWithRetry(node, {
            // Workers rejects redirect: "error" before sending; manual keeps
            // redirects fail-closed via the helper's non-2xx body cleanup.
            method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: `condenser_api.${method}`, params }), signal: options.signal,
          }, 0, {
            timeoutMs: HIVE_MARKET_POLICY.rpcTimeoutMs, deadlineMs: deadline,
            maxResponseBytes: HIVE_MARKET_POLICY.maxResponseBytes, throwOnFinalNetworkError: true,
            onResponse: (response) => { status = response.status; },
          });
          if (status === 429) reject("rate_limited");
          if (!result) reject("rpc_error");
          const body = object(result.body);
          if (body.jsonrpc !== "2.0" || body.id !== id) reject("invalid_response");
          if (body.error != null) reject("rpc_error");
          if (!("result" in body)) reject("invalid_response");
          return body.result;
        } catch (error) {
          if (options.signal?.aborted) reject("aborted");
          if (Date.now() >= deadline) reject("deadline_exceeded");
          if (error instanceof Rejected) throw error;
          if ((error instanceof Error || error instanceof DOMException) && error.name === "TimeoutError") reject("rpc_timeout");
          if (error instanceof SyntaxError || isResponseBodyTooLargeError(error)) reject("invalid_response");
          reject("rpc_error");
        }
      };
      packet.preHead = readHead(await rpc(METHODS[0]), Date.now() / 1000);
      const book = await rpc(METHODS[1], [HIVE_MARKET_POLICY.bookLimit]);
      packet.bookRetrievedAt = Math.floor(Date.now() / 1000);
      inspectHiveBook(book, packet);
      const ticker = object(await rpc(METHODS[2]));
      packet.tickerVolumeHbd = asset(ticker.hbd_volume, "HBD", true) / 1000;
      asset(ticker.hive_volume, "HIVE", true);
      const trades = await rpc(METHODS[3], [HIVE_MARKET_POLICY.tradeLimit]);
      packet.postHead = readHead(await rpc(METHODS[4]), Date.now() / 1000);
      inspectHiveTrades(trades, Date.now() / 1000, packet);
      // Separate reads need not agree exactly; ticker is diagnostic only, never
      // a substitute or a veto for the conservative non-self volume proof.
      packet.tickerVolumeDifferenceHbd = packet.tickerVolumeHbd - packet.volumeHbd!;
      packet.sampleDurationMs = Date.now() - sampleStarted;
      if (packet.postHead.number < packet.preHead.number || packet.postHead.time < packet.preHead.time) reject("head_stale");
      if (packet.sampleDurationMs > HIVE_MARKET_POLICY.sampleMaxMs) reject("sample_expired");
      admitParent(parent, Date.now() / 1000, packet);
      const price = parent.price / packet.mid!;
      if (!Number.isFinite(price) || price <= 0) reject("invalid_response");
      packet.price = price;
      packet.usdBid = parent.price / packet.ask!;
      packet.usdAsk = parent.price / packet.bid!;
      packet.observedAt = Math.min(packet.bookRetrievedAt, parent.observedAt);
      return { quote: { price, observedAt: packet.observedAt, observedAtMode: "local_fetch" }, diagnostic: packet, transportHealthy: true };
    } catch (error) {
      const reason = error instanceof Rejected ? error.reason : "invalid_response";
      packet.rejectionReason = reason;
      packet.rpcCount = rpcCount;
      packet.sampleDurationMs = Date.now() - sampleStarted;
      if (!FAILOVER_REASONS[reason] || node === NODES[1]) return { quote: null, diagnostic: packet, transportHealthy: !FAILOVER_REASONS[reason] && reason !== "aborted" && reason !== "deadline_exceeded" };
    }
  }
  return { quote: null, diagnostic: packet, transportHealthy: false };
}
