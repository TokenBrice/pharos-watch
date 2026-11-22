import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter, isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { CURATED_AGGREGATE_ESCROW_RESIDUALS, isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { LEGACY_SOLOMON_USDV_ID } from "../../lib/solomon-usdv-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { admitSupplyBuckets, getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull, getPrevMonthRawOrNull, hasDatedUsdValuation, matchesSupplySnapshotDay, type SupplyBucketInvalidReason, type SupplyChangeBaselines } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { CHAIN_CIRCULATING_KEYS, canonicalizeChainCirculating, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { CHAIN_META } from "@shared/types/chain-identity";
import { isRecord } from "@shared/lib/type-guards";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { getCompletedSupplySnapshot } from "../../lib/supply-snapshot-completion";
import { historicalSupplyQuantity, type HistoricalSupplyQuantityRow } from "../../lib/supply-history-db";
import { throwIfAborted } from "../../lib/abort";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildSupplyObservationProvenance, classifySupplyAmountCoverage, classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import type { SupplyChainGuardProvenance } from "@shared/types/supply";
import type { PeggedAsset } from "./enrich-prices";
import { CHAIN_DROPOUT_POLICY } from "./chain-dropout-guard";
import { pendingCarriedSupplyBaselines, producerSupplyBaselines } from "./enrich-prices-shared";
import { isSupplyObservationWithinRestoreCeiling, reviewedOnchainSupplyHoldFields, type PreviousStablecoinsCacheState } from "./shared";
import { TRACKED_ASSET_ADDRESS_OVERRIDES } from "./tracked-asset-overrides";

/**
 * Why one upstream row was quarantined at intake (DEC-03: per-asset quarantine, never a whole-list hold).
 * `circulating-absent` = no current aggregate bucket observed (`{}`/missing), distinct from an observed zero.
 */
export type IntakeQuarantineReason =
  | "row-not-object"
  | "id-missing"
  | "name-or-symbol-invalid"
  | "circulating-absent"
  | `circulating-${SupplyBucketInvalidReason}`;

export interface IntakeQuarantinedRow {
  index: number;
  id: string | null;
  reason: IntakeQuarantineReason;
}

export interface StructuralValidationResult {
  validAssets: PeggedAsset[];
  droppedMalformedAssets: number;
  quarantined: IntakeQuarantinedRow[];
  /** Asset ids whose invalid historical aggregate buckets were dropped to absence (asset kept). */
  invalidHistoryIds: string[];
}

export interface RowAdmissionResult {
  rows: PeggedAsset[];
  quarantined: IntakeQuarantinedRow[];
}

export interface CanonicalDeduplicationResult {
  dedupedAssets: PeggedAsset[];
  duplicateRows: number;
  affectedIds: string[];
}

export interface PriceStalenessSummary {
  compared: number;
  identical: number;
  stale: boolean;
}

export type PriceStalenessCheckResult =
  | { state: "ok"; summary: PriceStalenessSummary }
  | { state: "missing-previous-cache" }
  | { state: "check-failed"; reason: string };

function countFiniteBuckets(buckets: Record<string, number> | undefined): number {
  if (!buckets) return 0;
  return Object.values(buckets).filter((value) => typeof value === "number" && Number.isFinite(value)).length;
}

function countChainEntries(chainCirculating: unknown): number {
  if (!chainCirculating || typeof chainCirculating !== "object") return 0;
  return Object.keys(chainCirculating as Record<string, unknown>).length;
}

function buildQualityVector(asset: PeggedAsset): number[] {
  return [
    getCirculatingRawOrNull(asset) ?? -1, // unavailable ranks below observed zero, not as a measured zero
    countChainEntries(asset.chainCirculating),
    Array.isArray(asset.chains) ? asset.chains.length : 0,
    countFiniteBuckets(asset.circulatingPrevDay ?? undefined) +
      countFiniteBuckets(asset.circulatingPrevWeek ?? undefined) +
      countFiniteBuckets(asset.circulatingPrevMonth ?? undefined),
    asset.price != null && typeof asset.price === "number" && asset.price > 0 ? 1 : 0,
    typeof asset.priceUpdatedAt === "number" && Number.isFinite(asset.priceUpdatedAt) ? asset.priceUpdatedAt : 0,
    asset.geckoId ? 1 : 0,
    asset.cmcSlug ? 1 : 0,
    asset.address ? 1 : 0,
  ];
}

function compareCanonicalAssetQuality(left: PeggedAsset, right: PeggedAsset): number {
  const leftVector = buildQualityVector(left);
  const rightVector = buildQualityVector(right);

  for (let index = 0; index < leftVector.length; index += 1) {
    if (leftVector[index] === rightVector[index]) continue;
    return leftVector[index] - rightVector[index];
  }

  return 0;
}

function readRowId(row: Record<string, unknown>): string | null {
  const id = row.id;
  return (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isFinite(id)) ? String(id) : null;
}

/**
 * Admit only non-null object rows from an untrusted provider list, before any transform (frozen merge,
 * aliasing, structural field access) dereferences them. Null, primitive and array rows are quarantined with
 * their index so one malformed row cannot crash the run or stall every valid peer (D01-5, R8).
 */
export function admitPeggedAssetRows(rows: readonly unknown[]): RowAdmissionResult {
  const admitted: PeggedAsset[] = [];
  const quarantined: IntakeQuarantinedRow[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      quarantined.push({ index, id: null, reason: "row-not-object" });
      return;
    }
    // Structural fields are checked by filterStructurallyValidAssets; this boundary only proves object shape.
    const assetRow: PeggedAsset = row as unknown as PeggedAsset;
    admitted.push(assetRow);
  });
  return { rows: admitted, quarantined };
}

