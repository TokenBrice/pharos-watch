import { z } from "zod";
import {
  getDepegThresholdBps,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEFILLAMA_COINS,
  USER_AGENT,
  CIRCUIT_SOURCE,
  DEX_FRESHNESS_SEC,
  POOL_CHALLENGE_MIN_TVL,
} from "../lib/constants";

const CoinGeckoPriceSchema = z.record(z.string(), z.object({ usd: z.number().optional() }));
const DefiLlamaPriceSchema = z.object({
  coins: z.record(z.string(), z.object({ price: z.number().optional() })).optional(),
});
import { batchExecute } from "../lib/db";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { throwIfAborted } from "../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { fetchBinancePricesDetailed } from "../lib/cex-tickers";
import { isSuccessfulOutcome } from "../lib/fetcher-result";
import type { PricingProviderAttemptDiagnostic } from "../lib/pricing-provider-diagnostics";
import {
  buildInsertDepegEventStmt,
  loadDexPriceRows,
  loadDexPoolChallengers,
} from "../lib/depeg-helpers";
import {
  classifyPrimaryDepegTrust,
  isTrustedDexPriceRow,
} from "../lib/depeg-trust-policy";
import { fetchCurrentNativePegQuotes } from "../lib/native-peg-quotes";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
  pickMoreSevereBps,
} from "../lib/depeg-signals";
import {
  normalizePendingDepegRow,
  type PendingDepegRow,
  SELECT_PENDING_DEPEGS_SQL,
} from "../lib/depeg-pending";
import type { DepegEvent } from "@shared/types/market";
import type { PegAssetBase } from "@shared/types/core";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";

/**
 * Process pending depeg records that require secondary confirmation.
 * Called after detectDepegEvents() in each sync cycle.
 *
 * For each pending record:
 * 1. If primary price no longer exceeds threshold -> delete (transient noise)
 * 2. If too young (same cycle) -> skip (wait for next cycle)
 * 3. Fetch CoinGecko spot price and read DEX median
 * 4. If primary + secondary agree -> promote to real event
 * 5. If primary above but both secondary disagree -> delete (false positive)
 * 6. If no secondary data available -> keep (retry next cycle)
 * 7. If pending > 45 min without promotion -> delete (expired)
 */
