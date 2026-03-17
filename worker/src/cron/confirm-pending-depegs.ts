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
import { batchExecute } from "../lib/db";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { throwIfAborted } from "../lib/abort";
import { shouldAttemptFetch } from "../lib/circuit-breaker";
import { fetchBinancePrices } from "../lib/cex-tickers";
import {
  buildInsertDepegEventStmt,
  classifyPrimaryDepegTrust,
  isTrustedDexPriceRow,
  loadDexPriceRows,
  loadDexPoolChallengers,
} from "../lib/depeg-helpers";
import type { DepegEvent, PegAssetBase } from "@shared/types";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";

interface PendingRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  peg_reference: number;
  reason?: "large-cap" | "low-confidence" | "extreme-move";
}

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
): Promise<void> {
  throwIfAborted(signal);
  const pending = await db
    .prepare("SELECT id, stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference, reason FROM depeg_pending")
    .all<PendingRow>();

  const rows = pending.results ?? [];
  if (rows.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const assetById = new Map(assets.map((a) => [a.id, a]));

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

  // Collect all mutation statements and execute as a batch at the end
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    throwIfAborted(signal);
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

    // If an open event was created by another path (e.g. direction change), clean up pending
    if (openSet.has(row.stablecoin_id)) {
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
      continue;
    }

    // 1. Check if primary price still exceeds threshold
    if (asset && primaryTrust === "authoritative") {
      const price = asset.price;
      if (price != null && typeof price === "number" && price > 0) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta?.commodityOunces);
        if (pegRef > 0) {
          const currentBps = Math.abs(Math.round(((price / pegRef) - 1) * 10000));
          if (currentBps < threshold) {
            stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
            console.log(`[depeg-confirm] Cleared pending for ${row.symbol}: authoritative primary recovered to ${currentBps}bps`);
            continue;
          }
        }
      }
    }

    // 2. Check age -- skip if too young (same cycle)
    const age = now - row.first_seen_at;
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
    let offchainAgrees: boolean | null = null; // null = no data
    const geckoId = meta?.geckoId;
    if (geckoId) {
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
            const dlData = (await offchainRes.json()) as {
              coins?: Record<string, { price?: number }>;
            };
            offchainPrice = dlData.coins?.[`coingecko:${geckoId}`]?.price;
          } else {
            const cgData = (await offchainRes.json()) as Record<string, { usd?: number }>;
            offchainPrice = cgData[geckoId]?.usd;
          }

          if (offchainPrice && offchainPrice > 0) {
            const offchainBps = Math.abs(Math.round(((offchainPrice / row.peg_reference) - 1) * 10000));
            offchainAgrees = offchainBps >= secondaryBar;
            console.log(
              `[depeg-confirm] ${row.symbol} ${offchainLabel} check: price=$${offchainPrice}, deviation=${offchainBps}bps, ` +
              `bar=${secondaryBar}bps, agrees=${offchainAgrees}`
            );
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn(`[depeg-confirm] ${offchainLabel} fetch failed for ${row.symbol}:`, err);
      }
    }

    // 4. Read DEX median
    let dexAgrees: boolean | null = null;
    const dexRow = dexPriceRows.get(row.stablecoin_id);
    if (dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg")) {
      const dexBps = Math.abs(Math.round(
        ((dexRow.dex_price_usd / row.peg_reference) - 1) * 10000
      ));
      dexAgrees = dexBps >= secondaryBar;
      console.log(
        `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexBps}bps, ` +
        `bar=${secondaryBar}bps, agrees=${dexAgrees}`
      );
    }

    // 4b. CEX ticker check
    let cexAgrees: boolean | null = null;
    const cexAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
    if (cexAllowed) {
      try {
        const cexPrices = await fetchBinancePrices(signal);
        const cexPrice = cexPrices.get(row.symbol.toUpperCase());
        if (cexPrice && cexPrice > 0) {
          const cexBps = Math.abs(Math.round(((cexPrice / row.peg_reference) - 1) * 10000));
          cexAgrees = cexBps >= secondaryBar;
          console.log(
            `[depeg-confirm] ${row.symbol} CEX check: price=$${cexPrice}, deviation=${cexBps}bps, ` +
            `bar=${secondaryBar}bps, agrees=${cexAgrees}`,
          );
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      }
    }

    // 4c. Individual DEX pool check
    let poolAgrees: boolean | null = null;
    const pools = poolChallengers.get(row.stablecoin_id);
    if (pools?.length) {
      for (const pool of pools) {
        const poolBps = Math.abs(Math.round(((pool.price / row.peg_reference) - 1) * 10000));
        if (poolBps >= secondaryBar) {
          poolAgrees = true;
          console.log(
            `[depeg-confirm] ${row.symbol} pool check: price=$${pool.price} (${pool.protocol}/${pool.chain}), ` +
            `deviation=${poolBps}bps, bar=${secondaryBar}bps, agrees=true`,
          );
          break;
        }
      }
      if (poolAgrees !== true) {
        poolAgrees = false;
        console.log(
          `[depeg-confirm] ${row.symbol} pool check: ${pools.length} pools, none diverge ≥${secondaryBar}bps`,
        );
      }
    }

    // 5. Decision
    if (offchainAgrees === true || dexAgrees === true || cexAgrees === true || poolAgrees === true) {
      // At least one secondary source confirms -- promote to real event (INSERT + DELETE atomically)
      const authoritativePrice =
        asset != null &&
        primaryTrust === "authoritative" &&
        asset.price != null &&
        typeof asset.price === "number"
          ? asset.price
          : null;
      const useCurrentPrimary = authoritativePrice != null;
      const currentPrice = authoritativePrice ?? row.first_price;
      const currentBps = useCurrentPrimary
        ? Math.round(((authoritativePrice / row.peg_reference) - 1) * 10000)
        : row.first_seen_bps;
      const event: DepegEvent = {
        id: 0,
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        pegType: row.peg_type,
        direction: row.direction as "above" | "below",
        peakDeviationBps:
          Math.abs(currentBps) > Math.abs(row.first_seen_bps) ? currentBps : row.first_seen_bps,
        startedAt: row.first_seen_at,
        endedAt: null,
        startPrice: row.first_price,
        peakPrice: currentPrice,
        recoveryPrice: null,
        pegReference: row.peg_reference,
        source: "live",
      };

      stmts.push(
        buildInsertDepegEventStmt(db, event),
        db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id),
      );

      const confirmedBy = [
        offchainAgrees ? (asset?.priceSource?.startsWith("coingecko") ? "DefiLlama" : "CoinGecko") : null,
        dexAgrees ? "DEX" : null,
        cexAgrees ? "CEX" : null,
        poolAgrees ? "Pool" : null,
      ].filter(Boolean).join("+");
      console.log(
        `[depeg-confirm] PROMOTED ${row.symbol}: ${row.first_seen_bps}bps confirmed by ${confirmedBy}${row.reason ? ` (${row.reason})` : ""}`
      );
    } else if (offchainAgrees === false && dexAgrees === false) {
      // Both secondary sources disagree, pools didn't confirm either -- confirmed false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected false positive for ${row.symbol}: both off-chain and DEX checks disagree`
      );
    } else if (offchainAgrees === false && dexAgrees === null) {
      // Off-chain check disagrees, no DEX data, pools didn't confirm -- lean toward false positive
      stmts.push(db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id));
      console.log(
        `[depeg-confirm] Rejected ${row.symbol}: off-chain check disagrees, no DEX data`
      );
    }
    // else: offchainAgrees === null and dexAgrees === null (or null+false) -- keep pending, retry next cycle
  }

  // Execute all collected mutations atomically
  if (stmts.length > 0) {
    throwIfAborted(signal);
    await batchExecute(db, stmts);
    console.log(`[depeg-confirm] Executed ${stmts.length} pending depeg mutations`);
  }
}
