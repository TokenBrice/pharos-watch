import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchJsonWithRetry } from "../fetch-retry";
import { getAlchemyAuthHeaders } from "../chain-registry";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const POOL = "DmXXwEcK2c7fuVoW6TBzF5UDByhuQBHZS1qHnwprvHFH";
const USDV = "Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ACCOUNTS = [POOL, "25QrV3HbQCv7iVPskPpoUr2MadM2A1oKBsVjWx7fnc2i", "FMcSKu3XpnC9Vxhf37Pq1GXHjZtLRFNQCpjNS66onGRh", "3cw3hYifx3fbmBBywMRzxikKckKKr2kyb1tS6XTWkWaG", USDV, USDC];
const PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const HEX = {
  pool: "bdb452a98d147269d0977f2e4d053e7158db2f9fbd95d77f0524625614347a34",
  input: "cf43a47a7f734e069900ecf370a741e3179fecbe7cb13ed2a3446cfc8658f1ed",
  output: "c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61",
  reserveX: "d54b4d2f24657fac890ad4ae40488277b96f7d58c6e36cd0f86401fe8f1f6b7c",
  reserveY: "26ebd01291842324a47d057001e1288bd75d5f0c2dd9be53abf0d4399b01dd65",
};
interface Account { owner: string; executable: boolean; data: [string, string] }
interface State { context: { slot: number }; value: (Account | null)[] }
interface Quote { inputMint: string; outputMint: string; inAmount: string; outAmount: string; swapMode: string;
  contextSlot: number; platformFee?: { feeBps: number } | null; priceImpactPct: string;
  routePlan: { percent: number; swapInfo: { ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; updateContextSlot: string } }[] }
const fresh = (time: number) => Number.isSafeInteger(time) && time > 0 && time <= Math.floor(Date.now() / 1000) && Math.floor(Date.now() / 1000) - time < 300;
const positiveInteger = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const bytes = (a: Account) => Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array, offset: number, length = 32) => Array.from(b.slice(offset, offset + length), (n) => n.toString(16).padStart(2, "0")).join("");
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (b: Uint8Array, offset: number) => view(b).getBigUint64(offset, true);

// Reviewed Meteora IDL: LbPair904 bytes, BinArray10136 bytes with70 144-byte bins.
// The single pinned bin array is deliberate: leaving its reviewed range fails closed.
export function validateUsdvPoolState(state: State): { activeOutput: bigint; binPrice: number } | null {
  try {
    if (!Number.isSafeInteger(state.context.slot) || state.value.length !== 6 || state.value.some((a) => !a || a.executable || a.data[1] !== "base64")) return null;
    const accounts = state.value as Account[];
    if (accounts.some((a, i) => a.owner !== (i < 2 ? PROGRAM : TOKEN_PROGRAM))) return null;
    const [pool, bins, reserveX, reserveY, mintX, mintY] = accounts.map(bytes);
    if (pool.length !== 904 || bins.length !== 10136 || reserveX.length !== 165 || reserveY.length !== 165 || mintX.length !== 82 || mintY.length !== 82) return null;
    if (hex(pool, 0, 8) !== "210b3162b565b10d" || hex(bins, 0, 8) !== "5c8e5cdc059446b5"
      || pool[75] !== 3 || pool[82] !== 0 || pool[87] !== 0 || pool[880] !== 0 || pool[881] !== 0 || pool[882] !== 1
      || u64(pool, 816) !== 0n || view(pool).getUint16(80, true) !== 5 || bins[16] !== 2) return null;
    if (hex(pool, 88) !== HEX.input || hex(pool, 120) !== HEX.output || hex(pool, 152) !== HEX.reserveX || hex(pool, 184) !== HEX.reserveY || hex(bins, 24) !== HEX.pool) return null;
    if (hex(reserveX, 0) !== HEX.input || hex(reserveY, 0) !== HEX.output || hex(reserveX, 32) !== HEX.pool || hex(reserveY, 32) !== HEX.pool
      || reserveX[108] !== 1 || reserveY[108] !== 1 || mintX[44] !== 9 || mintY[44] !== 6 || mintX[45] !== 1 || mintY[45] !== 1) return null;
    const activeId = view(pool).getInt32(76, true), index = view(bins).getBigInt64(8, true);
    if (index !== -198n || Math.floor(activeId / 70) !== Number(index)) return null;
    const offset = 56 + (activeId - Number(index) * 70) * 144;
    const activeOutput = u64(bins, offset + 8);
    if (u64(reserveX, 64) < 10_000n * 10n ** 9n || u64(reserveY, 64) < 10_000n * 10n ** 6n || activeOutput < 10_000n * 10n ** 6n || activeOutput > u64(reserveY, 64)) return null;
    const binPrice = Number(u64(bins, offset + 16) + (u64(bins, offset + 24) << 64n)) / 2 ** 64 * 1_000;
    return Number.isFinite(binPrice) && binPrice > 0 ? { activeOutput, binPrice } : null;
  } catch { return null; }
}