const HISTORY_BUCKET_KEYS = ["circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const;

/**
 * Per-asset structural and supply admission. Rows need an id, string name/symbol and an observed current
 * aggregate supply whose buckets are finite and nonnegative (an explicit zero is observed supply; `{}` is
 * absence). Invalid historical buckets are dropped to absence rather than quarantining the asset.
 */
export function filterStructurallyValidAssets(assets: readonly unknown[]): StructuralValidationResult {
  const validAssets: PeggedAsset[] = [];
  const quarantined: IntakeQuarantinedRow[] = [];
  const invalidHistoryIds: string[] = [];
  assets.forEach((asset, index) => {
    if (!isRecord(asset)) {
      quarantined.push({ index, id: null, reason: "row-not-object" });
      return;
    }
    const id = readRowId(asset);
    if (id == null) {
      quarantined.push({ index, id: null, reason: "id-missing" });
      return;
    }
    if (typeof asset.name !== "string" || typeof asset.symbol !== "string") {
      quarantined.push({ index, id, reason: "name-or-symbol-invalid" });
      return;
    }
    const current = admitSupplyBuckets(asset.circulating);
    if (current.status !== "observed") {
      quarantined.push({
        index,
        id,
        reason: current.status === "absent" ? "circulating-absent" : `circulating-${current.reason}`,
      });
      return;
    }
    let historyDropped = false;
    for (const key of HISTORY_BUCKET_KEYS) {
      if (admitSupplyBuckets(asset[key]).status !== "invalid") continue;
      asset[key] = null;
      historyDropped = true;
    }
    if (historyDropped) invalidHistoryIds.push(id);
    // Every structural and supply field read above was checked on this row.
    const validAsset: PeggedAsset = asset as unknown as PeggedAsset;
    validAssets.push(validAsset);
  });
  return {
    validAssets,
    droppedMalformedAssets: quarantined.length,
    quarantined,
    invalidHistoryIds,
  };
}

/**
 * Collapse provider chain peg-bucket records to scalar totals for all four chain keys. An absent/empty or
 * invalid bucket becomes `null` (unavailable) instead of `0`, so an empty `circulatingPrevDay` cannot
 * manufacture a mint and an empty `current` cannot manufacture a redemption; an observed zero stays `0`.
 * A chain row without any `current` key keeps the row (the chain is known) with `current: null`.
 */
export function normalizeChainCirculating(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const chainCirculating = asset.chainCirculating;
    if (!isRecord(chainCirculating)) continue;

    for (const chain of Object.keys(chainCirculating)) {
      const entry = chainCirculating[chain];
      if (!isRecord(entry)) continue;

      for (const key of CHAIN_CIRCULATING_KEYS) {
        if (key !== "current" && entry[key] === undefined) continue;
        entry[key] = normalizeChainSupplyValue(entry[key]);
      }
    }
  }
}

export function applyTrackedAssetOverrides(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));

    if (asset.id === LEGACY_SOLOMON_USDV_ID) {
      // `usdv-solomon` froze on 2026-10-29: `meta` is active-only, so read the curated
      // name from the tracked catalog and keep the archived row's identity.
      asset.name = TRACKED_META_BY_ID.get(String(asset.id))?.name ?? asset.name;
      delete asset.geckoId;
      delete asset.gecko_id;
      asset.price = null; // On-chain supplemental supply since 2026-09-27 (no llamaId); every DefiLlama price lane — list row 261 and the supplemental solana:Ex5Da… contract quote — aliases the replacement mint, so the price must come from an identity-safe source (jupiter-exact).
    } else if (meta?.geckoId) {
      asset.geckoId = meta.geckoId;
    }
    if (meta?.cmcSlug) {
      asset.cmcSlug = meta.cmcSlug;
    }
    if (meta) {
      asset.navToken = meta.flags.navToken === true;
    }
    if (!asset.address && TRACKED_ASSET_ADDRESS_OVERRIDES[asset.id]) {
      asset.address = TRACKED_ASSET_ADDRESS_OVERRIDES[asset.id];
    }
    // Contracts come from the complete curated catalog. ACTIVE_META_BY_ID alone
    // would skip frozen rows injected by mergeFrozenSnapshots.
    const trackedMeta = meta ?? TRACKED_META_BY_ID.get(String(asset.id));
    if (trackedMeta?.contracts && trackedMeta.contracts.length > 0) {
      asset.contracts = trackedMeta.contracts;
    }
  }
}

