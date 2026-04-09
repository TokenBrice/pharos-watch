import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { ContractDeployment } from "@shared/types/core";
import { DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { fetchCoinGeckoMarketHistory } from "../lib/coingecko-market-history";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { batchExecute } from "../lib/db";
import { jsonResponse } from "../lib/api-utils";
import { binarySearchNearest } from "../lib/binary-search";
import { resolveMarketCap } from "../lib/resolve-market-cap";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse, runAdminJob } from "../lib/admin-job";
import { fetchWithRetry } from "../lib/fetch-retry";
import { fetchEvmUint256AtBlock } from "../lib/evm-rpc";
import { TOTAL_SUPPLY_SELECTOR } from "../lib/evm-selectors";
import { extractDefiLlamaCoinChartPrices } from "./stablecoin-detail/shared";
import { fetchMarketBackfillPriceSeries } from "./backfill-price-sources";

const DEFAULT_BATCH_SIZE = 10;

interface TokenEntry {
  date: number; // unix seconds
  circulating?: Record<string, number>;
}

interface StablecoinDetail {
  price?: number;
  tokens?: TokenEntry[];
}

// Commodity tokens: use CoinGecko market_chart (historical market caps) as primary source.
// Protocol TVL from DefiLlama can diverge from token market cap (e.g. XAUT TVL includes
// multi-chain reserves that far exceed the token's market cap).

function firstEvmContract(contracts?: ContractDeployment[]): ContractDeployment | null {
  return (
    contracts?.find(
      (c) => c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron",
    ) ?? null
  );
}

async function fetchOnChainTotalSupply(
  contracts: ContractDeployment[] | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  logLabel: string,
): Promise<number | null> {
  const contract = firstEvmContract(contracts);
  if (!contract || !chainRpcs) return null;

  try {
    const raw = await fetchEvmUint256AtBlock(
      contract.chain,
      contract.address,
      TOTAL_SUPPLY_SELECTOR,
      "latest",
      { chainRpcs, timeoutMs: 10_000 },
    );
    if (raw == null || raw <= 0n) return null;
    const supply = Number(raw) / 10 ** (contract.decimals ?? 18);
    if (!Number.isFinite(supply) || supply <= 0) return null;
    console.log(
      `[backfill-commodity] ${logLabel}: on-chain totalSupply fallback = ${supply.toFixed(2)} units`,
    );
    return supply;
  } catch (err) {
    console.warn(
      `[backfill-commodity] ${logLabel}: on-chain totalSupply probe failed — ${String(err).slice(0, 200)}`,
    );
    return null;
  }
}

