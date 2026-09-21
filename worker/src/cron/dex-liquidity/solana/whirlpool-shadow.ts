import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseUnits } from "viem/utils";
import { throwIfAborted } from "../../../lib/abort";
import type { AdapterContext } from "../../reserve-adapters/types";
import { fetchSolanaAccountBatch } from "../../reserve-adapters/solana";
import { persistNativeShadowQuote } from "../../measured-execution/persistence";
import { loadTrackedStablecoinMaps } from "../orchestrator-phases/lookups";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../source-pagination-state";
import { decodeWhirlpool, fetchWhirlpoolSnapshot, ORCA_WHIRLPOOL_PROGRAM_ID, quoteWhirlpoolExactIn } from "./whirlpool-quote";

const ORCA_WHIRLPOOL_SHADOW_MODEL_VERSION = "orca-whirlpool-native-v1";
const ORCA_WHIRLPOOL_SHADOW_MAX_POOLS = 4;
const RUNTIME_MS = 45_000;
const CURSOR_KEY = "orca-whirlpool-native-shadow:v1";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

interface RetainedPool {
  pool_id: string;
  stablecoin_id: string;
  tvl_usd: number;
}

/** TVL order is stable within a retained inventory; the durable offset rotates all pools. */
export function selectWhirlpoolShadowPools(rows: readonly RetainedPool[], cursor: string | null) {
  const pools = new Map<string, RetainedPool>();
  for (const row of rows) {
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.pool_id) || !Number.isFinite(row.tvl_usd) || row.tvl_usd <= 0) continue;
    const prior = pools.get(row.pool_id);
    if (!prior || row.tvl_usd > prior.tvl_usd || (row.tvl_usd === prior.tvl_usd && row.stablecoin_id < prior.stablecoin_id)) pools.set(row.pool_id, row);
  }
  const ordered = [...pools.values()].sort((a, b) => b.tvl_usd - a.tvl_usd || a.pool_id.localeCompare(b.pool_id));
  const parsed = Number(cursor ?? 0);
  const start = Number.isSafeInteger(parsed) && parsed >= 0 && ordered.length ? parsed % ordered.length : 0;
  // Do not wrap within a pass: the next pass starts at the head after the tail.
  return { selected: ordered.slice(start, start + ORCA_WHIRLPOOL_SHADOW_MAX_POOLS), start, total: ordered.length };
}

export interface WhirlpoolShadowSummary {
  attempted: number;
  persisted: number;
  failed: number;
  budgetExhausted: boolean;
  scoreEligible: false;
  failures: string[];
}