export function dedupeCanonicalAssets(assets: PeggedAsset[]): CanonicalDeduplicationResult {
  const deduped = new Map<string, PeggedAsset>();
  const affectedIds = new Set<string>();
  let duplicateRows = 0;

  for (const asset of assets) {
    const id = String(asset.id);
    const existing = deduped.get(id);
    if (!existing) {
      deduped.set(id, asset);
      continue;
    }

    duplicateRows += 1;
    affectedIds.add(id);
    if (compareCanonicalAssetQuality(asset, existing) > 0) {
      deduped.set(id, asset);
    }
  }

  return {
    dedupedAssets: [...deduped.values()],
    duplicateRows,
    affectedIds: [...affectedIds],
  };
}

interface SupplyHistoryRow extends HistoricalSupplyQuantityRow {
  stablecoin_id: string;
  supply_provenance: string | null;
}

const SUPPLY_BASELINE_TOLERANCE_SEC = 2 * 60 * 60;
const MAX_LEGACY_BASELINE_RELATIVE_CHANGE = 0.30;
const SUPPLY_WINDOWS = [
  ["day", 1, "circulatingPrevDay", getPrevDayRawOrNull],
  ["week", 7, "circulatingPrevWeek", getPrevWeekRawOrNull],
  ["month", 30, "circulatingPrevMonth", getPrevMonthRawOrNull],
] as const;

/**
 * Pricing v6.90 matched comparison perimeter. A guarded chain gap below the materiality bound that the provider
 * reads as zero or omits adds nothing to the published amount, so each window's provider aggregate minus those
 * chains' own buckets from the same packet is the prior supply of exactly the chains the amount counts. Returns
 * the windows rewritten this way; an unobserved or inconsistent bucket withholds its window (never clamped).
 */
function matchComparisonPerimeter(
  asset: PeggedAsset,
  admits: (window: keyof SupplyChangeBaselines) => boolean,
): Array<keyof SupplyChangeBaselines> {
  const guard = asset.supplyChainGuard;
  const [peg, ...otherPegs] = Object.keys(asset.circulating ?? {});
  if (!guard || guard.status !== "chains-unavailable" || guard.partialCoverage || !peg || otherPegs.length > 0 ||
    asset.pegType !== "peggedUSD" || asset.supplySource !== "defillama" ||
    guard.chains.some((chain) => chain.resolution !== "unavailable" || (chain.listCurrentUsd ?? 0) !== 0)) return [];
  const rows = guard.chains.map((chain) => guardChainRows(asset, chain));
  if (rows.some((chainRows) => chainRows.length === 0)) return [];
  const matched: Array<keyof SupplyChangeBaselines> = [];
  for (const [window, , field, readLegacy] of SUPPLY_WINDOWS) {
    if (!admits(window)) continue;
    const aggregate = readLegacy(asset);
    const excluded = rows.flat().map((row) => normalizeChainSupplyValue(row[field]));
    if (aggregate == null || Object.keys(asset[field] ?? {}).some((key) => key !== peg) || excluded.includes(null)) continue;
    const prior = aggregate - excluded.reduce<number>((sum, value) => sum + value!, 0);
    if (!(prior > 0)) continue;
    asset[field] = { [peg]: prior };
    matched.push(window);
  }
  return matched;
}

type GuardChain = SupplyChainGuardProvenance["chains"][number];

function guardChainRows(asset: PeggedAsset, chain: GuardChain) {
  return Object.entries(asset.chainCirculating ?? {})
    .filter(([label, row]) => chain.chainId == null
      ? label === chain.chainLabel : canonicalizeChainCirculating({ [label]: row }).has(chain.chainId))
    .map(([, row]) => row);
}

/**
 * Pricing v6.90: whether the provider's prior bucket counts a gap stored on its target date. The stored row
 * judged only the provider's current at that time; the comparison crosses the gap only when the packet's own
 * prior row for an unavailable chain is unobserved, or collapsed below its stored baseline while the current
 * row is not (a lower level at both ends is the provider's level, not a gap).
 */
function priorCountsStoredGap(asset: PeggedAsset, gap: GuardChain[] | undefined, field: (typeof SUPPLY_WINDOWS)[number][2]): boolean {
  return gap?.some((chain) => {
    if (chain.resolution !== "unavailable") return false;
    const rows = guardChainRows(asset, chain);
    const bound = CHAIN_DROPOUT_POLICY.collapseRatio * chain.baselineUsd;
    const prior = rows.map((row) => normalizeChainSupplyValue(row[field]));
    const current = rows.map((row) => normalizeChainSupplyValue(row.current));
    const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + value!, 0);
    return rows.length === 0 || prior.includes(null) ||
      (sum(prior) <= bound && (current.includes(null) || sum(current) > bound));
  }) ?? false;
}

function isCorroboratedPublishedConsensusPrice(asset: PeggedAsset): boolean {
  if (!isObservedPrice(asset)) return false;
  if (asset.priceConfidence !== "high") return false;
  if (typeof asset.price !== "number" || !Number.isFinite(asset.price) || asset.price <= 0) return false;
  if (
    typeof asset.priceSource !== "string" ||
    asset.priceSource.length === 0 ||
    asset.priceSource === "cached" ||
    asset.priceSource === "missing"
  ) {
    return false;
  }
  const parts = normalizePricingSourceKeys(asset.priceSource);
  if (parts.length < 2) return false;
  if (parts.every((part) => getPricingSourceRegistryEntry(part)?.isListAggregator === true)) return false;
  return true;
}