export async function confirmPendingDepegs(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
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
      const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
      return {
        stablecoinId: row.stablecoin_id,
        geckoId: meta?.geckoId ?? null,
        pegCurrency: meta?.flags.pegCurrency ?? null,
      };
    }),
    signal,
    coingeckoApiKey,
  );

  // Compute peg rates for reference price lookups
  const { rates: pegRates } = derivePegRates(assets, TRACKED_META_BY_ID, fxFallbackRates);

  // Load DEX prices
  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);

  // Load individual pool prices for pool-level confirmation
  throwIfAborted(signal);
  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);

  // Check for existing open events to avoid duplicates
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
      const outcome = await fetchBinancePricesDetailed(signal);
      const { prices, diagnostics } = outcome.value;
      for (const diagnostic of diagnostics) {
        diagnostic.stage = "depeg-confirmation";
      }
      providerDiagnostics.push(...diagnostics);
      cexPrices = prices;
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, isSuccessfulOutcome(outcome));
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, false);
      cexPrices = null;
    }
  }

  // Collect all mutation statements and execute as a batch at the end
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    throwIfAborted(signal);
    const pendingState = normalizePendingDepegRow(row);
    // Guard: peg_reference is used as divisor below — skip if zero/negative
    if (!row.peg_reference || row.peg_reference <= 0) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.warn(`[depeg-confirm] Deleted pending for ${row.symbol}: invalid peg_reference=${row.peg_reference}`);
      continue;
    }

    const asset = assetById.get(row.stablecoin_id);
    const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
    const threshold = getDepegThresholdBps(row.peg_type);
    const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
    const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, now) : "unusable";
    const nativePegQuote = nativePegQuotes.get(row.stablecoin_id);
    const nativeSignal = nativePegQuote ? deriveDepegSignal(nativePegQuote.price, 1) : null;
    const nativeThresholdStatus = classifyDirectionalSignal(nativeSignal, threshold, pendingState.direction);
    const nativePegRecovered = nativeThresholdStatus === "recover";
    const nativePegStillDepegged = nativeThresholdStatus === "confirm";

    // If an open event was created by another path (e.g. direction change), clean up pending
    if (openSet.has(row.stablecoin_id)) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
      continue;
    }

    if (nativePegRecovered) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Cleared pending for ${row.symbol}: direct ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} quote recovered to ${nativeSignal?.absBps ?? "n/a"}bps`,
      );
      continue;
    }

    // 1. Check if primary price still exceeds threshold
    if (asset && primaryTrust === "authoritative") {
      const price = asset.price;
      if (price != null && typeof price === "number" && price > 0) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta?.commodityOunces);
        if (pegRef > 0) {
          const currentSignal = deriveDepegSignal(price, pegRef);
          if (classifyDirectionalSignal(currentSignal, threshold, pendingState.direction) === "recover" && !nativePegStillDepegged) {
            stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
            console.log(
              `[depeg-confirm] Cleared pending for ${row.symbol}: authoritative primary recovered to ${currentSignal?.absBps ?? "n/a"}bps`,
            );
            continue;
          }
        }
      }
    }

    // 2. Check age -- skip if too young (same cycle)
    const age = now - pendingState.firstSeenAt;
    if (age < DEPEG_PENDING_MIN_AGE_SEC) {
      continue; // Wait for next cycle
    }

    // 7. Check expiry -- delete if too old without confirmation
    if (age > DEPEG_PENDING_EXPIRY_SEC) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(`[depeg-confirm] Expired pending for ${row.symbol}: ${Math.round(age / 60)}min without confirmation`);
      continue;
    }

    // 3. Fetch CoinGecko spot price
    let offchainStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
    const geckoId = meta?.geckoId;
    if (nativeSignal != null) {
      offchainStatus = classifyDirectionalSignal(nativeSignal, secondaryBar, pendingState.direction);
      console.log(
        `[depeg-confirm] ${row.symbol} direct ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} check: ` +
        `price=${nativePegQuote?.price ?? "n/a"}, deviation=${nativeSignal.absBps}bps, ` +
        `bar=${secondaryBar}bps, status=${offchainStatus}`,
      );
    } else if (geckoId) {
      const primarySource = asset?.priceSource ?? null;
      const useDefiLlamaSecondary =
        primarySource != null && primarySource.startsWith("coingecko");
      const offchainLabel = useDefiLlamaSecondary ? "DefiLlama" : "CoinGecko";
      try {
        const offchainRes = await fetchWithRetry(
          useDefiLlamaSecondary
            ? `${DEFILLAMA_COINS}/prices/current/coingecko:${geckoId}`
            : cgUrl(`/simple/price?ids=${geckoId}&vs_currencies=usd`, coingeckoApiKey ?? null),
          useDefiLlamaSecondary
            ? { headers: { "User-Agent": USER_AGENT }, signal }
            : {
                headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
                signal,
              },
          1, // single retry
        );
        if (offchainRes?.ok) {
          let offchainPrice: number | undefined;
          if (useDefiLlamaSecondary) {
            const parsed = DefiLlamaPriceSchema.safeParse(await offchainRes.json());
            offchainPrice = parsed.success ? parsed.data.coins?.[`coingecko:${geckoId}`]?.price : undefined;
          } else {
            const parsed = CoinGeckoPriceSchema.safeParse(await offchainRes.json());
            offchainPrice = parsed.success ? parsed.data[geckoId]?.usd : undefined;
          }

          if (offchainPrice && offchainPrice > 0) {
            const offchainSignal = deriveDepegSignal(offchainPrice, row.peg_reference);
            offchainStatus = classifyDirectionalSignal(offchainSignal, secondaryBar, pendingState.direction);
            console.log(
              `[depeg-confirm] ${row.symbol} ${offchainLabel} check: price=$${offchainPrice}, deviation=${offchainSignal?.absBps ?? "n/a"}bps, ` +
              `bar=${secondaryBar}bps, status=${offchainStatus}`
            );
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn(`[depeg-confirm] ${offchainLabel} fetch failed for ${row.symbol}:`, err);
      }
    }

    // 4. Read DEX median
    let dexStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
    const dexRow = dexPriceRows.get(row.stablecoin_id);
    if (dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg")) {
      const dexSignal = deriveDepegSignal(dexRow.dex_price_usd, row.peg_reference);
      dexStatus = classifyDirectionalSignal(dexSignal, secondaryBar, pendingState.direction);
      console.log(
        `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexSignal?.absBps ?? "n/a"}bps, ` +
        `bar=${secondaryBar}bps, status=${dexStatus}`
      );
    }

    // 4b. CEX ticker check
    let cexStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
    if (cexPrices) {
      const cexPrice = cexPrices.get(row.symbol.toUpperCase());
      if (cexPrice && cexPrice > 0) {
        const cexSignal = deriveDepegSignal(cexPrice, row.peg_reference);
        cexStatus = classifyDirectionalSignal(cexSignal, secondaryBar, pendingState.direction);
        console.log(
          `[depeg-confirm] ${row.symbol} CEX check: price=$${cexPrice}, deviation=${cexSignal?.absBps ?? "n/a"}bps, ` +
          `bar=${secondaryBar}bps, status=${cexStatus}`,
        );
      }
    }

    // 4c. Individual DEX pool check
    let poolStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
    const pools = poolChallengers.get(row.stablecoin_id);
    if (pools?.length) {
      for (const pool of pools) {
        const poolSignal = deriveDepegSignal(pool.price, row.peg_reference);
        const currentPoolStatus = classifyDirectionalSignal(poolSignal, secondaryBar, pendingState.direction);
        if (currentPoolStatus === "confirm") {
          poolStatus = "confirm";
          console.log(
            `[depeg-confirm] ${row.symbol} pool check: price=$${pool.price} (${pool.protocol}/${pool.chain}), ` +
            `deviation=${poolSignal?.absBps ?? "n/a"}bps, bar=${secondaryBar}bps, status=confirm`,
          );
          break;
        }
      }
      if (poolStatus !== "confirm") {
        poolStatus = "recover";
        console.log(
          `[depeg-confirm] ${row.symbol} pool check: ${pools.length} pools, none diverge ≥${secondaryBar}bps`,
        );
      }
    }

    // 5. Decision
    // For "low-confidence" pending events, the off-chain check alone is not
    // sufficient for promotion because the primary (CG/DL) and secondary
    // (DL→CG or CG) sources often share the same underlying data, making the
    // confirmation circular rather than independent.  Require at least one
    // hard secondary source (DEX, CEX, or individual pool) to promote.
    const hasHardConfirmation =
      dexStatus === "confirm" ||
      cexStatus === "confirm" ||
      poolStatus === "confirm";
    if (hasHardConfirmation || (offchainStatus === "confirm" && pendingState.reason !== "low-confidence")) {
      // At least one secondary source confirms -- promote to real event (INSERT + DELETE atomically)
      const authoritativePrice =
        asset != null &&
        primaryTrust === "authoritative" &&
        asset.price != null &&
        typeof asset.price === "number"
          ? asset.price
          : null;
      const currentSignal =
        authoritativePrice != null
          ? deriveDepegSignal(authoritativePrice, row.peg_reference)
          : null;
      const currentDirectionalSignal =
        classifyDirectionalSignal(currentSignal, threshold, pendingState.direction) === "confirm"
          ? currentSignal
          : null;
      const peakDeviationBps =
        pickMoreSevereBps(pendingState.peakSeenBps, currentDirectionalSignal?.bps)
        ?? pendingState.peakSeenBps;
      const peakPrice =
        peakDeviationBps === currentDirectionalSignal?.bps
          ? authoritativePrice ?? pendingState.peakPrice
          : pendingState.peakPrice;
      const event: DepegEvent = {
        id: 0,
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        pegType: row.peg_type,
        direction: pendingState.direction,
        peakDeviationBps,
        startedAt: pendingState.firstSeenAt,
        endedAt: null,
        startPrice: pendingState.firstPrice,
        peakPrice,
        recoveryPrice: null,
        pegReference: row.peg_reference,
        source: "live",
      };

      stmts.push(
        buildInsertDepegEventStmt(db, event),
        db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id),
      );

      const confirmedBy = [
        offchainStatus === "confirm" ? (asset?.priceSource?.startsWith("coingecko") ? "DefiLlama" : "CoinGecko") : null,
        dexStatus === "confirm" ? "DEX" : null,
        cexStatus === "confirm" ? "CEX" : null,
        poolStatus === "confirm" ? "Pool" : null,
      ].filter(Boolean).join("+");
      console.log(
        `[depeg-confirm] PROMOTED ${row.symbol}: ${pendingState.firstSeenBps}bps confirmed by ${confirmedBy}${pendingState.reason ? ` (${pendingState.reason})` : ""}`
      );
    } else if (
      (offchainStatus === "recover" || offchainStatus === "contradict")
      && (dexStatus === "recover" || dexStatus === "contradict")
    ) {
      // Both secondary sources disagree, pools didn't confirm either -- confirmed false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected false positive for ${row.symbol}: both off-chain and DEX checks disagree`
      );
    } else if (
      (offchainStatus === "recover" || offchainStatus === "contradict")
      && dexStatus === "insufficient"
      && cexStatus !== "confirm"
      && poolStatus !== "confirm"
    ) {
      // Off-chain check disagrees, no DEX data, pools didn't confirm -- lean toward false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected ${row.symbol}: off-chain check disagrees, no DEX data`
      );
    }
    // else: insufficient secondary data or mixed evidence -- keep pending and retry next cycle
  }

  // Execute all collected mutations atomically
  if (stmts.length > 0) {
    throwIfAborted(signal);
    await batchExecute(db, stmts);
    console.log(`[depeg-confirm] Executed ${stmts.length} pending depeg mutations`);
  }

  return { providerDiagnostics };
}
