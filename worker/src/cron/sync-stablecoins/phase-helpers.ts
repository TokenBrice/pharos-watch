import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter, isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { CURATED_AGGREGATE_ESCROW_RESIDUALS, isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { LEGACY_SOLOMON_USDV_ID } from "../../lib/solomon-usdv-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { admitSupplyBuckets, getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull, getPrevMonthRawOrNull, hasDatedUsdValuation, type SupplyBucketInvalidReason, type SupplyChangeBaselines } from "@shared/lib/supply";
import { CHAIN_CIRCULATING_KEYS, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { CHAIN_META } from "@shared/types/chain-identity";
import { isRecord } from "@shared/lib/type-guards";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { getCompletedSupplySnapshot } from "../../lib/supply-snapshot-completion";
import { historicalSupplyQuantity, type HistoricalSupplyQuantityRow } from "../../lib/supply-history-db";
import { throwIfAborted } from "../../lib/abort";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildSupplyObservationProvenance, classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import type { PeggedAsset } from "./enrich-prices";
import { reviewedOnchainSupplyHoldFields, type PreviousStablecoinsCacheState } from "./shared";
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
    } else if (asset.pegType === "peggedUSD") {
      delete asset.supplyChangeBaselines;
      if (chart && asset.supplySource === "defillama" && !asset.supplyRestored) {
        const rejected: SupplyChangeBaselines = {};
        for (const [window] of SUPPLY_WINDOWS) {
          if (chart[window] === null || Object.keys(chart).length === 0) rejected[window] = null;
        }
        if (Object.keys(rejected).length) asset.supplyChangeBaselines = rejected;
      }
    } else asset.supplyChangeBaselines = {};
    // An assessed stock with no admissible count must survive JSON as explicitly unavailable.
    if (current != null && !asset.supplyRestored && !asset.frozen) asset.circulatingNative ??= null;
  }
  const today = bucketUnixSecondsToUtcDay(now);
  const completed = await getCompletedSupplySnapshot(db);
  const latestDate = completed?.snapshotDate ?? today - DAY_SECONDS;
  const dates: number[] = [];
  for (const [, days] of SUPPLY_WINDOWS) {
    const target = now - days * DAY_SECONDS;
    const firstDay = bucketUnixSecondsToUtcDay(target - DAY_SECONDS - SUPPLY_BASELINE_TOLERANCE_SEC);
    // A daily snapshot can admit an observation that arrived just before UTC midnight.
    const lastDay = Math.min(latestDate, bucketUnixSecondsToUtcDay(target + SUPPLY_BASELINE_TOLERANCE_SEC) + DAY_SECONDS);
    for (let date = firstDay; date <= lastDay; date += DAY_SECONDS) dates.push(date);
  }
  if (dates.length === 0) return 0;
  const historyRows = await runWithOverloadRetry(() => db.prepare(
    `SELECT stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance,
       price, price_observed_at, valuation_price_usd, valuation_observed_at_sec
     FROM supply_history WHERE snapshot_date IN (${dates.map(() => "?").join(", ")})`,
  ).bind(...dates).all<SupplyHistoryRow>(), 3, signal);

  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  type Close = {
    snapshotDate: number;
    observedAt: number;
    circulatingUsd: number;
    circulatingNative: number | null;
    source: string | null;
  };
  const historyById = new Map<string, { assessedDates: Set<number>; closes: Close[]; legacyUsd: Map<number, number> }>();
  for (const row of historyRows.results ?? []) {
    const { provenance, invalid } = parseSupplyObservationProvenance(row.supply_provenance);
    const observedAt = provenance?.supplyObservedAt;
    const asset = assetsById.get(row.stablecoin_id);
    const unassessed = observedAt == null && !invalid && row.circulating_native == null && row.valuation_price_usd == null &&
      row.valuation_observed_at_sec == null && classifySupplyCoverage(provenance) !== "partial";
    if (unassessed && (asset?.pegType !== "peggedUSD" || asset.supplySource !== "defillama" ||
      asset.supplyGapFill || asset.frozen || asset.supplyRestored || !Number.isFinite(row.circulating_usd) ||
      row.circulating_usd < 0 || isEarlierSupplyPerimeter(asset.id, row.snapshot_date) ||
      isAmbiguousSupplyPerimeterDay(asset.id, row.snapshot_date))) continue;
    const history = historyById.get(row.stablecoin_id) ?? {
      assessedDates: new Set<number>(), closes: [] as Close[], legacyUsd: new Map<number, number>(),
    };
    historyById.set(row.stablecoin_id, history);
    if (unassessed) {
      history.legacyUsd.set(row.snapshot_date, row.circulating_usd);
      continue;
    }
    history.assessedDates.add(row.snapshot_date);
    if (observedAt != null) history.assessedDates.add(bucketUnixSecondsToUtcDay(observedAt));
    if (observedAt == null || observedAt <= 0 || observedAt > now ||
      !hasDatedUsdValuation(provenance?.supplySource, observedAt, row.valuation_price_usd, row.valuation_observed_at_sec, now) ||
      classifySupplyCoverage(provenance) !== "complete" ||
      (isKinesisWrapperSupplyId(row.stablecoin_id) &&
        isKinesisWrapperSupplyCutoverActive(row.stablecoin_id, perimeterAt) !== (provenance?.supplySource === "onchain-total-supply")) ||
      (row.stablecoin_id === "xaut-tether" && provenance?.supplySource !== "onchain-circulating-supply") ||
      !Number.isFinite(row.circulating_usd) || row.circulating_usd < 0) continue;
    const native = historicalSupplyQuantity(row.stablecoin_id, asset?.pegType, row, provenance, now);
    history.closes.push({ snapshotDate: row.snapshot_date, observedAt, source: provenance?.supplySource ?? null, circulatingUsd: row.circulating_usd,
      circulatingNative: native });
  }

  let fillCount = 0;
  for (const asset of assets) {
    throwIfAborted(signal);
    const history = historyById.get(asset.id);
    if (!history || chartPackets.has(asset)) continue;
    if (asset.supplyRestored) {
      asset.supplyChangeBaselines = {};
      continue;
    }
    const baselines: SupplyChangeBaselines = { ...asset.supplyChangeBaselines };
    const clock = asset.supplyObservedAt;
    const currentUsd = getCirculatingRawOrNull(asset);
    const undatedUsdList = clock == null && asset.pegType === "peggedUSD" && asset.supplySource === "defillama";
    if ((!undatedUsdList && (clock == null || !Number.isSafeInteger(clock) || clock <= 0 || clock > now || now - clock > DAY_SECONDS)) ||
      (asset.id === "xaut-tether" && asset.supplySource !== "onchain-circulating-supply") ||
      asset.frozen || currentUsd == null ||
      classifySupplyCoverage(buildSupplyObservationProvenance(asset)) !== "complete") {
      asset.supplyChangeBaselines = { day: null, week: null, month: null };
      continue;
    }

    const mayFillLegacy = !asset.supplyGapFill && asset.supplySource !== "coingecko-gap-fill"
      && asset.supplySource !== "defillama-history-gap-fill" && asset.supplySource !== "onchain-total-supply"
      && asset.supplySource !== "onchain-circulating-supply";
    const keys = Object.keys(asset.circulating ?? {});
    const wrapper = isKinesisWrapperSupplyCutoverActive(asset.id, perimeterAt);
    const currentPerimeter = isEarlierSupplyPerimeter(asset.id, clock ?? now);
    for (const [window, days, field, readLegacy] of SUPPLY_WINDOWS) {
      if (baselines[window] === null) continue;
      const target = (clock ?? now) - days * DAY_SECONDS;
      const targetDate = bucketUnixSecondsToUtcDay(target);
      // Non-USD legacy buckets value the old balance at today's price. USD buckets
      // remain usable for dates on which there was no historical assessment.
      if (asset.pegType !== "peggedUSD" || history.assessedDates.has(targetDate)) baselines[window] = null;
      const legacyUsd = history.legacyUsd.get(targetDate);
      if (legacyUsd != null && baselines[window] === undefined && keys.length === 1 && readLegacy(asset) == null &&
        currentUsd > 0 && Math.abs(legacyUsd - currentUsd) / currentUsd <= MAX_LEGACY_BASELINE_RELATIVE_CHANGE) {
        asset[field] = { [keys[0]!]: legacyUsd };
        fillCount++;
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
        // A different producer cannot fill an omitted window in a source-owned packet.
        if (missingOwnedWindow && candidate.source !== asset.supplySource) continue;
        if (!wrapper && (isAmbiguousSupplyPerimeterDay(asset.id, candidate.snapshotDate) ||
          isEarlierSupplyPerimeter(asset.id, candidate.snapshotDate) !== currentPerimeter)) continue;
        if (bucketUnixSecondsToUtcDay(candidate.observedAt) === targetDate && (!best || candidate.observedAt > best.observedAt)) best = candidate;
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
      if (mayFillLegacy && keys.length === 1 && readLegacy(asset) == null && prior != null &&
        current != null && current > 0 && price != null && Number.isFinite(prior * price) &&
        Math.abs(prior - current) / current <= MAX_LEGACY_BASELINE_RELATIVE_CHANGE) {
        // Existing buckets express balance history at the current valuation.
        asset[field] = { [keys[0]!]: prior * price };
        fillCount++;
      }
    }
    if (Object.keys(baselines).length > 0) asset.supplyChangeBaselines = baselines;
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
