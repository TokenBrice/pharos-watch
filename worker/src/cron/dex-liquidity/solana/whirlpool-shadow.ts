import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseUnits } from "viem/utils";
import { runWithOverloadRetry } from "../../../lib/d1-overload-retry";
import { throwIfAborted } from "../../../lib/abort";
import type { AdapterContext } from "../../reserve-adapters/types";
import { fetchSolanaAccountBatch } from "../../reserve-adapters/solana";
import { persistNativeShadowQuote } from "../../measured-execution/persistence";
import { loadTrackedStablecoinMaps } from "../orchestrator-phases/lookups";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../source-pagination-state";
import { decodeWhirlpool, fetchWhirlpoolSnapshot, ORCA_WHIRLPOOL_PROGRAM_ID, quoteWhirlpoolExactIn } from "./whirlpool-quote";
import { decodeRaydiumPool, fetchRaydiumSnapshot, RAYDIUM_CLMM_PROGRAM_ID, quoteRaydiumExactIn } from "./raydium-clmm-quote";

const MAX_POOLS = 4;
const RUNTIME_MS = 45_000;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
type Family = "orca" | "raydium-clmm";
interface RetainedPool { pool_id: string; stablecoin_id: string; tvl_usd: number }

/** TVL order is stable within retained inventory; discovery skips do not spend quote slots. */
export function selectSolanaShadowPools(rows: readonly RetainedPool[], cursor: string | null, limit = MAX_POOLS) {
  const pools = new Map<string, RetainedPool>();
  for (const row of rows) {
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.pool_id) || !Number.isFinite(row.tvl_usd) || row.tvl_usd <= 0) continue;
    const prior = pools.get(row.pool_id);
    if (!prior || row.tvl_usd > prior.tvl_usd || (row.tvl_usd === prior.tvl_usd && row.stablecoin_id < prior.stablecoin_id)) pools.set(row.pool_id, row);
  }
  const ordered = [...pools.values()].sort((a, b) => b.tvl_usd - a.tvl_usd || a.pool_id.localeCompare(b.pool_id));
  const parsed = Number(cursor ?? 0);
  const start = Number.isSafeInteger(parsed) && parsed >= 0 && ordered.length ? parsed % ordered.length : 0;
  return { selected: ordered.slice(start, start + limit), start, total: ordered.length };
}

interface SolanaShadowSummary {
  attempted: number;
  persisted: number;
  failed: number;
  budgetExhausted: boolean;
  scoreEligible: false;
  durationMs: number;
  skippedIneligible: Record<string, number>;
  failures: string[];
}
interface CollectorInput { db: D1Database; signal?: AbortSignal; ctx?: AdapterContext }

export async function collectWhirlpoolShadowQuotes(input: CollectorInput): Promise<SolanaShadowSummary> {
  return collectSolanaShadowQuotes(input, "orca");
}
export async function collectRaydiumShadowQuotes(input: CollectorInput): Promise<SolanaShadowSummary> {
  return collectSolanaShadowQuotes(input, "raydium-clmm");
}