/**
 * Pricing v6.91: when DefiLlama list intake rejected a `peggedUSD` quote solely for being
 * exact par (`exact_par_list_price_requires_corroboration`), derive `circulatingNative` after
 * primary consensus resolves a corroborated `high`-confidence multi-source price (not all
 * list aggregators). Stamps `valuationObservedAtSec` only for genuine `upstream` clocks (R6).
 */
export function deriveExactParListNativeQuantities(
  assets: PeggedAsset[],
  exactParUsdListObservations: ReadonlyMap<string, number>,
  nowSec: number,
): number {
  if (exactParUsdListObservations.size === 0) return 0;
  let derivedCount = 0;
  for (const asset of assets) {
    const deferredUsd = exactParUsdListObservations.get(asset.id);
    if (deferredUsd == null) continue;
    if (asset.circulatingNative != null || asset.valuationPriceUsd != null) continue;
    if (asset.pegType !== "peggedUSD") continue;
    if (asset.supplySource != null && asset.supplySource !== "defillama") continue;
    if (asset.frozen || asset.supplyRestored || asset.supplyGapFill || isKinesisWrapperSupplyId(asset.id)) continue;
    const guard = asset.supplyChainGuard;
    if (guard && (guard.status !== "chains-unavailable" || guard.partialCoverage)) continue;
    const currentUsd = getCirculatingRawOrNull(asset);
    if (currentUsd == null || currentUsd !== deferredUsd) continue;
    if (!isCorroboratedPublishedConsensusPrice(asset)) continue;
    const price = asset.price as number;
    const native = deferredUsd / price;
    if (!Number.isFinite(native) || native < 0 ||
      Math.abs(native * price - deferredUsd) > 1e-12 * Math.max(deferredUsd, 1)) {
      continue;
    }
    const priceClock = asset.priceObservedAtMode === "upstream" ? asset.priceObservedAt : null;
    asset.circulatingNative = native;
    asset.valuationPriceUsd = price;
    asset.valuationObservedAtSec = priceClock != null && Number.isSafeInteger(priceClock) &&
      priceClock > 0 && priceClock <= nowSec ? priceClock : null;
    derivedCount++;
  }
  return derivedCount;
}

