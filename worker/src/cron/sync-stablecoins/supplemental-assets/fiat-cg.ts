import { logWorkerEvent, logWorkerEventArgs } from "../../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../../lib/abort";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../../lib/dwellir-native";
import { mapWithConcurrency } from "../../../lib/concurrency";
import type { PeggedAsset } from "../enrich-prices";
import { buildZephyrProtocolPeggedAsset, fetchZephyrProtocolStats, isZephyrScannerAssetId } from "../zephyr-zsd";
import { resolveVaultNavSupplyPrice } from "../../../lib/authoritative-price-sources";
import { loadReserveNavSupplyPrice, reserveNavSupplyScopeReason } from "../../../lib/reserve-nav-price";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap, fetchPinnedNativeShares, prefersOnChainSupplyMcap, toPublicChainCirculating } from "./onchain-supply";
import {
  fetchSupplementalPriceData,
  buildSupplementalAsset,
  pegTypeKey,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalContractPrice,
  resolveSupplementalCoinGeckoMcap,
  resolveSupplementalPrice,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
} from "./shared";

export const FIAT_CG_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");
const FIAT_CG_TOKEN_CONCURRENCY = 2;

export async function fetchFiatCoinGeckoTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
  db?: D1Database,
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>,
  dwellirNative?: DwellirNativeCapability,
): Promise<PeggedAsset[]> {
  if (FIAT_CG_METAS.length === 0) return [];
  throwIfAborted(signal);

  try {
    const hasZephyrScannerAsset = FIAT_CG_METAS.some((meta) => isZephyrScannerAssetId(meta.id));
    const [priceData, zephyrProtocolStats] = await Promise.all([
      fetchSupplementalPriceData(FIAT_CG_METAS, "fiat-cg", signal, db),
      hasZephyrScannerAsset ? fetchZephyrProtocolStats(signal) : Promise.resolve(null),
    ]);

    const mcapMap: Record<string, number> = {};
    for (const token of FIAT_CG_METAS) {
      const mcap = resolveSupplementalCoinGeckoMcap(cgData, token.geckoId);
      if (mcap != null) mcapMap[token.id] = mcap;
    }

    const results = await mapWithConcurrency(
      FIAT_CG_METAS,
      FIAT_CG_TOKEN_CONCURRENCY,
      async (meta) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const pKey = pegTypeKey(meta);
        // Strict path first (15-min freshness gate). If that rejects but CG returned
        // a valid price, fall back to the relaxed `coingecko-low-volume` lane so
        // CG-only stablecoins with slow upstream tickers don't surface as
        // `priceSource: missing`. Diagnosis pattern: detailProvider="coingecko"
        // with llamaId=null + low volume → upstream last_updated_at exceeds 15min.
        let priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
        if (!priceResolution) {
          priceResolution = resolveSupplementalContractPrice(priceData, meta, fxFallbackRates);
        }
        if (!priceResolution) {
          priceResolution = resolveLowVolumeCoinGeckoPrice(cgData, meta.geckoId);
        }
        const pegReferencePrice = toPositiveFiniteNumber(fxFallbackRates?.[pKey]);
        // USD is the base currency; fxFallbackRates omits peggedUSD. Default to 1.0 for
        // plain USD-pegged coins with no CG/DL price source so the on-chain fallback can compute mcap.
        // NAV/yield-bearing assets need an observed market price; do not par-value them or use an FX reference.
        const navLikeAsset = meta.flags.navToken || meta.flags.yieldBearing;
        const usdPegDefault = !navLikeAsset && meta.flags.pegCurrency === "USD" ? 1.0 : undefined;
        // NAV assets that lost every market price source (e.g. a CoinGecko
        // delisting) fall back to the authoritative protocol-redeem NAV route
        // for supply valuation only; the published price stays with the live
        // override stage. Fail-closed: no trusted NAV -> the coin stays out.
        let navSupplyPrice: number | undefined;
        const requiresClassScope = meta.liveReservesConfig?.adapter === "jpmorgan-nav";
        const reserveNav = navLikeAsset && (!priceResolution || requiresClassScope)
          ? await loadReserveNavSupplyPrice(meta, db, nowSec) : null;
        if (navLikeAsset && !priceResolution) {
          const navUsdRate = meta.flags.pegCurrency === "USD" ? 1 : pegReferencePrice;
          if (reserveNav && navUsdRate != null) navSupplyPrice = reserveNav.price * navUsdRate;
        }
        if (navLikeAsset && !priceResolution && navSupplyPrice == null && previousAssetsById) {
          const navOverride = await resolveVaultNavSupplyPrice(meta.id, previousAssetsById, db, signal, chainRpcs);
          if (navOverride) {
            navSupplyPrice = navOverride.price;
            logWorkerEventArgs(
              "handler",
              "info",
              `[fiat-cg] ${meta.symbol} supply valued from ${navOverride.source} NAV fallback (no market price source)`,
            );
          }
        }
        const priceForSupply = navLikeAsset
          ? priceResolution?.price ?? navSupplyPrice
          : priceResolution?.price ?? pegReferencePrice ?? usdPegDefault;

        if (isZephyrScannerAssetId(meta.id)) {
          if (!zephyrProtocolStats) {
            logWorkerEventArgs("handler", "info", `[fiat-cg] No Zephyr scanner supply for ${meta.symbol}, skipping`);
            return null;
          }
          return buildZephyrProtocolPeggedAsset(meta, zephyrProtocolStats, priceResolution, nowSec);
        }

        const preferOnChainMcap = prefersOnChainSupplyMcap(meta);
        let mcap = preferOnChainMcap ? undefined : mcapMap[meta.id];
        const needsClassScope = requiresClassScope;
        let supplySource: string = "coingecko-fallback";
        let supplyObservedAt = mcap && meta.geckoId ? cgData[meta.geckoId]?.last_updated_at ?? null : null;
        let chainCirculating: PeggedAsset["chainCirculating"] = {};

        // Fallback: on-chain totalSupply × market/peg-reference price when CG has no market cap.
        // This keeps preview-only plain-par fiat assets in supply coverage without inventing a live market quote.
        if (!needsClassScope && (preferOnChainMcap || !mcap) && priceForSupply != null) {
          const aggregateOnChainMcap = await fetchCuratedAggregateOnChainMcap(meta, priceForSupply, chainRpcs, signal, dwellirNative);
          if (aggregateOnChainMcap) {
            mcap = aggregateOnChainMcap.mcap;
            supplySource = aggregateOnChainMcap.supplySource;
            supplyObservedAt = aggregateOnChainMcap.observedAt ?? null;
            chainCirculating = toPublicChainCirculating(aggregateOnChainMcap.chainCirculating);
          }
        }

        if (!needsClassScope && !mcap && priceForSupply != null) {
          const onChainMcap = await fetchOnChainMcap(meta, priceForSupply, chainRpcs, signal, dwellirNative);
          if (onChainMcap) {
            mcap = onChainMcap.mcap;
            supplySource = onChainMcap.supplySource;
            supplyObservedAt = onChainMcap.observedAt ?? null;
            chainCirculating = toPublicChainCirculating(onChainMcap.chainCirculating);
          }
        }

        if (needsClassScope) {
          const nativeShares = await fetchPinnedNativeShares(meta, chainRpcs, signal);
          const reason = reserveNavSupplyScopeReason(reserveNav, nativeShares, nowSec);
          if (reason) {
            logWorkerEvent({
              scope: "handler", level: "warn", event: "reserve-nav-supply-withheld",
              message: `[fiat-cg] ${meta.symbol} on-chain supply scope unproven`,
              metadata: {
                stablecoinId: meta.id, reason, rule: "R4", nativeShares,
                classAssetsUsd: reserveNav?.metadata?.classAssetsUsd ?? null,
                sourceObservedAt: reserveNav?.observedAt ?? null,
                reserveFetchedAt: reserveNav?.metadata?.reserveFetchedAt ?? null,
              },
            });
            return null;
          }
          // Admission uses the getter quantity at issuer NAV; display valuation
          // may then use the observed market quote. A positive CG cap is ignored.
          if (!nativeShares || priceForSupply == null) return null;
          const nativeSupply = Number(BigInt(nativeShares.rawShares)) / 10 ** nativeShares.decimals;
          mcap = nativeSupply * priceForSupply;
          if (!Number.isFinite(mcap) || mcap <= 0) return null;
          supplySource = "onchain-total-supply";
          supplyObservedAt = nativeShares.observedAt;
          chainCirculating = { Ethereum: { chainId: nativeShares.chain, current: mcap } };
        }

        if (!mcap) {
          logWorkerEventArgs("handler", "info", `[fiat-cg] No mcap for ${meta.symbol}, skipping`);
          return null;
        }

        const priceConfidence: PeggedAsset["priceConfidence"] = priceResolution
          ? priceResolution.source === "coingecko-low-volume"
            ? "fallback"
            : "single-source"
          : null;
        return buildSupplementalAsset({
          meta,
          priceResolution,
          priceConfidence,
          nowSec,
          mcap,
          supplySource,
          supplyObservedAt,
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating,
        });
      },
      { signal },
    );

    return results.filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  }
}
