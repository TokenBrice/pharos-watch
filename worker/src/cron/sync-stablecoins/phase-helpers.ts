import { LEGACY_SOLOMON_USDV_ID } from "../../lib/solomon-usdv-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { admitSupplyBuckets, getCirculatingRawOrNull, type SupplyBucketInvalidReason } from "@shared/lib/supply";
import { CHAIN_CIRCULATING_KEYS, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { isRecord } from "@shared/lib/type-guards";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { throwIfAborted } from "../../lib/abort";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import type { PeggedAsset } from "./enrich-prices";
import type { PreviousStablecoinsCacheState } from "./shared";
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
      asset.name = meta?.name ?? asset.name;
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

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

export async function fillMissingSupplyHistory(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const nowMs = Date.now();
  const utcMidnight = (daysAgo: number): number => {
    const date = new Date(nowMs);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return startOfUtcDaySec(date);
  };

  const date1d = utcMidnight(1);
  const date7d = utcMidnight(7);
  const date30d = utcMidnight(30);

  throwIfAborted(signal);
  const historyRows = await runWithOverloadRetry(() => db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE snapshot_date IN (?, ?, ?)")
    .bind(date1d, date7d, date30d)
    .all<SupplyHistoryRow>(), 3, signal);

  if ((historyRows.results ?? []).length === 0) {
    return 0;
  }

  const historyById = new Map<string, { day?: number; week?: number; month?: number }>();
  for (const row of historyRows.results ?? []) {
    const entry = historyById.get(row.stablecoin_id) ?? {};
    if (row.snapshot_date === date1d) entry.day = row.circulating_usd;
    else if (row.snapshot_date === date7d) entry.week = row.circulating_usd;
    else if (row.snapshot_date === date30d) entry.month = row.circulating_usd;
    historyById.set(row.stablecoin_id, entry);
  }

  let fillCount = 0;
  for (const asset of assets) {
    throwIfAborted(signal);
    const historical = historyById.get(String(asset.id));
    if (!historical) continue;

    const circulating = asset.circulating;
    if (!circulating) continue;

    // A total history row can only be assigned without inventing attribution
    // when the asset has exactly one circulating peg bucket.
    const pegKeys = Object.keys(circulating);
    if (pegKeys.length !== 1) continue;
    const pegKey = pegKeys[0]!;

    const currentValue = circulating[pegKey] ?? 0;
    const isReasonable = (value: number) =>
      currentValue > 0 && Math.abs(value - currentValue) / currentValue <= 0.30;

    if (asset.circulatingPrevDay == null && historical.day != null && isReasonable(historical.day)) {
      asset.circulatingPrevDay = { [pegKey]: historical.day };
      fillCount++;
    }
    if (asset.circulatingPrevWeek == null && historical.week != null && isReasonable(historical.week)) {
      asset.circulatingPrevWeek = { [pegKey]: historical.week };
      fillCount++;
    }
    if (asset.circulatingPrevMonth == null && historical.month != null && isReasonable(historical.month)) {
      asset.circulatingPrevMonth = { [pegKey]: historical.month };
      fillCount++;
    }
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
        observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
        syncedAt: asset.priceSyncedAt ?? null,
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
    const currentObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
    const currentSyncedAt = asset.priceSyncedAt ?? null;
    const currentSource = asset.priceSource ?? null;
    const currentConfidence = asset.priceConfidence ?? null;
    const hasNewerObservation =
      (currentObservedAt != null && previous.observedAt != null && currentObservedAt > previous.observedAt) ||
      (currentObservedAt != null && previous.observedAt == null) ||
      (currentSyncedAt != null && previous.syncedAt != null && currentSyncedAt > previous.syncedAt) ||
      (currentSyncedAt != null && previous.syncedAt == null);
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
