import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { derivePegRates } from "@shared/lib/peg-rates";
import type { PegAssetBase } from "@shared/types/core";
import {
  CIRCUIT_SOURCE,
  DEX_FRESHNESS_SEC,
  POOL_CHALLENGE_MIN_TVL,
} from "../lib/constants";
import { batchExecute } from "../lib/db";
import {
  loadDexPoolChallengers,
  loadDexPriceRows,
  loadDexPriceSources,
} from "../lib/depeg-helpers";
import {
  normalizePendingDepegRow,
  SELECT_PENDING_DEPEGS_SQL,
  type PendingDepegRow,
} from "../lib/depeg-pending";
import { throwIfAborted } from "../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import {
  createBinanceFetchSession,
  fetchBinancePricesForRun,
  type BinanceFetchSession,
} from "../lib/cex-tickers";
import { isSuccessfulOutcome } from "../lib/fetcher-result";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteSession,
} from "../lib/native-peg-quotes";
import type { PricingProviderAttemptDiagnostic } from "../lib/pricing-provider-diagnostics";
import {
  buildConfirmationPlan,
} from "./pending-depeg-confirmation";
import { evaluatePromotionDecision } from "./pending-depeg-confirmation-decision";
import { collectConfirmationEvidence } from "./pending-depeg-confirmation-evidence";

/**
 * Process pending depeg records that require secondary confirmation.
 * Called after detectDepegEvents() in each sync cycle.
 *
 * For each pending record:
 * 1. Refresh peg/native/primary context and remove recovered, invalid, or
 *    superseded rows.
 * 2. Wait until the pending age clears the same-cycle minimum.
 * 3. Collect independent confirmation evidence from native peg quotes,
 *    CoinGecko/DefiLlama, DEX aggregate rows, CEX prices, and challenger pools.
 * 4. Apply the decision policy: promote when independent confirmation is
 *    strong enough, reject opposing evidence, expire rows past their dynamic
 *    limit, or leave mixed/insufficient evidence pending for the next cycle.
 */
export async function confirmPendingDepegs(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  binanceSession?: BinanceFetchSession,
  nativePegSession?: NativePegQuoteSession,
): Promise<{ providerDiagnostics: PricingProviderAttemptDiagnostic[] }> {
  throwIfAborted(signal);
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];
  const pending = await db
    .prepare(SELECT_PENDING_DEPEGS_SQL)
    .all<PendingDepegRow>();

  const rows = pending.results ?? [];
  if (rows.length === 0) return { providerDiagnostics };

  const now = Math.floor(Date.now() / 1000);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const nativePegQuotes = await fetchCurrentNativePegQuotes(
    rows.map((row) => {
      const meta = ACTIVE_META_BY_ID.get(row.stablecoin_id);
      return {
        stablecoinId: row.stablecoin_id,
        geckoId: meta?.geckoId ?? null,
        pegCurrency: meta?.flags.pegCurrency ?? null,
      };
    }),
    signal,
    coingeckoApiKey,
    undefined,
    nativePegSession,
  );

  const {
    rates: pegRates,
    sources: pegRateSources,
    counts: pegRateCounts,
  } = derivePegRates(assets, ACTIVE_META_BY_ID, fxFallbackRates);

  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db, DEX_FRESHNESS_SEC);

  throwIfAborted(signal);
  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);

  throwIfAborted(signal);
  const openEvents = await db
    .prepare("SELECT stablecoin_id FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string }>();
  const openSet = new Set((openEvents.results ?? []).map((r) => r.stablecoin_id));

  let cexPrices: Map<string, number> | null = null;
  const cexAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
  if (cexAllowed) {
    throwIfAborted(signal);
    try {
      const outcome = await fetchBinancePricesForRun(
        db,
        binanceSession ?? createBinanceFetchSession(),
        signal,
        now,
      );
      const { prices, diagnostics } = outcome.value;
      for (const diagnostic of diagnostics) {
        providerDiagnostics.push({ ...diagnostic, stage: "depeg-confirmation" });
      }
      cexPrices = prices;
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, isSuccessfulOutcome(outcome));
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, false);
      cexPrices = null;
    }
  }

  const coingeckoAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.COINGECKO_CONFIRM);

  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    throwIfAborted(signal);
    const pendingState = normalizePendingDepegRow(row);
    const plan = buildConfirmationPlan({
      db,
      row,
      pendingState,
      asset: assetById.get(row.stablecoin_id),
      meta: ACTIVE_META_BY_ID.get(row.stablecoin_id),
      pegRates,
      pegRateSources,
      pegRateCounts,
      nativePegQuote: nativePegQuotes.get(row.stablecoin_id),
      openSet,
      now,
    });

    if (plan.kind === "mutate") {
      stmts.push(...plan.statements);
      continue;
    }
    if (plan.kind === "wait") {
      continue;
    }

    const evidence = await collectConfirmationEvidence({
      ...plan,
      db,
      dexPriceRows,
      dexPriceSources,
      poolChallengers,
      cexAllowed,
      cexPrices,
      coingeckoAllowed,
      coingeckoApiKey,
      signal,
      now,
    });

    stmts.push(
      ...evaluatePromotionDecision({
        db,
        plan,
        evidence,
        now,
      }),
    );
  }

  if (stmts.length > 0) {
    throwIfAborted(signal);
    await batchExecute(db, stmts, { signal });
    console.log(`[depeg-confirm] Executed ${stmts.length} pending depeg mutations`);
  }

  return { providerDiagnostics };
}