export async function fillMissingSupplyHistory(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
  syncStartSec?: number,
): Promise<number> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const perimeterAt = syncStartSec ?? now;
  const skylinkLabel = CURATED_AGGREGATE_ESCROW_RESIDUALS["susds-sky"]?.unattributedChainLabel;
  const chartPackets = new Set<PeggedAsset>();
  for (const asset of assets) {
    if (FROZEN_IDS.has(asset.id)) asset.frozen = true;
    if (isKinesisWrapperSupplyId(asset.id)) {
      const wrapper = isKinesisWrapperSupplyCutoverActive(asset.id, perimeterAt);
      if (wrapper !== (asset.supplySource === "onchain-total-supply")) {
        Object.assign(asset, reviewedOnchainSupplyHoldFields({ id: asset.id, supplySource: "onchain-supply-withheld" }));
      } else if (!wrapper) {
        delete asset.circulatingNative;
        delete asset.valuationPriceUsd;
        delete asset.valuationObservedAtSec;
      }
    }
    if (asset.id === "susds-sky" && skylinkLabel && asset.chainCirculating &&
      !Object.prototype.hasOwnProperty.call(asset.chainCirculating, skylinkLabel)) {
      // A pre-cutover cached partition does not distinguish free float from escrow.
      asset.chainCirculating = {};
      delete asset.chainPartition;
    }
    const current = getCirculatingRawOrNull(asset);
    const valuation = asset.circulatingNative != null && asset.valuationPriceUsd != null
      ? asset.circulatingNative * asset.valuationPriceUsd : null;
    if (current == null || (valuation != null && (!Number.isFinite(valuation) ||
      Math.abs(valuation - current) > 1e-12 * Math.max(current, 1)))) {
      delete asset.circulatingNative;
      delete asset.valuationPriceUsd;
      delete asset.valuationObservedAtSec;
    }
    // A prior non-USD token balance at today's price cannot establish a historical USD cap.
    if (asset[pendingCarriedSupplyBaselines]) delete asset.supplyChangeBaselines;
    const chart = asset.supplyChangeBaselines;
    if (chart && (asset.supplySource === "coingecko-gap-fill" || asset.supplySource === "defillama-history-gap-fill")) {
      // These dated USD caps belong to the same chart as the published chain allocation.
      chartPackets.add(asset);
      const clock = asset.supplyObservedAt;
      const comparable = clock != null && Number.isSafeInteger(clock) && clock > 0 && clock <= now && now - clock <= DAY_SECONDS &&
        current != null && !asset.frozen && classifySupplyCoverage(buildSupplyObservationProvenance(asset)) === "complete";
      const baselines: SupplyChangeBaselines = {};
      for (const [window, days, field, readLegacy] of SUPPLY_WINDOWS) {
        const point = chart[window];
        baselines[window] = comparable && point && Number.isSafeInteger(point.observedAt) && point.observedAt > 0 &&
          bucketUnixSecondsToUtcDay(point.observedAt) === bucketUnixSecondsToUtcDay(clock - days * DAY_SECONDS) &&
          isEarlierSupplyPerimeter(asset.id, point.observedAt) === isEarlierSupplyPerimeter(asset.id, clock) &&
          !isAmbiguousSupplyPerimeterDay(asset.id, point.observedAt) && point.circulatingUsd === readLegacy(asset) ? point : null;
        const gap = asset.supplyGapFill;
        if (gap && !baselines[window]) {
          // Only the missing chain's subtraction depends on this chart cap.
          const label = CHAIN_META[gap.missingChainId]?.name ?? gap.missingChainId;
          const remainder = asset.chainCirculating?.[label];
          if (remainder) asset.chainCirculating = { ...asset.chainCirculating, [label]: { ...remainder, [field]: null } };
          const reasons = gap.withheldHistoricalBucketReasons;
          asset.supplyGapFill = {
            ...gap,
            withheldHistoricalBuckets: [...new Set([...(gap.withheldHistoricalBuckets ?? []), window])],
            withheldHistoricalBucketReasons: { ...reasons, [window]: reasons?.[window] ?? "history-unobserved" },
          };
        }
      }
      asset.supplyChangeBaselines = baselines;
    } else if (!asset.supplyRestored && asset.pegType !== "peggedUSD") {
      // A retry must distinguish producer refusals from an earlier D1 verdict.
      if (asset[producerSupplyBaselines] === undefined) {
        Object.defineProperty(asset, producerSupplyBaselines, { value: chart ?? null });
      }
      // Withhold legacy buckets until D1 confirms a comparable close.
      asset.supplyChangeBaselines = {};
    } else if (!asset.supplyRestored) {
      delete asset.supplyChangeBaselines;
      if (chart && asset.supplySource === "defillama") {
        const rejected: SupplyChangeBaselines = {};
        for (const [window] of SUPPLY_WINDOWS) {
          if (chart[window] === null || Object.keys(chart).length === 0) rejected[window] = null;
        }
        if (Object.keys(rejected).length) asset.supplyChangeBaselines = rejected;
      }
    }
    // An assessed stock with no admissible count must survive JSON as explicitly unavailable.
    if (current != null && !asset.supplyRestored && !asset.frozen) {
      if (asset.id === "xaut-tether" && asset.supplySource !== "onchain-circulating-supply") asset.circulatingNative = null;
      else asset.circulatingNative ??= null;
    }
  }
  const today = bucketUnixSecondsToUtcDay(now);
  const completed = await getCompletedSupplySnapshot(db);
  const latestDate = completed?.snapshotDate ?? today - DAY_SECONDS;
  const runDates = new Set<number>();
  for (const [, days] of SUPPLY_WINDOWS) {
    const target = now - days * DAY_SECONDS;
    const firstDay = bucketUnixSecondsToUtcDay(target - DAY_SECONDS - SUPPLY_BASELINE_TOLERANCE_SEC);
    // A daily snapshot can admit an observation that arrived just before UTC midnight.
    const lastDay = Math.min(latestDate, bucketUnixSecondsToUtcDay(target + SUPPLY_BASELINE_TOLERANCE_SEC) + DAY_SECONDS);
    for (let date = firstDay; date <= lastDay; date += DAY_SECONDS) runDates.add(date);
  }
  const dates = new Set(runDates);
  const restoredHistoryIds = new Set<string>();
  for (const asset of assets) {
    const clock = asset.supplyObservedAt;
    if (!asset.supplyRestored || chartPackets.has(asset) ||
      (asset.pegType !== "peggedUSD" && !asset[pendingCarriedSupplyBaselines] && asset.supplyChangeBaselines === undefined) ||
      clock == null || !isSupplyObservationWithinRestoreCeiling(clock, now)) continue;
    restoredHistoryIds.add(asset.id);
    for (const [, days] of SUPPLY_WINDOWS) {
      const targetDate = bucketUnixSecondsToUtcDay(clock - days * DAY_SECONDS);
      // An older carry can target a close outside the run-relative window.
      if (targetDate <= latestDate) dates.add(targetDate);
      if (targetDate + DAY_SECONDS <= latestDate) dates.add(targetDate + DAY_SECONDS);
    }
  }
  if (dates.size === 0) return 0;
  const historyRows = await runWithOverloadRetry(() => db.prepare(
    `SELECT stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance,
       price, price_observed_at, valuation_price_usd, valuation_observed_at_sec
     FROM supply_history WHERE snapshot_date IN (${Array.from(dates, () => "?").join(", ")})`,
  ).bind(...dates).all<SupplyHistoryRow>(), 3, signal);

  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  type Close = {
    snapshotDate: number;
    observedAt: number;
    circulatingUsd: number;
    circulatingNative: number | null;
    source: string | null;
  };
  const historyById = new Map<string, {
    assessedDates: Set<number>; closes: Close[]; legacyUsd: Map<number, number>; storedGaps: Map<number, GuardChain[]>;
  }>();
  for (const row of historyRows.results ?? []) {
    if (!runDates.has(row.snapshot_date) && !restoredHistoryIds.has(row.stablecoin_id)) continue;
    const { provenance, invalid } = parseSupplyObservationProvenance(row.supply_provenance);
    const observedAt = provenance?.supplyObservedAt;
    const asset = assetsById.get(row.stablecoin_id);
    const coverage = classifySupplyCoverage(provenance);
    // A non-USD list cap carries its provider's valuation, so only that provider's dated row compares with it.
    const legacyUsdEligible = (asset?.pegType === "peggedUSD" ||
      (asset?.supplyObservedAt == null && provenance?.supplySource === "defillama")) && asset?.supplySource === "defillama" &&
      !asset.supplyGapFill && !asset.frozen && !asset.supplyRestored && Number.isFinite(row.circulating_usd) &&
      row.circulating_usd >= 0 && !isEarlierSupplyPerimeter(asset.id, row.snapshot_date) &&
      !isAmbiguousSupplyPerimeterDay(asset.id, row.snapshot_date);
    // A directly reported USD cap can survive an explicit refusal to infer token units.
    const unassessed = observedAt == null && !invalid && coverage !== "partial" &&
      (!provenance?.nativeQuantityUnavailable ||
        (legacyUsdEligible && provenance.supplySource === "defillama" && coverage === "complete")) &&
      row.circulating_native == null && row.valuation_price_usd == null &&
      row.valuation_observed_at_sec == null;
    if (unassessed && !legacyUsdEligible) continue;
    const history = historyById.get(row.stablecoin_id) ?? {
      assessedDates: new Set<number>(), closes: [] as Close[], legacyUsd: new Map<number, number>(), storedGaps: new Map(),
    };
    historyById.set(row.stablecoin_id, history);
    // Pricing v6.90: an undated immaterial gap is not an assessment of the provider's own prior bucket.
    if (legacyUsdEligible && observedAt == null && !invalid && coverage === "partial" &&
      classifySupplyAmountCoverage(provenance) === "complete") {
      history.storedGaps.set(row.snapshot_date, provenance!.supplyChainGuard!.chains);
      continue;
    }
    if (unassessed) {
      history.legacyUsd.set(row.snapshot_date, row.circulating_usd);
      continue;
    }
    history.assessedDates.add(row.snapshot_date);
    if (observedAt != null) history.assessedDates.add(bucketUnixSecondsToUtcDay(observedAt));
    const source = provenance?.supplySource ?? null;
    if (observedAt == null || observedAt <= 0 || observedAt > now || coverage !== "complete" ||
      (isKinesisWrapperSupplyId(row.stablecoin_id) &&
        isKinesisWrapperSupplyCutoverActive(row.stablecoin_id, perimeterAt) !== (source === "onchain-total-supply")) ||
      !Number.isFinite(row.circulating_usd) || row.circulating_usd < 0) continue;
    const datedValuation = hasDatedUsdValuation(source, observedAt, row.valuation_price_usd, row.valuation_observed_at_sec, now);
    if (!datedValuation && source !== "defillama") continue;
    const native = !datedValuation || (row.stablecoin_id === "xaut-tether" && source !== "onchain-circulating-supply")
      ? null : historicalSupplyQuantity(row.stablecoin_id, asset?.pegType, row, provenance, now);
    history.closes.push({ snapshotDate: row.snapshot_date, observedAt, source, circulatingUsd: row.circulating_usd,
      circulatingNative: native });
  }

  let fillCount = 0;
  for (const asset of assets) {
    throwIfAborted(signal);
    if (chartPackets.has(asset)) continue;
    const clock = asset.supplyObservedAt;
    const undatedValuation = clock != null && asset.valuationObservedAtSec !== undefined &&
      !hasDatedUsdValuation(asset.supplySource, clock, asset.valuationPriceUsd, asset.valuationObservedAtSec, now);
    // The DefiLlama cap has its own observation clock. An optional quote only values its token count.
    if (undatedValuation && asset.supplySource !== "defillama") {
      asset.supplyChangeBaselines = { day: null, week: null, month: null };
      continue;
    }
    const history = historyById.get(asset.id);
    if (asset.supplyRestored) {
      const requiresDatedClose = asset.pegType !== "peggedUSD";
      const pending = asset[pendingCarriedSupplyBaselines];
      const carried = pending ?? asset.supplyChangeBaselines;
      if (requiresDatedClose && carried === undefined) continue;
      const baselines = { ...carried };
      const rejectedAll = carried != null && Object.keys(baselines).length === 0;
      const comparable = clock != null && clock > 0 && clock <= now && restoredHistoryIds.has(asset.id) && !asset.frozen &&
        (!requiresDatedClose || asset.supplySource === "defillama" ||
          hasDatedUsdValuation(asset.supplySource, clock, asset.valuationPriceUsd, asset.valuationObservedAtSec, now)) &&
        getCirculatingRawOrNull(asset) != null && classifySupplyCoverage(buildSupplyObservationProvenance(asset)) === "complete";
      const currentPerimeter = isEarlierSupplyPerimeter(asset.id, clock ?? now);
      for (const [window, days, field, readLegacy] of SUPPLY_WINDOWS) {
        const targetDate = clock == null ? null : bucketUnixSecondsToUtcDay(clock - days * DAY_SECONDS);
        const assessed = targetDate != null && history?.assessedDates.has(targetDate);
        const point = baselines[window];
        if (point === undefined && !assessed && !rejectedAll && !requiresDatedClose) continue;
        // Revalidate the carried close against its original stock. A carry cannot adopt a replacement.
        if (point && comparable && targetDate != null && matchesSupplySnapshotDay(point.observedAt, targetDate) &&
          !isAmbiguousSupplyPerimeterDay(asset.id, targetDate) &&
          isEarlierSupplyPerimeter(asset.id, point.observedAt) === currentPerimeter && (pending || point.circulatingUsd === readLegacy(asset))) {
          if (!assessed && !requiresDatedClose) continue;
          const close = history?.closes.find(candidate =>
            candidate.source === asset.supplySource && candidate.observedAt === point.observedAt &&
            candidate.circulatingUsd === point.circulatingUsd &&
            !isAmbiguousSupplyPerimeterDay(asset.id, candidate.snapshotDate) &&
            isEarlierSupplyPerimeter(asset.id, candidate.snapshotDate) === currentPerimeter);
          if (close) {
            if (point.circulatingNative != null && point.circulatingNative !== close.circulatingNative) {
              baselines[window] = { ...point, circulatingNative: null };
            }
            continue;
          }
        }
        baselines[window] = null;
        asset[field] = {};
      }
      if (Object.keys(baselines).length) asset.supplyChangeBaselines = baselines;
      continue;
    }
    if (!history) continue;
    const suppliedBaselines = asset[producerSupplyBaselines];
    if (suppliedBaselines && Object.keys(suppliedBaselines).length === 0) continue;
    const baselines: SupplyChangeBaselines = { ...asset.supplyChangeBaselines };
    const currentUsd = getCirculatingRawOrNull(asset);
    const undatedList = clock == null && asset.supplySource === "defillama";
    const undatedNonUsdList = undatedList && asset.pegType !== "peggedUSD";
    const clockComparable = undatedList ||
      (clock != null && Number.isSafeInteger(clock) && clock > 0 && clock <= now && now - clock <= DAY_SECONDS);
    if (!clockComparable || asset.frozen || currentUsd == null ||
      classifySupplyCoverage(buildSupplyObservationProvenance(asset)) !== "complete") {
      const matched = clockComparable && !asset.frozen && currentUsd != null ? matchComparisonPerimeter(asset, (window) => {
        const [, days, field] = SUPPLY_WINDOWS.find(([candidate]) => candidate === window)!;
        const targetDate = bucketUnixSecondsToUtcDay((clock ?? now) - days * DAY_SECONDS);
        return !priorCountsStoredGap(asset, history.storedGaps.get(targetDate), field);
      }) : [];
      asset.supplyChangeBaselines = { day: null, week: null, month: null };
      for (const window of matched) delete asset.supplyChangeBaselines[window];
      // An empty map would record a refusal; fully matched windows read their rewritten buckets.
      if (matched.length === SUPPLY_WINDOWS.length) delete asset.supplyChangeBaselines;
      if (matched.length > 0) asset.supplyChainGuard!.matchedComparisonWindows = matched;
      continue;
    }

    const mayFillLegacy = !asset.supplyGapFill && asset.supplySource !== "coingecko-gap-fill"
      && asset.supplySource !== "defillama-history-gap-fill" && asset.supplySource !== "onchain-total-supply"
      && asset.supplySource !== "onchain-circulating-supply";
    const keys = Object.keys(asset.circulating ?? {});
    const wrapper = isKinesisWrapperSupplyCutoverActive(asset.id, perimeterAt);
    const currentPerimeter = isEarlierSupplyPerimeter(asset.id, clock ?? now);
    const sameProducerOnly = asset.id === "xaut-tether" || (asset.pegType !== "peggedUSD" && asset.supplySource === "defillama");
    for (const [window, days, field, readLegacy] of SUPPLY_WINDOWS) {
      if (baselines[window] === null || suppliedBaselines?.[window] === null) {
        baselines[window] = null;
        continue;
      }
      const target = (clock ?? now) - days * DAY_SECONDS;
      const targetDate = bucketUnixSecondsToUtcDay(target);
      // Non-USD legacy buckets value the old balance at today's price. USD buckets
      // remain usable for dates on which there was no historical assessment.
      if (asset.pegType !== "peggedUSD" || history.assessedDates.has(targetDate) ||
        priorCountsStoredGap(asset, history.storedGaps.get(targetDate), field)) baselines[window] = null;
      const legacyUsd = history.legacyUsd.get(targetDate);
      // An undated non-USD list cap replaces the provider bucket with the cap snapshotted on that UTC date.
      const snapshottedListCap = undatedNonUsdList && !history.assessedDates.has(targetDate);
      if (legacyUsd != null && (baselines[window] === undefined || snapshottedListCap) && keys.length === 1 &&
        (readLegacy(asset) == null || snapshottedListCap) &&
        currentUsd > 0 && Math.abs(legacyUsd - currentUsd) / currentUsd <= MAX_LEGACY_BASELINE_RELATIVE_CHANGE) {
        if (readLegacy(asset) !== legacyUsd) fillCount++;
        asset[field] = { [keys[0]!]: legacyUsd };
        if (snapshottedListCap) delete baselines[window];
      }
      if (clock == null) continue;
      if (readLegacy(asset) == null && asset.supplyGapFill?.withheldHistoricalBuckets?.includes(window)) {
        baselines[window] = null;
        continue;
      }
      const missingOwnedWindow = !mayFillLegacy && readLegacy(asset) == null;
      let best: Close | undefined;
      let nearest: Close | undefined;
      let nearestDistance = SUPPLY_BASELINE_TOLERANCE_SEC + 1;
      for (const candidate of history.closes) {
        if ((missingOwnedWindow || sameProducerOnly) && candidate.source !== asset.supplySource) continue;
        if (!wrapper && (isAmbiguousSupplyPerimeterDay(asset.id, candidate.snapshotDate) ||
          isEarlierSupplyPerimeter(asset.id, candidate.snapshotDate) !== currentPerimeter)) continue;
        if (matchesSupplySnapshotDay(candidate.observedAt, targetDate, candidate.snapshotDate) && (!best || candidate.observedAt > best.observedAt)) best = candidate;
        const distance = Math.abs(candidate.observedAt - target);
        if (distance < nearestDistance || (distance === nearestDistance && nearest && candidate.observedAt < nearest.observedAt)) {
          nearestDistance = distance;
          nearest = candidate;
        }
      }
      if (best) {
        const { observedAt, circulatingUsd, circulatingNative } = best;
        baselines[window] = { observedAt, circulatingUsd, circulatingNative };
      }
      const prior = nearest?.circulatingNative;
      const current = asset.circulatingNative;
      const price = asset.valuationPriceUsd;
      if (!undatedValuation && mayFillLegacy && keys.length === 1 && readLegacy(asset) == null && prior != null &&
        current != null && current > 0 && price != null && Number.isFinite(prior * price) &&
        Math.abs(prior - current) / current <= MAX_LEGACY_BASELINE_RELATIVE_CHANGE) {
        // Existing buckets express balance history at the current valuation.
        asset[field] = { [keys[0]!]: prior * price };
        fillCount++;
      }
    }
    if (Object.keys(baselines).length > 0) asset.supplyChangeBaselines = baselines;
    // Every window then reads its snapshotted bucket; an empty map would withhold them all.
    else if (undatedNonUsdList) delete asset.supplyChangeBaselines;
  }

  return fillCount;
}