/** Families and every discovery/mint/atomic-snapshot RPC run serially after EVM work settles. */
async function collectSolanaShadowQuotes(input: CollectorInput, family: Family): Promise<SolanaShadowSummary> {
  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1_000);
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(RUNTIME_MS)]);
  const summary: SolanaShadowSummary = { attempted: 0, persisted: 0, failed: 0, budgetExhausted: false, scoreEligible: false, durationMs: 0, skippedIneligible: {}, failures: [] };
  const orca = family === "orca";
  const cursorKey = orca ? "orca-whirlpool-native-shadow:v1" : "raydium-clmm-native-shadow:v1";
  throwIfAborted(input.signal);
  const state = await readDexSourcePaginationState(input.db, cursorKey, "sync-cl-exit-depth");
  // Idempotent read: on 2026-09-23 the 15:05 run failed both shadow families
  // in ~24ms because this first D1 read hit the transient overload window.
  const retained = await runWithOverloadRetry(
    () => input.db.prepare(`SELECT json_extract(pool.value, '$.poolId') AS pool_id,
      dl.stablecoin_id, json_extract(pool.value, '$.tvlUsd') AS tvl_usd
    FROM dex_liquidity dl, json_each(dl.top_pools_json) pool
    WHERE dl.updated_at >= ? AND dl.publication_state = 'published'
      AND dl.publication_generation_id = (
        SELECT publication_generation_id FROM dex_liquidity
        WHERE stablecoin_id = '__global__' AND publication_state = 'published')
      AND lower(json_extract(pool.value, '$.chain')) = 'solana'
      AND ((? = 'orca' AND json_extract(pool.value, '$.project') = 'orca')
        OR (? = 'raydium-clmm' AND json_extract(pool.value, '$.project') IN ('raydium', 'raydium-amm', 'raydium-clmm')
          AND json_extract(pool.value, '$.poolType') = 'raydium-clmm'))`)
      .bind(nowSec - 24 * 60 * 60, family, family).all<RetainedPool>(),
    3,
    input.signal,
  );
  const window = selectSolanaShadowPools((retained.results ?? []).filter((row) => ACTIVE_META_BY_ID.has(row.stablecoin_id)), state.cursor, Infinity);
  const { stablecoinPriceById } = await loadTrackedStablecoinMaps(input.db, nowSec);
  let examined = 0;
  function skip(reason: string) { summary.skippedIneligible[reason] = (summary.skippedIneligible[reason] ?? 0) + 1; }
  for (const row of window.selected) {
    if (summary.attempted >= MAX_POOLS) break;
    if (signal.aborted || Date.now() - startedAt >= RUNTIME_MS) { summary.budgetExhausted = true; break; }
    examined++;
    let quoteAttempted = false;
    try {
      const price = stablecoinPriceById.get(row.stablecoin_id);
      if (!price || !Number.isFinite(price) || price <= 0) { skip("trusted-input-price-unavailable"); continue; }
      const poolAddress = row.pool_id.slice("solana:".length);
      const discovery = await fetchSolanaAccountBatch([poolAddress], signal, input.ctx);
      const account = discovery.accounts.get(poolAddress);
      if (!account || account.owner !== (orca ? ORCA_WHIRLPOOL_PROGRAM_ID : RAYDIUM_CLMM_PROGRAM_ID)) { skip("unsupported-pool-owner"); continue; }
      // Static Whirlpool fee tiers encode spacing at both positions; adaptive tiers need oracle math.
      if (orca && account.data.length === 653) {
        const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
        if (view.getUint16(41, true) !== view.getUint16(43, true)) { skip("adaptive-fee-whirlpool"); continue; }
      }
      const pool = orca ? decodeWhirlpool(account.data, discovery.slot) : decodeRaydiumPool(account.data, discovery.slot);
      const contracts = ACTIVE_META_BY_ID.get(row.stablecoin_id)?.contracts ?? [];
      const mints = contracts.filter((contract) => contract.chain === "solana" && (contract.address === pool.tokenMintA || contract.address === pool.tokenMintB));
      if (mints.length !== 1) { skip("tracked-input-mint-unresolved"); continue; }
      const tokenMintIn = mints[0].address;
      const mintBatch = await fetchSolanaAccountBatch([pool.tokenMintA, pool.tokenMintB], signal, input.ctx, discovery.slot);
      if ([pool.tokenMintA, pool.tokenMintB].some((mint) => {
        const mintAccount = mintBatch.accounts.get(mint);
        return !mintAccount || mintAccount.owner !== TOKEN_PROGRAM || mintAccount.data.length !== 82 || mintAccount.data[45] !== 1 || mintAccount.data[44] > 18;
      })) { skip("unsupported-token-mint"); continue; }
      summary.attempted++;
      quoteAttempted = true;
      const decimals = mintBatch.accounts.get(tokenMintIn)!.data[44];
      const notionalUsd = getDexMeasuredExecutionProbeNotionals(row.tvl_usd)[0];
      const tokenAmount = notionalUsd / price;
      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || tokenAmount >= 1e21) throw new Error("Invalid exact-in notional");
      const amountIn = parseUnits(tokenAmount.toFixed(decimals), decimals);
      let quote: { amountOut: bigint; slot: number };
      if (orca) {
        const snapshot = await fetchWhirlpoolSnapshot(poolAddress, pool, signal, input.ctx);
        if (snapshot.slot < mintBatch.slot || snapshot.pool.tokenMintA !== pool.tokenMintA || snapshot.pool.tokenMintB !== pool.tokenMintB) throw new Error("Whirlpool discovery identity changed");
        quote = quoteWhirlpoolExactIn(snapshot, tokenMintIn, amountIn);
      } else {
        const snapshot = await fetchRaydiumSnapshot(poolAddress, decodeRaydiumPool(account.data, discovery.slot), tokenMintIn, signal, input.ctx, mintBatch.slot);
        quote = quoteRaydiumExactIn(snapshot, tokenMintIn, amountIn);
      }
      throwIfAborted(signal);
      await persistNativeShadowQuote(input.db, {
        poolId: row.pool_id, stablecoinId: row.stablecoin_id, slot: quote.slot,
        quotedAt: Math.floor(Date.now() / 1_000), notionalUsd, tokenMintIn,
        tokenMintOut: tokenMintIn === pool.tokenMintA ? pool.tokenMintB : pool.tokenMintA,
        amountIn, amountOut: quote.amountOut, inputPriceUsd: price, inputDecimals: decimals,
        modelVersion: orca ? "orca-whirlpool-native-v1" : "raydium-clmm-native-v1",
        profileId: orca ? "orca-whirlpool-exact-v1" : "raydium-clmm-exact-v1",
      }, signal);
      summary.persisted++;
    } catch (error) {
      throwIfAborted(input.signal);
      if (signal.aborted) { summary.budgetExhausted = true; break; }
      if (!quoteAttempted) summary.attempted++;
      summary.failed++;
      summary.failures.push(`${row.pool_id}: ${toErrorMessage(error).slice(0, 180)}`);
    }
  }
  throwIfAborted(input.signal);
  const next = window.start + examined;
  const cursorWrite = await writeDexSourcePaginationState({
    db: input.db, sourceKey: cursorKey, cursor: String(next >= window.total ? 0 : next),
    cycleStartedAt: state.cycleStartedAt ?? nowSec, nowSec, completed: next >= window.total,
    pagesFetched: state.pagesFetched + 1, diagnostics: summary.failures, job: "sync-cl-exit-depth",
  });
  if (!cursorWrite.written) throw new Error(`${family} shadow cursor persistence failed`);
  // Idempotent retention delete: transient overload must not discard the
  // already-collected shadow summary.
  await runWithOverloadRetry(() => input.db.prepare(`DELETE FROM dex_native_shadow_quotes_v2 WHERE rowid IN
    (SELECT rowid FROM dex_native_shadow_quotes_v2 WHERE quoted_at < ? ORDER BY quoted_at LIMIT 256)`)
    .bind(nowSec - 7 * 24 * 60 * 60).run(), 3, input.signal);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}