async function backfillCommodity(
  db: D1Database,
  id: string,
  config: {
    geckoId: string;
    protocolSlug?: string;
    cgApiKey?: string | null;
    contracts?: ContractDeployment[];
    chainRpcs?: Map<string, ChainRpcConfig>;
  },
): Promise<{ rows: number; error?: string }> {
  const marketHistory = await fetchCoinGeckoMarketHistory(config.geckoId, {
    apiKey: config.cgApiKey ?? null,
    onCoinDetailFailure: (status) => {
      console.warn(
        `[backfill-commodity] ${config.geckoId}: coin detail fetch failed (${status}), sanity check skipped`,
      );
    },
  });

  let fallthroughReason = "CoinGecko market_chart returned no data";
  if (marketHistory?.prices.length) {
    fallthroughReason =
      "CoinGecko market caps all zero and on-chain totalSupply unavailable (no EVM contract or chainRpcs)";
    // Build a date-keyed map of cgMcap so we can pair each price point with its matching cap.
    const cgMcapByDate = new Map<string, number>();
    for (const [ts, mcap] of marketHistory.marketCaps) {
      if (Number.isFinite(mcap)) {
        cgMcapByDate.set(new Date(ts).toISOString().slice(0, 10), mcap);
      }
    }

    // CoinGecko's circulating_supply is often 0 for brand-new coins until its data
    // ingestion catches up. Fall back to on-chain totalSupply (same strategy the live
    // sync uses via fetchFiatCoinGeckoTokens) so `resolveMarketCap` can compute
    // supply × price when the CG market_cap series is all zeros.
    let effectiveSupply = marketHistory.circulatingSupply;
    if (!effectiveSupply || effectiveSupply <= 0) {
      const onChain = await fetchOnChainTotalSupply(
        config.contracts,
        config.chainRpcs,
        `${id} (${config.geckoId})`,
      );
      if (onChain != null) effectiveSupply = onChain;
    }

    const stmts: D1PreparedStatement[] = [];
    const seenSnapshotDates = new Set<number>();

    for (const [ts, price] of marketHistory.prices) {
      if (!Number.isFinite(price) || price <= 0) continue;
      const snapshotDate = Math.floor(ts / 1000 / DAY_SECONDS) * DAY_SECONDS;
      if (seenSnapshotDates.has(snapshotDate)) continue;
      const cgMcap = cgMcapByDate.get(new Date(ts).toISOString().slice(0, 10));
      const resolvedMcap = resolveMarketCap(cgMcap, effectiveSupply, price);
      if (!Number.isFinite(resolvedMcap) || resolvedMcap <= 0) continue;

      seenSnapshotDates.add(snapshotDate);
      stmts.push(
        db
          .prepare(
            "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
          )
          .bind(id, snapshotDate, resolvedMcap, price),
      );
    }

    if (stmts.length > 0) {
      await batchExecute(db, stmts);
      return { rows: stmts.length };
    }
    // Fell through: CG had prices but no usable mcap (all zero) and on-chain supply unavailable.
    // Fall back to the protocol-TVL path below when possible, otherwise return a clear error.
  }

  // Fallback: protocol TVL (only if TVL ≈ mcap)
  if (!config.protocolSlug) {
    return { rows: 0, error: `${fallthroughReason}; no protocolSlug for TVL fallback` };
  }

  const [protocolRes, priceRes] = await Promise.all([
    fetchWithRetry(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetchWithRetry(`${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=0&span=500`, {
      headers: { "User-Agent": USER_AGENT },
    }),
  ]);

  if (!protocolRes?.ok) {
    return { rows: 0, error: `protocol API returned ${protocolRes?.status ?? "no response"}` };
  }

  const protocolData = (await protocolRes.json()) as {
    mcap?: number;
    tvl?: { date: number; totalLiquidityUSD: number }[];
  };
  const tvlHistory = protocolData.tvl ?? [];
  if (tvlHistory.length === 0) {
    return { rows: 0, error: "no TVL history and CoinGecko unavailable" };
  }

  // Skip TVL if it diverges from mcap (same 15% threshold as sync code)
  const currentMcap = protocolData.mcap;
  if (currentMcap && tvlHistory.length > 0) {
    const latestTvl = tvlHistory[tvlHistory.length - 1].totalLiquidityUSD;
    const ratio = currentMcap / latestTvl;
    if (ratio < 0.85 || ratio > 1.15) {
      return { rows: 0, error: `TVL/mcap divergence (ratio=${ratio.toFixed(3)}), CoinGecko also unavailable` };
    }
  }

  let prices: { timestamp: number; price: number }[] = [];
  if (priceRes?.ok) {
    prices = extractDefiLlamaCoinChartPrices(await priceRes.json(), config.geckoId);
  }

  function findPrice(date: number): number | null {
    return binarySearchNearest(prices, date, (p) => p.timestamp)?.price ?? null;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const point of tvlHistory) {
    const mcap = point.totalLiquidityUSD;
    if (mcap <= 0) continue;
    const snapshotDate = Math.floor(point.date / DAY_SECONDS) * DAY_SECONDS;
    const price = findPrice(point.date);
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
        )
        .bind(id, snapshotDate, mcap, price),
    );
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }
  return { rows: stmts.length };
}

