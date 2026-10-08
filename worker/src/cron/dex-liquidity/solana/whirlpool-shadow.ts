import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getDexMeasuredExecutionProbeNotionals } from "@shared/types/measured-execution";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { SolanaDexShadowTarget, SolanaDexBankCaptureSink, SolanaDexBankCapture, SolanaDexNativeQuote } from "@shared/types/solana-dex-bank";
import { parseUnits } from "viem/utils";
import { runWithOverloadRetry } from "../../../lib/d1-overload-retry";
import { throwIfAborted } from "../../../lib/abort";
import type { AdapterContext } from "../../reserve-adapters/types";
import { fetchSolanaAccountBatch } from "../../reserve-adapters/solana";
import { buildNativeDexExecutionTarget } from "../../measured-execution/inventory";
import { buildNativeDexGenerationId, captureNativeDexPublisherFence, publishNativeDexGeneration, pruneNativeDexGenerations } from "../../measured-execution/native-generation-store";
import { loadTrackedStablecoinMaps } from "../orchestrator-phases/lookups";
import { readDexSourcePaginationState, writeDexSourcePaginationState } from "../source-pagination-state";
import { decodeWhirlpool, fetchWhirlpoolSnapshot, ORCA_WHIRLPOOL_PROGRAM_ID, quoteWhirlpoolExactIn } from "./whirlpool-quote";
import { decodeRaydiumPool, fetchRaydiumSnapshot, RAYDIUM_CLMM_PROGRAM_ID, quoteRaydiumExactIn } from "./raydium-clmm-quote";

const MAX_POOLS = 4;
const MAX_RETAINED_CANDIDATES = 64;
const RUNTIME_MS = 45_000;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
type Family = "orca" | "raydium-clmm";
interface RetainedPool { pool_id: string; stablecoin_id: string; tvl_usd: number }
interface RetainedCandidate extends RetainedPool { total_count: number; publication_generation_id: string }