/** Runs only after EVM work settles. Every pool/discovery/mint/snapshot RPC is awaited serially. */
export async function collectWhirlpoolShadowQuotes(input: {
  db: D1Database;
  signal?: AbortSignal;
  ctx?: AdapterContext;
}): Promise<WhirlpoolShadowSummary> {
  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1_000);
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(RUNTIME_MS)]);
  const summary: WhirlpoolShadowSummary = { attempted: 0, persisted: 0, failed: 0, budgetExhausted: false, scoreEligible: false, failures: [] };
  throwIfAborted(input.signal);
  const state = await readDexSourcePaginationState(input.db, CURSOR_KEY, "sync-cl-exit-depth");
  // Stored public pool JSON retains poolId; only the API response strips it.
  const retained = await input.db.prepare(`SELECT json_extract(pool.value, '$.poolId') AS pool_id,
      dl.stablecoin_id, json_extract(pool.value, '$.tvlUsd') AS tvl_usd
    FROM dex_liquidity dl, json_each(dl.top_pools_json) pool
    WHERE dl.updated_at >= ? AND dl.publication_state = 'published'
      AND dl.publication_generation_id = (
        SELECT publication_generation_id FROM dex_liquidity
        WHERE stablecoin_id = '__global__' AND publication_state = 'published')
      AND lower(json_extract(pool.value, '$.chain')) = 'solana'
      AND json_extract(pool.value, '$.project') = 'orca'`)
    .bind(nowSec - 24 * 60 * 60).all<RetainedPool>();
  const window = selectWhirlpoolShadowPools((retained.results ?? []).filter((row) => ACTIVE_META_BY_ID.has(row.stablecoin_id)), state.cursor);
  const { stablecoinPriceById } = await loadTrackedStablecoinMaps(input.db, nowSec);
  for (const row of window.selected) {
    if (signal.aborted || Date.now() - startedAt >= RUNTIME_MS) { summary.budgetExhausted = true; break; }
    summary.attempted++;
    try {
      const poolAddress = row.pool_id.slice("solana:".length);
      const discovery = await fetchSolanaAccountBatch([poolAddress], signal, input.ctx);
      const account = discovery.accounts.get(poolAddress);
      if (!account || account.owner !== ORCA_WHIRLPOOL_PROGRAM_ID) throw new Error("Whirlpool pool owner mismatch");
      const pool = decodeWhirlpool(account.data, discovery.slot);
      const contracts = ACTIVE_META_BY_ID.get(row.stablecoin_id)?.contracts ?? [];
      const mints = contracts.filter((contract) => contract.chain === "solana" && (contract.address === pool.tokenMintA || contract.address === pool.tokenMintB));
      if (mints.length !== 1) throw new Error("Tracked input mint unresolved");
      const tokenMintIn = mints[0].address;
      const price = stablecoinPriceById.get(row.stablecoin_id);
      if (!price || !Number.isFinite(price) || price <= 0) throw new Error("Trusted input price unavailable");
      const mintBatch = await fetchSolanaAccountBatch([pool.tokenMintA, pool.tokenMintB], signal, input.ctx, discovery.slot);
      for (const mint of [pool.tokenMintA, pool.tokenMintB]) {
        const mintAccount = mintBatch.accounts.get(mint);
        if (!mintAccount || mintAccount.owner !== TOKEN_PROGRAM || mintAccount.data.length !== 82 || mintAccount.data[45] !== 1 || mintAccount.data[44] > 18) {
          throw new Error("Unsupported Whirlpool token mint (legacy SPL required)");
        }
      }
      const decimals = mintBatch.accounts.get(tokenMintIn)!.data[44];
      const notionalUsd = getDexMeasuredExecutionProbeNotionals(row.tvl_usd)[0];
      const tokenAmount = notionalUsd / price;
      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || tokenAmount >= 1e21) throw new Error("Invalid exact-in notional");
      const amountIn = parseUnits(tokenAmount.toFixed(decimals), decimals);
      const snapshot = await fetchWhirlpoolSnapshot(poolAddress, pool, signal, input.ctx);
      if (snapshot.slot < mintBatch.slot || snapshot.pool.tokenMintA !== pool.tokenMintA || snapshot.pool.tokenMintB !== pool.tokenMintB) throw new Error("Whirlpool discovery identity changed");
      const quote = quoteWhirlpoolExactIn(snapshot, tokenMintIn, amountIn);
      throwIfAborted(signal);
      await persistNativeShadowQuote(input.db, {
        poolId: row.pool_id, stablecoinId: row.stablecoin_id, slot: quote.slot,
        quotedAt: Math.floor(Date.now() / 1_000), notionalUsd, tokenMintIn,
        tokenMintOut: tokenMintIn === pool.tokenMintA ? pool.tokenMintB : pool.tokenMintA,
        amountIn, amountOut: quote.amountOut, inputPriceUsd: price, inputDecimals: decimals,
        modelVersion: ORCA_WHIRLPOOL_SHADOW_MODEL_VERSION,
      });
      summary.persisted++;
    } catch (error) {
      throwIfAborted(input.signal);
      if (signal.aborted) { summary.budgetExhausted = true; break; }
      summary.failed++;
      summary.failures.push(`${row.pool_id}: ${toErrorMessage(error).slice(0, 180)}`);
    }
  }
  throwIfAborted(input.signal);
  const next = window.start + summary.attempted;
  const cursorWrite = await writeDexSourcePaginationState({
    db: input.db, sourceKey: CURSOR_KEY, cursor: String(next >= window.total ? 0 : next),
    cycleStartedAt: state.cycleStartedAt ?? nowSec, nowSec, completed: next >= window.total,
    pagesFetched: state.pagesFetched + 1, diagnostics: summary.failures, job: "sync-cl-exit-depth",
  });
  if (!cursorWrite.written) throw new Error("Orca shadow cursor persistence failed");
  // Seven days of bounded review evidence; never touched by V1 quote publication.
  await input.db.prepare(`DELETE FROM dex_native_shadow_quotes WHERE rowid IN
    (SELECT rowid FROM dex_native_shadow_quotes WHERE quoted_at < ? ORDER BY quoted_at LIMIT 256)`)
    .bind(nowSec - 7 * 24 * 60 * 60).run();
  return summary;
}
