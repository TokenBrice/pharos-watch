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
import { decodeDlmmPair, fetchDlmmSnapshot, METEORA_DLMM_PROGRAM_ID, METEORA_DLMM_PROFILE_ID, quoteDlmmExactIn } from "./dlmm-quote";

const MAX_TARGETS = 4;
const RUNTIME_MS = 45_000;
const CURSOR_KEY = "meteora-dlmm-native-shadow:v1";
interface RetainedTarget { pool_id: string; stablecoin_id: string; tvl_usd: number }

/** Exact on-chain owner/layout determines DLMM, not the discovery DEX label. */
export async function collectDlmmShadowQuotes(input: { db: D1Database; signal?: AbortSignal; ctx?: AdapterContext }) {
  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1000);
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(RUNTIME_MS)]);
  const summary = { attempted: 0, persisted: 0, failed: 0, budgetExhausted: false, scoreEligible: false as const, durationMs: 0,
    skippedIneligible: {} as Record<string, number>, failures: [] as string[] };
  throwIfAborted(input.signal);
  const state = await readDexSourcePaginationState(input.db, CURSOR_KEY, "sync-cl-exit-depth");
  const retained = await runWithOverloadRetry(() => input.db.prepare(`SELECT
    json_extract(pool.value, '$.poolId') AS pool_id, dl.stablecoin_id,
    json_extract(pool.value, '$.tvlUsd') AS tvl_usd
    FROM dex_liquidity dl, json_each(dl.top_pools_json) pool
    WHERE dl.updated_at >= ? AND dl.publication_state = 'published'
      AND dl.publication_generation_id = (SELECT publication_generation_id FROM dex_liquidity
        WHERE stablecoin_id = '__global__' AND publication_state = 'published')
      AND lower(json_extract(pool.value, '$.chain')) = 'solana'
      AND json_extract(pool.value, '$.project') IN ('meteora', 'meteora-dlmm')
    ORDER BY tvl_usd DESC, pool_id, dl.stablecoin_id LIMIT 256`).bind(nowSec - 24 * 60 * 60).all<RetainedTarget>(), 3, input.signal);
  const seen = new Set<string>();
  const rows = (retained.results ?? []).filter((row) => {
    const key = `${row.pool_id}:${row.stablecoin_id}`;
    if (!ACTIVE_META_BY_ID.has(row.stablecoin_id) || !/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.pool_id) || !Number.isFinite(row.tvl_usd) || row.tvl_usd <= 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const cursor = Number(state.cursor ?? 0);
  const start = Number.isSafeInteger(cursor) && cursor >= 0 && rows.length ? cursor % rows.length : 0;
  const { stablecoinPriceById } = await loadTrackedStablecoinMaps(input.db, nowSec);
  let examined = 0;
  for (let i = start; i < rows.length && summary.attempted < MAX_TARGETS; i++) {
    if (signal.aborted || Date.now() - startedAt >= RUNTIME_MS) { summary.budgetExhausted = true; break; }
    examined++;
    const row = rows[i];
    let attempted = false;
    try {
      const price = stablecoinPriceById.get(row.stablecoin_id);
      if (!price || !Number.isFinite(price) || price <= 0) {
        summary.skippedIneligible["trusted-input-price-unavailable"] = (summary.skippedIneligible["trusted-input-price-unavailable"] ?? 0) + 1;
        continue;
      }
      const poolAddress = row.pool_id.slice("solana:".length);
      const discovery = await fetchSolanaAccountBatch([poolAddress], signal, input.ctx);
      const account = discovery.accounts.get(poolAddress);
      if (!account || account.owner !== METEORA_DLMM_PROGRAM_ID) {
        summary.skippedIneligible["not-dlmm-pool-owner"] = (summary.skippedIneligible["not-dlmm-pool-owner"] ?? 0) + 1;
        continue;
      }
      const pool = decodeDlmmPair(account.data, discovery.slot);
      const meta = ACTIVE_META_BY_ID.get(row.stablecoin_id)!;
      const mints = [...new Set([...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]
        .filter((contract) => contract.chain === "solana" && (contract.address === pool.tokenMintX || contract.address === pool.tokenMintY))
        .map((contract) => contract.address))];
      if (mints.length !== 1) {
        summary.skippedIneligible["tracked-input-mint-unresolved"] = (summary.skippedIneligible["tracked-input-mint-unresolved"] ?? 0) + 1;
        continue;
      }
      summary.attempted++;
      attempted = true;
      const tokenMintIn = mints[0];
      const snapshot = await fetchDlmmSnapshot(poolAddress, pool, tokenMintIn, signal, input.ctx);
      const decimals = snapshot.mintDecimals[tokenMintIn === pool.tokenMintX ? 0 : 1];
      for (const notionalUsd of getDexMeasuredExecutionProbeNotionals(row.tvl_usd)) {
        throwIfAborted(signal);
        try {
          const amount = notionalUsd / price;
          if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e21) throw new Error("dlmm-invalid-exact-in-notional");
          const amountIn = parseUnits(amount.toFixed(decimals), decimals);
          const quote = quoteDlmmExactIn(snapshot, tokenMintIn, amountIn);
          await persistNativeShadowQuote(input.db, {
            poolId: row.pool_id, stablecoinId: row.stablecoin_id, slot: quote.slot,
            quotedAt: Math.floor(Date.now() / 1000), notionalUsd, tokenMintIn,
            tokenMintOut: tokenMintIn === pool.tokenMintX ? pool.tokenMintY : pool.tokenMintX,
            amountIn, amountOut: quote.amountOut, inputPriceUsd: price, inputDecimals: decimals,
            modelVersion: "meteora-dlmm-native-v1", profileId: METEORA_DLMM_PROFILE_ID,
          }, signal);
          summary.persisted++;
        } catch (error) {
          throwIfAborted(signal);
          summary.failed++;
          summary.failures.push(`${row.pool_id}:${notionalUsd}: ${toErrorMessage(error).slice(0, 140)}`);
        }
      }
    } catch (error) {
      throwIfAborted(input.signal);
      if (signal.aborted) { summary.budgetExhausted = true; break; }
      if (!attempted) summary.attempted++;
      summary.failed++;
      summary.failures.push(`${row.pool_id}: ${toErrorMessage(error).slice(0, 160)}`);
    }
  }
  throwIfAborted(input.signal);
  const next = start + examined;
  const written = await writeDexSourcePaginationState({ db: input.db, sourceKey: CURSOR_KEY,
    cursor: String(next >= rows.length ? 0 : next), cycleStartedAt: state.cycleStartedAt ?? nowSec, nowSec,
    completed: next >= rows.length, pagesFetched: state.pagesFetched + 1, diagnostics: summary.failures, job: "sync-cl-exit-depth" });
  if (!written.written) throw new Error("dlmm-shadow-cursor-persistence-failed");
  await runWithOverloadRetry(() => input.db.prepare(`DELETE FROM dex_meteora_dlmm_shadow_quotes WHERE rowid IN
    (SELECT rowid FROM dex_meteora_dlmm_shadow_quotes WHERE quoted_at < ? ORDER BY quoted_at LIMIT 256)`)
    .bind(nowSec - 7 * 24 * 60 * 60).run(), 3, input.signal);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}