interface SolanaShadowSummary {
  attempted: number;
  persisted: number;
  failed: number;
  quotePointsPersisted: number;
  quotePointsRejected: number;
  retainedCandidateCount: number;
  retainedCandidatesRead: number;
  sourceGenerationId: string | null;
  budgetExhausted: boolean;
  scoreEligible: false;
  nativeGenerationId: string | null;
  durationMs: number;
  skippedIneligible: Record<string, number>;
  failures: string[];
}
interface CollectorInput { db: D1Database; signal?: AbortSignal; ctx?: AdapterContext; onBankCapture?: SolanaDexBankCaptureSink; publisherInvocationId?: string; publisherAttemptNo?: number }

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
  const summary: SolanaShadowSummary = { attempted: 0, persisted: 0, failed: 0, quotePointsPersisted: 0, quotePointsRejected: 0, retainedCandidateCount: 0, retainedCandidatesRead: 0, sourceGenerationId: null, budgetExhausted: false, scoreEligible: false, nativeGenerationId: null, durationMs: 0, skippedIneligible: {}, failures: [] };
  const generationId = buildNativeDexGenerationId(nowSec);
  const profileId: SolanaDexShadowTarget["profileId"] = family === "orca" ? "orca-whirlpool-exact-v1" : "raydium-clmm-exact-v1";
  const nativeQuotes: SolanaDexNativeQuote[] = [];
  const orca = family === "orca";
  const cursorKey = orca ? "orca-whirlpool-native-shadow:v1" : "raydium-clmm-native-shadow:v1";
  throwIfAborted(input.signal);
  const publisherFence = input.publisherInvocationId === undefined ? undefined
    : await captureNativeDexPublisherFence(input.db, input.publisherInvocationId, input.publisherAttemptNo ?? 1, nowSec);
  const state = await readDexSourcePaginationState(input.db, cursorKey, "sync-cl-exit-depth");
  const parsedCursor = Number(state.cursor ?? 0);
  const start = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  // Idempotent read: on 2026-09-23 the 15:05 run failed both shadow families
  // in ~24ms because this first D1 read hit the transient overload window.
  const retained = await runWithOverloadRetry(
    () => input.db.prepare(`WITH candidates AS (
      SELECT json_extract(pool.value, '$.poolId') AS pool_id,
        dl.stablecoin_id, json_extract(pool.value, '$.tvlUsd') AS tvl_usd,
        dl.publication_generation_id,
        ROW_NUMBER() OVER (PARTITION BY json_extract(pool.value, '$.poolId')
          ORDER BY json_extract(pool.value, '$.tvlUsd') DESC, dl.stablecoin_id) AS source_rank
      FROM dex_liquidity dl, json_each(dl.top_pools_json) pool
      WHERE dl.updated_at >= ? AND dl.publication_state = 'published'
        AND dl.publication_generation_id = (
          SELECT publication_generation_id FROM dex_liquidity
          WHERE stablecoin_id = '__global__' AND publication_state = 'published')
        AND lower(json_extract(pool.value, '$.chain')) = 'solana'
        AND ((? = 'orca' AND json_extract(pool.value, '$.project') = 'orca')
          OR (? = 'raydium-clmm' AND json_extract(pool.value, '$.project') IN ('raydium', 'raydium-amm', 'raydium-clmm')
            AND json_extract(pool.value, '$.poolType') = 'raydium-clmm'))
        AND json_extract(pool.value, '$.tvlUsd') > 0
    )
    SELECT pool_id, stablecoin_id, tvl_usd, publication_generation_id, COUNT(*) OVER () AS total_count
    FROM candidates WHERE source_rank = 1
    ORDER BY tvl_usd DESC, pool_id LIMIT ? OFFSET ?`)
      .bind(nowSec - 24 * 60 * 60, family, family, MAX_RETAINED_CANDIDATES, start).all<RetainedCandidate>(),
    3,
    input.signal,
  );
  const rows = retained.results ?? [];
  summary.retainedCandidateCount = rows[0]?.total_count ?? 0;
  summary.retainedCandidatesRead = rows.length;
  summary.sourceGenerationId = rows[0]?.publication_generation_id ?? null;
  const { stablecoinPriceById } = await loadTrackedStablecoinMaps(input.db, nowSec);
  let examined = 0;
  function skip(reason: string) { summary.skippedIneligible[reason] = (summary.skippedIneligible[reason] ?? 0) + 1; }
  for (const row of rows) {
    if (summary.attempted >= MAX_POOLS) break;
    if (signal.aborted || Date.now() - startedAt >= RUNTIME_MS) { summary.budgetExhausted = true; break; }
    examined++;
    if (!ACTIVE_META_BY_ID.has(row.stablecoin_id)) { skip("inactive-tracked-asset"); continue; }
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.pool_id)) { skip("invalid-retained-pool-identity"); continue; }
    if (!Number.isFinite(row.tvl_usd) || row.tvl_usd <= 0) { skip("invalid-retained-tvl"); continue; }
    let quoteAttempted = false;
    let nativeQuote: SolanaDexNativeQuote | null = null;
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
      const target = buildNativeDexExecutionTarget({
        chain: "solana", profileId, poolAddress, stablecoinId: row.stablecoin_id,
        tokenMintIn, tokenMintOut: tokenMintIn === pool.tokenMintA ? pool.tokenMintB : pool.tokenMintA,
      });
      nativeQuote = { target, scoreEligible: false, bank: null, bankRef: null, proofRef: null,
        programId: orca ? ORCA_WHIRLPOOL_PROGRAM_ID : RAYDIUM_CLMM_PROGRAM_ID,
        arrayAddresses: [], dependencyAddresses: [], inputPriceUsd: price, inputDecimals: mintBatch.accounts.get(tokenMintIn)!.data[44], points: [] };
      nativeQuotes.push(nativeQuote);
      const captured: { bank: SolanaDexBankCapture | null } = { bank: null };
      const onBankCapture: SolanaDexBankCaptureSink = async (bank) => {
        captured.bank = bank;
        await input.onBankCapture?.(bank);
      };
      const snapshot = orca
        ? await fetchWhirlpoolSnapshot(poolAddress, pool, signal, input.ctx, mintBatch.slot, onBankCapture)
        : await fetchRaydiumSnapshot(poolAddress, decodeRaydiumPool(account.data, discovery.slot), tokenMintIn, signal, input.ctx, mintBatch.slot, onBankCapture);
      const inputMint = snapshot.mints.find((mint) => mint.address === tokenMintIn);
      if (!inputMint) {
        skip("invalid-retained-mint");
        nativeQuote.points = getDexMeasuredExecutionProbeNotionals(row.tvl_usd).map((notionalUsd) => ({
          status: "unavailable", notionalUsd, quotedAt: Math.floor(Date.now() / 1_000), reason: "invalid-retained-mint",
        }));
        continue;
      }
      const decimals = inputMint.account.data[44];
      nativeQuote.bank = captured.bank;
      nativeQuote.bankRef = captured.bank ? `${generationId}:${target.targetId}:bank:${captured.bank.slot}` : null;
      nativeQuote.proofRef = nativeQuote.bankRef ? `${nativeQuote.bankRef}:local-model` : null;
      nativeQuote.arrayAddresses = snapshot.tickArrays.map((array) => array.address);
      nativeQuote.dependencyAddresses = "feeRate" in snapshot ? snapshot.dependencyAddresses : [];
      nativeQuote.inputDecimals = decimals;
      const tokenMintOut = tokenMintIn === snapshot.pool.tokenMintA ? snapshot.pool.tokenMintB : snapshot.pool.tokenMintA;
      if (tokenMintOut !== target.tokenMintOut || !captured.bank) throw new Error("native-final-bank-identity-unavailable");
      let persisted = false;
      // Every policy probe uses this same bank. Higher-notional traversal
      // failures are unknown, never synthetic zero capacity or partial fills.
      for (const notionalUsd of getDexMeasuredExecutionProbeNotionals(row.tvl_usd)) {
        throwIfAborted(signal);
        let amountIn: bigint;
        let quote: { amountOut: bigint; slot: number };
        try {
          const tokenAmount = notionalUsd / price;
          if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || tokenAmount >= 1e21) throw new Error("Invalid exact-in notional");
          amountIn = parseUnits(tokenAmount.toFixed(decimals), decimals);
          quote = "feeRate" in snapshot
            ? quoteRaydiumExactIn(snapshot, tokenMintIn, amountIn)
            : quoteWhirlpoolExactIn(snapshot, tokenMintIn, amountIn);
          if (quote.amountOut <= 0n) throw new Error("Zero native shadow output");
        } catch (error) {
          summary.quotePointsRejected++;
          nativeQuote.points.push({ status: "failed", notionalUsd, quotedAt: Math.floor(Date.now() / 1_000),
            reason: `native-quote-failed:${toErrorMessage(error).slice(0, 180)}` });
          summary.failures.push(`${row.pool_id}@${notionalUsd}: ${toErrorMessage(error).slice(0, 180)}`);
          continue;
        }
        const quotedAt = Math.floor(Date.now() / 1_000);
        nativeQuote.points.push({ status: "full-fill", notionalUsd, quotedAt, slot: quote.slot,
          amountInRaw: amountIn.toString(), amountOutRaw: quote.amountOut.toString(),
          outputRef: `${nativeQuote.bankRef}:quote:${notionalUsd}` });
        summary.quotePointsPersisted++;
        persisted = true;
      }
      if (persisted) summary.persisted++;
      else summary.failed++;
    } catch (error) {
      throwIfAborted(input.signal);
      if (nativeQuote) {
        const recorded = new Set(nativeQuote.points.map((point) => point.notionalUsd));
        for (const notionalUsd of getDexMeasuredExecutionProbeNotionals(row.tvl_usd)) {
          if (!recorded.has(notionalUsd)) nativeQuote.points.push({
            status: "unavailable", notionalUsd, quotedAt: Math.floor(Date.now() / 1_000),
            reason: `native-bank-unavailable:${toErrorMessage(error).slice(0, 180)}`,
          });
        }
      }
      if (signal.aborted) { summary.budgetExhausted = true; break; }
      if (!quoteAttempted) summary.attempted++;
      summary.failed++;
      summary.failures.push(`${row.pool_id}: ${toErrorMessage(error).slice(0, 180)}`);
    }
  }
  throwIfAborted(input.signal);
  const next = start + examined;
  const cursorWrite = await writeDexSourcePaginationState({
    db: input.db, sourceKey: cursorKey, cursor: String(next >= summary.retainedCandidateCount ? 0 : next),
    cycleStartedAt: state.cycleStartedAt ?? nowSec, nowSec, completed: next >= summary.retainedCandidateCount,
    pagesFetched: state.pagesFetched + 1, diagnostics: summary.failures, job: "sync-cl-exit-depth",
  });
  if (!cursorWrite.written) throw new Error(`${family} shadow cursor persistence failed`);
  const publishedAt = Math.floor(Date.now() / 1_000);
  const published = await publishNativeDexGeneration(input.db, {
    schemaVersion: "solana-dex-generation-v1", generationId, profileId,
    sourceGenerationId: summary.sourceGenerationId, startedAt: nowSec, publishedAt,
    scoreEligible: false, quotes: nativeQuotes,
  }, input.signal, publisherFence);
  summary.nativeGenerationId = published ? generationId : null;
  await pruneNativeDexGenerations(input.db, publishedAt, input.signal);
  summary.durationMs = Date.now() - startedAt;
  return summary;
}