export function computePriceStalenessSummary(
  previousAssets: PeggedAsset[],
  currentAssets: PeggedAsset[],
): PriceStalenessSummary {
  const previousPrices = new Map(
    previousAssets
      .filter((asset) => asset.price != null && typeof asset.price === "number" && asset.price > 0)
      .map((asset) => [asset.id, {
        price: asset.price as number,
        observedAt: asset.priceObservedAt ?? null,
        source: asset.priceSource ?? null,
        confidence: asset.priceConfidence ?? null,
      }]),
  );

  let compared = 0;
  let identical = 0;

  for (const asset of currentAssets) {
    const previous = previousPrices.get(asset.id);
    if (previous == null || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;

    compared++;
    const currentObservedAt = asset.priceObservedAt ?? null;
    const currentSource = asset.priceSource ?? null;
    const currentConfidence = asset.priceConfidence ?? null;
    // Only an upstream observation clock proves a new price. `priceSyncedAt`
    // and the post-enrichment `priceUpdatedAt` are this run's application
    // stamps: every carried-forward price is re-stamped before this check, so
    // comparing them would make a frozen feed look freshly observed.
    const hasNewerObservation =
      (currentObservedAt != null && previous.observedAt != null && currentObservedAt > previous.observedAt) ||
      (currentObservedAt != null && previous.observedAt == null);
    const hasFreshMetadata =
      hasNewerObservation ||
      currentSource !== previous.source ||
      currentConfidence !== previous.confidence;
    if (Math.abs(asset.price - previous.price) / previous.price < 0.0001 && !hasFreshMetadata) {
      identical++;
    }
  }

  return {
    compared,
    identical,
    stale: compared >= 50 && identical / compared > 0.95,
  };
}

/**
 * Derives the staleness verdict from the previous stablecoins payload the run
 * already loaded and parsed at intake, instead of re-reading and re-parsing
 * the whole cache a third time. The load-state discriminator preserves the
 * missing/malformed/error outcomes the direct read used to produce.
 */
export function detectPriceStaleness(
  previousCacheState: PreviousStablecoinsCacheState,
  previousAssetsById: ReadonlyMap<string, PeggedAsset>,
  currentAssets: PeggedAsset[],
): PriceStalenessCheckResult {
  if (previousCacheState.state === "missing") return { state: "missing-previous-cache" };
  if (previousCacheState.state === "malformed") {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to parse previous stablecoins cache in staleness check");
    return { state: "check-failed", reason: "malformed-previous-cache" };
  }
  if (previousCacheState.state === "error") {
    return { state: "check-failed", reason: previousCacheState.message };
  }

  return {
    state: "ok",
    summary: computePriceStalenessSummary([...previousAssetsById.values()], currentAssets),
  };
}