export async function fetchUsdvJupiterPrice(context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => { context.lastRejectionReason = `jupiter-exact:${reason}`; return null; };
  const parent = resolveTrustedOverrideParent(context, "usdc-circle", () => "USDv: trusted USDC unavailable", { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent || !fresh(parent.trustedParent.observedAt)) return reject("parent-unavailable");
  const configured = context.chainRpcs?.get("solana");
  const urls = [...new Set([configured?.rpcUrl, configured?.fallbackRpcUrl, "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"].filter((s): s is string => !!s))];
  async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    for (const url of urls) {
      throwIfAborted(signal);
      const r = await fetchJsonWithRetry<{ result?: T; error?: unknown }>(url, { method: "POST", headers: { "Content-Type": "application/json", ...getAlchemyAuthHeaders(url) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal }, 0, { timeoutMs: 2000, maxResponseBytes: 64000 });
      if (r?.response.ok && !r.body.error && r.body.result != null) return r.body.result;
    }
    return null;
  }
  async function quote(amount: string): Promise<Quote | null> {
    const qs = new URLSearchParams({ inputMint: USDV, outputMint: USDC, amount, swapMode: "ExactIn", slippageBps: "50", onlyDirectRoutes: "true", dexes: "Meteora DLMM" });
    const r = await fetchJsonWithRetry<Quote>(`https://api.jup.ag/swap/v1/quote?${qs}`, { signal }, 0, { timeoutMs: 2000, maxResponseBytes: 16000 });
    return r?.response.ok ? r.body : null;
  }
  const small = await quote("1000000000"), depth = await quote("1000000000000");
  const valid = (q: Quote | null, amount: string) => q && q.inputMint === USDV && q.outputMint === USDC && q.inAmount === amount && q.swapMode === "ExactIn"
    && Number.isSafeInteger(q.contextSlot) && q.contextSlot > 0 && (!q.platformFee || q.platformFee.feeBps === 0) && positiveInteger(q.outAmount)
    && Number.isFinite(Number(q.priceImpactPct)) && Math.abs(Number(q.priceImpactPct)) <= .05
    && Array.isArray(q.routePlan) && q.routePlan.length === 1 && q.routePlan[0].percent === 100
    && q.routePlan[0].swapInfo.ammKey === POOL && q.routePlan[0].swapInfo.inputMint === USDV && q.routePlan[0].swapInfo.outputMint === USDC
    && q.routePlan[0].swapInfo.inAmount === amount && q.routePlan[0].swapInfo.outAmount === q.outAmount && positiveInteger(q.routePlan[0].swapInfo.updateContextSlot);
  if (!valid(small, "1000000000") || !valid(depth, "1000000000000") || !small || !depth) return reject("quote-identity");
  const smallOut = BigInt(small.outAmount), depthOut = BigInt(depth.outAmount);
  if (depthOut * 100n < smallOut * 1000n * 95n || depthOut * 100n > smallOut * 1000n * 105n) return reject("quote-depth");
  const slots = [small.contextSlot, depth.contextSlot, Number(small.routePlan[0].swapInfo.updateContextSlot), Number(depth.routePlan[0].swapInfo.updateContextSlot)];
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot <= 0) || slots[2] > slots[0] || slots[3] > slots[1]) return reject("quote-slot");
  const state = await rpc<State>("getMultipleAccounts", [ACCOUNTS, { encoding: "base64", commitment: "confirmed", minContextSlot: Math.max(...slots) }]);
  const pool = state && validateUsdvPoolState(state);
  if (!state || !pool || state.context.slot < Math.max(...slots) || state.context.slot - Math.min(...slots) > 600) return reject("pool-state");
  if (depthOut >= pool.activeOutput || Math.abs(Number(smallOut) / 1e6 / pool.binPrice - 1) > .02) return reject("pool-quote");
  const oldestTime = await rpc<number>("getBlockTime", [Math.min(...slots)]);
  const stateTime = await rpc<number>("getBlockTime", [state.context.slot]);
  if (oldestTime == null || stateTime == null || !fresh(oldestTime) || !fresh(stateTime) || oldestTime > stateTime) return reject("slot-age");
  const observedAt = Math.min(oldestTime, parent.trustedParent.observedAt);
  if (!fresh(observedAt)) return reject("dependency-age");
  const price = Number(smallOut) / 1e6 * parent.trustedParent.price;
  return Number.isFinite(price) && price > 0 ? { price, source: "jupiter-exact", confidence: "fallback", observedAt, observedAtMode: "upstream" } : reject("price-invalid");
}
export const usdvJupiterProvider: PriceSourceProvider = {
  source: "jupiter-exact", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.USDV_JUPITER, livePriority: 1, liveTimeoutMs: 6000,
  matches: (id) => id === "usdv-solomon",
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) { return hasPublishableCurrentPrice(asset) ? null : fetchUsdvJupiterPrice(context, signal); },
};