export async function handleBackfillSupplyHistory(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
  cgApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  return runAdminJob(
    { request, trustedAdmin, url },
    async () => {
      const allowConstantPriceFallback = url.searchParams.get("allow-constant-price-fallback") === "true";

      const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
        defaultBatchSize: DEFAULT_BATCH_SIZE,
      });
      if ("response" in selection) {
        return selection.response;
      }
      const coins = selection.coins;

      if (coins.length === 0) {
        return noAdminTargetsResponse();
      }

      let totalRows = 0;
      const errors: string[] = [];
      const skipped: string[] = [];

      for (const meta of coins) {
        // Commodity tokens: backfill from CoinGecko market_chart (primary) or protocol TVL (fallback)
        const isCommodity = meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER";
        if (isCommodity && meta.geckoId) {
          try {
            const result = await backfillCommodity(db, meta.id, {
              geckoId: meta.geckoId,
              protocolSlug: meta.protocolSlug ?? undefined,
              cgApiKey,
              contracts: meta.contracts,
              chainRpcs,
            });
            if (result.error) {
              errors.push(`${meta.symbol}: ${result.error}`);
            } else {
              totalRows += result.rows;
            }
          } catch (err) {
            errors.push(`${meta.symbol}: commodity backfill failed — ${err}`);
          }
          continue;
        }

        // CoinGecko-only and non-gold/silver commodity coins: backfill via CoinGecko market_chart
        // (same path as commodity tokens — market_cap from CG is accurate for USD stablecoins too)
        if (meta.detailProvider === "coingecko" || meta.detailProvider === "commodity") {
          if (meta.geckoId) {
            try {
              const result = await backfillCommodity(db, meta.id, {
                geckoId: meta.geckoId,
                protocolSlug: meta.protocolSlug ?? undefined,
                cgApiKey,
                contracts: meta.contracts,
                chainRpcs,
              });
              if (result.error) {
                errors.push(`${meta.symbol}: ${result.error}`);
              } else {
                totalRows += result.rows;
              }
            } catch (err) {
              errors.push(`${meta.symbol}: CoinGecko backfill failed — ${err}`);
            }
          } else {
            skipped.push(meta.symbol);
          }
          continue;
        }

        // Determine if this coin needs native→USD conversion
        const isUsd = meta.flags.pegCurrency === "USD";
        const needsConversion = !isUsd;
        const geckoId = meta.geckoId ?? PSI_ELIGIBLE_META_BY_ID.get(meta.id)?.geckoId;
        const dlId = meta.llamaId ?? meta.id;

        let detail: StablecoinDetail | null = null;
        let historicalPrices: { timestamp: number; price: number }[] = [];
        try {
          const [detailRes, priceSeries] = await Promise.all([
            fetchWithRetry(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`, {
              headers: { "User-Agent": USER_AGENT },
            }),
            geckoId
              ? fetchMarketBackfillPriceSeries(meta, geckoId, {
                granularity: "daily",
                coingeckoApiKey: cgApiKey ?? null,
              })
              : Promise.resolve(null),
          ]);
          if (!detailRes?.ok) {
            errors.push(`${meta.symbol}: DL returned ${detailRes?.status ?? "no response"}`);
            continue;
          }
          detail = (await detailRes.json()) as StablecoinDetail;

          historicalPrices = priceSeries?.prices ?? [];
        } catch (err) {
          errors.push(`${meta.symbol}: fetch failed — ${err}`);
          continue;
        }

        const tokens = detail?.tokens;
        if (!tokens || tokens.length === 0) {
          skipped.push(meta.symbol);
          continue;
        }

        // For non-USD coins: require historical price data by default.
        // Optional emergency fallback can use current price for only a short recent window.
        const hasHistoricalPrices = historicalPrices.length > 0;
        const fallbackPrice = needsConversion && detail?.price ? detail.price : null;
        if (needsConversion && !hasHistoricalPrices) {
          if (!allowConstantPriceFallback) {
            errors.push(
              `${meta.symbol}: non-USD coin missing historical prices (set allow-constant-price-fallback=true for emergency short-window fallback)`,
            );
            continue;
          }
          if (!fallbackPrice) {
            errors.push(`${meta.symbol}: non-USD coin missing historical prices and fallback price`);
            continue;
          }
          const reason = !geckoId ? "no geckoId" : "price API returned no data";
          console.warn(
            `[backfill] ${meta.symbol}: ${reason}, using emergency constant fallback price $${fallbackPrice} for recent window only`,
          );
        }

        const priceBySnapshotDate = new Map<number, number>();
        for (const point of historicalPrices) {
          const snapshotDate = Math.floor(point.timestamp / DAY_SECONDS) * DAY_SECONDS;
          priceBySnapshotDate.set(snapshotDate, point.price);
        }

        function findHistoricalPrice(snapshotDate: number): number | null {
          return priceBySnapshotDate.get(snapshotDate) ?? null;
        }

        const stmts: D1PreparedStatement[] = [];

        const fallbackWindowStart = Math.floor(Date.now() / 1000) - 7 * DAY_SECONDS;
        for (const entry of tokens) {
          const circ = entry.circulating;
          if (!circ) continue;

          // Sum across all peg buckets (native currency for non-USD, USD for USD coins)
          const rawSum = Object.values(circ).reduce((sum, v) => sum + (v ?? 0), 0);
          if (rawSum <= 0) continue;

          // Floor to UTC midnight
          const snapshotDate = Math.floor(entry.date / DAY_SECONDS) * DAY_SECONDS;
          let marketCapUsd: number;
          let price = findHistoricalPrice(snapshotDate);

          if (needsConversion) {
            // Non-USD: multiply native supply by USD price to get market cap
            if (price == null && allowConstantPriceFallback && fallbackPrice && entry.date >= fallbackWindowStart) {
              price = fallbackPrice;
            }
            if (!price || price <= 0) continue;
            marketCapUsd = rawSum * price;
          } else {
            // USD: rawSum is already in USD
            marketCapUsd = rawSum;
          }

          stmts.push(
            db
              .prepare(
                "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
              )
              .bind(meta.id, snapshotDate, marketCapUsd, price),
          );
        }

        if (stmts.length > 0) {
          await batchExecute(db, stmts);
          totalRows += stmts.length;
        }
      }

      return jsonResponse(buildAdminJobSummary({
        coinsProcessed: coins.length,
        rowsInserted: totalRows,
        skipped,
        errors,
      }));
    },
  );
}
