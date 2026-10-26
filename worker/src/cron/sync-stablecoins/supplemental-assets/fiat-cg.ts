import { logWorkerEvent, logWorkerEventArgs } from "../../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getOnchainSupplyHoldReason, selectCuratedAggregateOnchainSupplyProbeContracts, selectSupplementalOnchainSupplyProbeContract } from "@shared/lib/onchain-supply-probe";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { ONCHAIN_PARTITION_DIVERGENCE_DETAIL_LIMIT, type OnchainPartitionSummary } from "@shared/types/status/cron";
import { throwIfAborted } from "../../../lib/abort";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../../lib/dwellir-native";
import { mapWithConcurrency } from "../../../lib/concurrency";
import type { PeggedAsset } from "../enrich-prices";
import { buildZephyrProtocolPeggedAsset, fetchZephyrProtocolStats, isZephyrScannerAssetId } from "../zephyr-zsd";
import { resolveVaultNavSupplyPrice } from "../../../lib/authoritative-price-sources";
import { loadReserveNavSupplyPrice, reserveNavSupplyScopeReason } from "../../../lib/reserve-nav-price";
import { restoreCuratedAggregateChainPartition, reviewedOnchainSupplyHoldFields } from "../shared";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap, fetchOnChainSupplyPartition, fetchPinnedNativeShares, prefersOnChainSupplyMcap, toPublicChainCirculating } from "./onchain-supply";
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
// Below the existing 25s refresh passes; bounds added work to the campaign's 20s wall-time allowance.
export const ONCHAIN_PARTITION_STAGE_BUDGET_MS = 20_000;
export const ONCHAIN_PARTITION_ROTATION_RUNS = 4;

export async function fetchFiatCoinGeckoTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
  db?: D1Database,
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>,
  dwellirNative?: DwellirNativeCapability,
  reportPartitionSummary?: (summary: OnchainPartitionSummary) => void,
): Promise<PeggedAsset[]> {
  throwIfAborted(signal);
  const summary: OnchainPartitionSummary = {
    candidates: 0, entered: 0, retained: 0, carried: 0, divergent: 0, unreadable: 0,
    deadlineSkipped: 0, carryExpired: 0, divergences: [], divergencesTruncated: 0,
  };
  if (FIAT_CG_METAS.length === 0) {
    reportPartitionSummary?.(summary);
    return [];
  }
  const runNowSec = Math.floor(Date.now() / 1000);
  let partitionStage: { timeout: ReturnType<typeof createTimeoutSignal>; deadlineAtMs: number } | undefined;
  let partitionCandidateCount = 0;
  let partitionStartOffset = 0;
  let deadlineSkippedCount = 0;
  // Added attribution must not spend the capped Dwellir budget; replacement reads keep their existing routes.
  const partitionChainRpcs = chainRpcs && new Map([...chainRpcs].map(([id, config]) => [id, {
    ...config, endpoints: config.endpoints.filter((endpoint) => endpoint.operator !== "dwellir"),
  }]));

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

    const partitionCandidates = FIAT_CG_METAS.filter((meta) => mcapMap[meta.id] != null
      && !prefersOnChainSupplyMcap(meta) && meta.liveReservesConfig?.adapter !== "jpmorgan-nav"
      && (selectCuratedAggregateOnchainSupplyProbeContracts(meta) || selectSupplementalOnchainSupplyProbeContract(meta)));
    partitionCandidateCount = partitionCandidates.length;
    summary.candidates = partitionCandidateCount;
    const partitionStride = Math.ceil(partitionCandidateCount / ONCHAIN_PARTITION_ROTATION_RUNS);
    partitionStartOffset = partitionCandidateCount === 0 ? 0
      : (Math.floor(runNowSec / CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec) * partitionStride) % partitionCandidateCount;
    const carriableIds = new Set(partitionCandidates.filter((meta) => {
      const previous = previousAssetsById?.get(meta.id);
      if (!previous) return false;
      const restored = restoreCuratedAggregateChainPartition({
        ...previous, circulating: { [pegTypeKey(meta)]: mcapMap[meta.id] }, chainCirculating: {},
      }, previous, runNowSec, true);
      return restored != null && !restored.expired;
    }).map((meta) => meta.id));
    const rotatedCandidates = partitionCandidates.slice(partitionStartOffset).concat(partitionCandidates.slice(0, partitionStartOffset));
    // Keep the leading window intact: global uncarried-first sorting could starve carried candidates.
    const orderedCandidates = [rotatedCandidates.slice(0, partitionStride), rotatedCandidates.slice(partitionStride)]
      .flatMap((window) => window.sort((a, b) => Number(carriableIds.has(a.id)) - Number(carriableIds.has(b.id))));
    const partitionCandidateIds = new Set(partitionCandidates.map((meta) => meta.id));
    let nextPartitionIndex = 0;
    // Rotate only candidate slots; other supply paths keep their order and published rows retain catalog order.
    const processingMetas = FIAT_CG_METAS.map((meta) => partitionCandidateIds.has(meta.id)
      ? orderedCandidates[nextPartitionIndex++] : meta);

    const results = await mapWithConcurrency(
      processingMetas,
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
        const attachPartition = !needsClassScope && !preferOnChainMcap && !!mcap;
        let supplySource: string = "coingecko-fallback";
        let supplyObservedAt = mcap && meta.geckoId ? cgData[meta.geckoId]?.last_updated_at ?? null : null;
        let chainCirculating: PeggedAsset["chainCirculating"] = {};
        let supplyPerimeter: PeggedAsset["supplyPerimeter"];

        // Fallback: on-chain totalSupply × market/peg-reference price when CG has no market cap.
        // This keeps preview-only plain-par fiat assets in supply coverage without inventing a live market quote.
        if (!needsClassScope && (preferOnChainMcap || !mcap) && priceForSupply != null) {
          const aggregateOnChainMcap = await fetchCuratedAggregateOnChainMcap(meta, priceForSupply, chainRpcs, signal, dwellirNative);
          if (aggregateOnChainMcap) {
            mcap = aggregateOnChainMcap.mcap;
            supplySource = aggregateOnChainMcap.supplySource;
            supplyObservedAt = aggregateOnChainMcap.observedAt ?? null;
            chainCirculating = toPublicChainCirculating(aggregateOnChainMcap.chainCirculating);
            supplyPerimeter = aggregateOnChainMcap.supplyPerimeter;
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
        if (getOnchainSupplyHoldReason(meta.id) && !supplyPerimeter) {
          const hold = reviewedOnchainSupplyHoldFields({ id: meta.id }, nowSec)!;
          logWorkerEvent({
            scope: "handler", job: "sync-stablecoins", level: "warn", event: "supplemental-supply-withheld",
            message: `[fiat-cg] ${meta.symbol} current token-stock perimeter unavailable`,
            metadata: { stablecoinId: meta.id, reason: hold.supplyUnavailableReason, rule: "R4" },
          });
          return {
            ...buildSupplementalAsset({ meta, priceResolution, nowSec, mcap: null, supplySource: "onchain-supply-withheld" }),
            ...hold,
          };
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

        if (priceForSupply == null && !mcap) {
          logWorkerEvent({
            scope: "handler", level: "warn", job: "sync-stablecoins",
            event: "supplemental-supply-withheld",
            message: `[fiat-cg] ${meta.symbol} has no admitted supply valuation`,
            metadata: { stablecoinId: meta.id, reason: navLikeAsset ? "nav-price-unavailable" : "supply-price-unavailable", rule: "R4" },
          });
          return null;
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
        const asset = buildSupplementalAsset({
          meta,
          priceResolution,
          priceConfidence,
          nowSec,
          mcap,
          supplySource,
          supplyObservedAt,
          supplyPerimeter,
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating,
        });
        if (!attachPartition || !partitionCandidateIds.has(meta.id)) return asset;
        const diagnose = (reason: string, ratio: number | null = null) => {
          if (reason === "ratio-out-of-band") {
            summary.divergent++;
            if (ratio != null && summary.divergences.length < ONCHAIN_PARTITION_DIVERGENCE_DETAIL_LIMIT) {
              summary.divergences.push({ id: meta.id, ratio });
            }
          } else if (reason === "deadline-exhausted") summary.deadlineSkipped++;
          else summary.unreadable++;
          logWorkerEvent({
            scope: "handler", level: "warn", job: "sync-stablecoins", event: "onchain-partition-divergence",
            message: `[fiat-cg] ${meta.symbol} on-chain partition unavailable`,
            metadata: { stablecoinId: meta.id, reason, ratio },
          });
        };
        const carryPartition = () => {
          const restored = restoreCuratedAggregateChainPartition(
            asset, previousAssetsById?.get(meta.id), Math.floor(Date.now() / 1000), true,
          );
          if (restored?.expired) summary.carryExpired++;
          else if (restored?.asset.chainPartition?.admission === "carried") summary.carried++;
          return restored?.asset ?? asset;
        };
        if (priceForSupply == null) {
          diagnose(navLikeAsset ? "nav-price-unavailable" : "supply-price-unavailable");
          return asset;
        }
        if (!partitionStage) {
          partitionStage = {
            timeout: createTimeoutSignal({ timeoutMs: ONCHAIN_PARTITION_STAGE_BUDGET_MS,
              timeoutReason: new DOMException("On-chain partition stage deadline", "TimeoutError"), parentSignal: signal }),
            deadlineAtMs: Date.now() + ONCHAIN_PARTITION_STAGE_BUDGET_MS,
          };
        }
        if (Date.now() >= partitionStage.deadlineAtMs || partitionStage.timeout.signal.aborted) {
          throwIfAborted(signal);
          deadlineSkippedCount++;
          diagnose("deadline-exhausted");
          return carryPartition();
        }
        try {
          const partition = await fetchOnChainSupplyPartition(meta, mcap, priceForSupply, previousAssetsById?.get(meta.id), partitionChainRpcs, partitionStage.timeout.signal);
          throwIfAborted(signal);
          if ("reason" in partition && partition.reason !== "legs-unreadable") {
            diagnose(partition.reason, partition.ratio);
            return asset;
          }
          if (Date.now() >= partitionStage.deadlineAtMs || partitionStage.timeout.signal.aborted) {
            diagnose("deadline-exhausted");
            return carryPartition();
          }
          if (!("reason" in partition)) {
            if (partition.chainPartition?.admission === "entered") summary.entered++;
            else if (partition.chainPartition?.admission === "retained") summary.retained++;
            return { ...asset, ...partition };
          }
          diagnose(partition.reason, partition.ratio);
          return carryPartition();
        } catch (error) {
          throwIfAborted(signal);
          diagnose(partitionStage.timeout.signal.aborted ? "deadline-exhausted" : "partition-invalid");
          if (!partitionStage.timeout.signal.aborted) logWorkerEventArgs("handler", "warn", "[fiat-cg] Partition read failed:", error);
          return partitionStage.timeout.signal.aborted ? carryPartition() : asset;
        }
      },
      { signal },
    );

    const assetsById = new Map(results.filter((token): token is PeggedAsset => token !== null)
      .map((token) => [String(token.id), token]));
    summary.divergencesTruncated = summary.divergent - summary.divergences.length;
    reportPartitionSummary?.(summary);
    return FIAT_CG_METAS.flatMap((meta) => {
      const asset = assetsById.get(meta.id);
      return asset ? [asset] : [];
    });
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  } finally {
    if (deadlineSkippedCount > 0 || partitionStage?.timeout.isTimedOut()) logWorkerEvent({
      scope: "handler", level: "warn", job: "sync-stablecoins", event: "onchain-partition-divergence",
      message: "[fiat-cg] On-chain partition stage deadline exhausted",
      metadata: { reason: "deadline-exhausted", deadlineSkippedCount, partitionCandidateCount, partitionStartOffset },
    });
    partitionStage?.timeout.dispose();
  }
}
