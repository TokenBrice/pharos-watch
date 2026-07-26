import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  unverifiedFreshnessMetadata,
} from "./helpers";

const ZEPHYR_ATOM_DECIMALS = 12;
const ZEPHYR_PRICE_DECIMALS = 12;
const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";
const ZEPHYR_SNAPSHOT_SOURCE =
  "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc";
const ZEPHYR_RESERVE_SLICE = {
  name: "ZEPH protocol reserve",
  pct: 100,
  risk: "high",
} as const;
const ZEPHYR_YIELD_RESERVE_SLICE: ReserveSlice = {
  name: "ZSD yield reserve backing ZYS shares",
  pct: 100,
  risk: "high",
  coinId: ZEPHYR_ZSD_ASSET_ID,
  depType: "wrapper",
  assetClass: "stablecoin",
  issuerOrObligor: "Zephyr Protocol on-chain ZSD yield reserve",
  riskFactors: [
    "counterparty",
    "smart-contract",
    "market",
    "liquidity",
    "concentration",
  ],
  liquidityHorizon: "unknown",
};

interface ZephyrLiveStatsPayload {
  zsd_circ?: number;
  zsd_price?: number;
  zys_circ?: number;
  zys_price?: number;
  zeph_price?: number;
  reserve_ratio?: number;
  reserve_ratio_ma?: number;
  zeph_in_reserve?: number;
  zeph_in_reserve_value?: number;
  zsd_in_yield_reserve?: number;
  zsd_in_yield_reserve_percent?: number;
}

interface ZephyrSnapshotResult {
  captured_at?: string;
  reserve_height?: number;
  previous_height?: number;
  hf_version?: number;
  on_chain?: {
    zeph_reserve_atoms?: string;
    zeph_reserve?: number;
    zsd_circ_atoms?: string;
    zsd_circ?: number;
    reserve_ratio?: number;
    reserve_ratio_ma?: number;
    zsd_yield_reserve_atoms?: string;
    zsd_yield_reserve?: number;
    zys_circ_atoms?: string;
    zys_circ?: number;
  };
  pricing_record?: {
    spot?: number;
    timestamp?: number;
    reserve_ratio?: number;
    reserve_ratio_ma?: number;
    yield_price?: number;
  };
  raw?: {
    assets?: string;
    liabilities?: string;
    zeph_reserve?: string;
    num_stables?: string;
    num_zyield?: string;
    zyield_reserve?: string;
    reserve_ratio?: string;
    reserve_ratio_ma?: string;
    pr?: {
      spot?: number;
      timestamp?: number;
      reserve_ratio?: number;
      reserve_ratio_ma?: number;
      yield_price?: number;
    };
  };
}

interface ZephyrSnapshotPayload {
  total?: number;
  limit?: number;
  order?: string;
  results?: ZephyrSnapshotResult[];
}

type ZephyrScannerPayload = ZephyrLiveStatsPayload | ZephyrSnapshotPayload;

function isZephyrSnapshotPayload(payload: ZephyrScannerPayload): payload is ZephyrSnapshotPayload {
  return "results" in payload;
}

function isZephyrLiveStatsPayload(payload: ZephyrScannerPayload): payload is ZephyrLiveStatsPayload {
  return !isZephyrSnapshotPayload(payload);
}

function positiveDecimalAtoms(value: unknown, decimals: number): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = decimalNumberFromBigInt(BigInt(value), decimals);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveFixedPoint(value: unknown, decimals: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value / 10 ** decimals;
}

function requirePositive(value: number | null | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`zephyr-scanner missing positive ${label}`);
  }
  return value;
}

function buildWarnings(collateralizationRatio: number): LiveReserveWarning[] {
  return buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `Zephyr ZEPH reserve covers ${pct}% of ZSD supply`,
    coverageRatio: collateralizationRatio,
  });
}

function buildYieldReserveWarnings(collateralizationRatio: number): LiveReserveWarning[] {
  return buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `Zephyr ZSD yield reserve covers ${pct}% of ZYS liabilities`,
    coverageRatio: collateralizationRatio,
  });
}

function assertRateReconciliation(
  reserveAmount: number,
  shareSupply: number,
  sharePrice: number,
): void {
  const impliedSharePrice = reserveAmount / shareSupply;
  const divergence = Math.abs(sharePrice - impliedSharePrice) / impliedSharePrice;
  if (!Number.isFinite(divergence) || divergence > 0.005) {
    throw new Error(
      `zephyr-scanner ZYS share-rate divergence ${(divergence * 100).toFixed(4)}% exceeds 0.5%`,
    );
  }
}

function buildYieldAdapterStatus(
  sourceTimestamp: number | null,
): Record<string, unknown> {
  return {
    asset: ZEPHYR_ZYS_ASSET_ID,
    source: ZEPHYR_SNAPSHOT_SOURCE,
    lastSuccessfulObservation: sourceTimestamp,
    sliceSumPct: 100,
    unresolvedBucketCount: 0,
    classificationResult: "complete",
  };
}

function adaptSnapshot(payload: ZephyrSnapshotPayload): AdapterResult {
  const snapshot = payload.results?.[0];
  if (!snapshot) {
    throw new Error("zephyr-scanner snapshot response did not include a latest result");
  }

  const reserveAssetAmount = positiveDecimalAtoms(snapshot.on_chain?.zeph_reserve_atoms, ZEPHYR_ATOM_DECIMALS)
    ?? positiveDecimalAtoms(snapshot.raw?.zeph_reserve, ZEPHYR_ATOM_DECIMALS)
    ?? parsePositiveNumericLike(snapshot.on_chain?.zeph_reserve);
  const reserveAssetPriceUsd = positiveFixedPoint(snapshot.pricing_record?.spot, ZEPHYR_PRICE_DECIMALS)
    ?? positiveFixedPoint(snapshot.raw?.pr?.spot, ZEPHYR_PRICE_DECIMALS);
  const totalReserveUsd = positiveDecimalAtoms(snapshot.raw?.assets, ZEPHYR_ATOM_DECIMALS)
    ?? (reserveAssetAmount != null && reserveAssetPriceUsd != null ? reserveAssetAmount * reserveAssetPriceUsd : null);
  const supplyUsd = positiveDecimalAtoms(snapshot.raw?.liabilities, ZEPHYR_ATOM_DECIMALS)
    ?? positiveDecimalAtoms(snapshot.raw?.num_stables, ZEPHYR_ATOM_DECIMALS)
    ?? positiveDecimalAtoms(snapshot.on_chain?.zsd_circ_atoms, ZEPHYR_ATOM_DECIMALS)
    ?? parsePositiveNumericLike(snapshot.on_chain?.zsd_circ);
  const collateralizationRatio = parsePositiveNumericLike(snapshot.on_chain?.reserve_ratio)
    ?? parsePositiveNumericLike(snapshot.raw?.reserve_ratio)
    ?? positiveFixedPoint(snapshot.pricing_record?.reserve_ratio, ZEPHYR_PRICE_DECIMALS)
    ?? positiveFixedPoint(snapshot.raw?.pr?.reserve_ratio, ZEPHYR_PRICE_DECIMALS)
    ?? (totalReserveUsd != null && supplyUsd != null ? totalReserveUsd / supplyUsd : null);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(snapshot.captured_at)
    ?? parseTimestampLikeToUnixSeconds(snapshot.pricing_record?.timestamp)
    ?? parseTimestampLikeToUnixSeconds(snapshot.raw?.pr?.timestamp);

  const requiredTotalReserveUsd = requirePositive(totalReserveUsd, "total reserve USD");
  const requiredSupplyUsd = requirePositive(supplyUsd, "ZSD supply USD");
  const requiredRatio = requirePositive(collateralizationRatio, "collateralization ratio");

  return {
    slices: [ZEPHYR_RESERVE_SLICE],
    ...(buildWarnings(requiredRatio).length > 0 ? { warnings: buildWarnings(requiredRatio) } : {}),
    metadata: {
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "zephyr-scanner-reserve-snapshot",
        "Zephyr reserve snapshot did not expose a trustworthy source timestamp",
      ),
      totalReserveUsd: requiredTotalReserveUsd,
      supplyUsd: requiredSupplyUsd,
      collateralizationRatio: requiredRatio,
      reserveAssetAmount,
      reserveAssetPriceUsd,
      reserveRatioMovingAverage:
        parsePositiveNumericLike(snapshot.on_chain?.reserve_ratio_ma)
        ?? parsePositiveNumericLike(snapshot.raw?.reserve_ratio_ma)
        ?? positiveFixedPoint(snapshot.pricing_record?.reserve_ratio_ma, ZEPHYR_PRICE_DECIMALS)
        ?? positiveFixedPoint(snapshot.raw?.pr?.reserve_ratio_ma, ZEPHYR_PRICE_DECIMALS),
      zsdYieldReserve:
        parsePositiveNumericLike(snapshot.on_chain?.zsd_yield_reserve)
        ?? positiveDecimalAtoms(snapshot.on_chain?.zsd_yield_reserve_atoms, ZEPHYR_ATOM_DECIMALS)
        ?? positiveDecimalAtoms(snapshot.raw?.zyield_reserve, ZEPHYR_ATOM_DECIMALS),
      reserveHeight: snapshot.reserve_height,
      previousHeight: snapshot.previous_height,
      hardForkVersion: snapshot.hf_version,
      details: {
        proofKind: "zephyr-scanner-reserve-snapshot",
        reserveSourceLabel: "Zephyr Scanner reserve snapshot",
      },
    },
  };
}

function adaptLiveStats(payload: ZephyrLiveStatsPayload): AdapterResult {
  const totalReserveUsd = parsePositiveNumericLike(payload.zeph_in_reserve_value)
    ?? (
      parsePositiveNumericLike(payload.zeph_in_reserve) != null && parsePositiveNumericLike(payload.zeph_price) != null
        ? parsePositiveNumericLike(payload.zeph_in_reserve)! * parsePositiveNumericLike(payload.zeph_price)!
        : null
    );
  const zsdPrice = parsePositiveNumericLike(payload.zsd_price) ?? 1;
  const zsdSupply = parsePositiveNumericLike(payload.zsd_circ);
  const supplyUsd = zsdSupply != null ? zsdSupply * zsdPrice : null;
  const collateralizationRatio = parsePositiveNumericLike(payload.reserve_ratio)
    ?? (totalReserveUsd != null && supplyUsd != null ? totalReserveUsd / supplyUsd : null);

  const requiredTotalReserveUsd = requirePositive(totalReserveUsd, "total reserve USD");
  const requiredSupplyUsd = requirePositive(supplyUsd, "ZSD supply USD");
  const requiredRatio = requirePositive(collateralizationRatio, "collateralization ratio");

  return {
    slices: [ZEPHYR_RESERVE_SLICE],
    ...(buildWarnings(requiredRatio).length > 0 ? { warnings: buildWarnings(requiredRatio) } : {}),
    metadata: {
      ...unverifiedFreshnessMetadata(
        "zephyr-scanner-livestats",
        "Zephyr livestats payload does not include a trustworthy source timestamp",
      ),
      totalReserveUsd: requiredTotalReserveUsd,
      supplyUsd: requiredSupplyUsd,
      collateralizationRatio: requiredRatio,
      reserveAssetAmount: payload.zeph_in_reserve,
      reserveAssetPriceUsd: payload.zeph_price,
      reserveRatioMovingAverage: payload.reserve_ratio_ma,
      zsdYieldReserve: payload.zsd_in_yield_reserve,
      zsdYieldReservePct: payload.zsd_in_yield_reserve_percent != null
        ? payload.zsd_in_yield_reserve_percent * 100
        : undefined,
      details: {
        proofKind: "zephyr-scanner-livestats",
        reserveSourceLabel: "Zephyr Scanner live stats",
      },
    },
  };
}

function adaptYieldSnapshot(payload: ZephyrSnapshotPayload): AdapterResult {
  const snapshot = payload.results?.[0];
  if (!snapshot) {
    throw new Error("zephyr-scanner snapshot response did not include a latest result");
  }

  const reserveAmount = positiveDecimalAtoms(
    snapshot.on_chain?.zsd_yield_reserve_atoms,
    ZEPHYR_ATOM_DECIMALS,
  )
    ?? positiveDecimalAtoms(snapshot.raw?.zyield_reserve, ZEPHYR_ATOM_DECIMALS)
    ?? parsePositiveNumericLike(snapshot.on_chain?.zsd_yield_reserve);
  const shareSupply = positiveDecimalAtoms(
    snapshot.on_chain?.zys_circ_atoms,
    ZEPHYR_ATOM_DECIMALS,
  )
    ?? positiveDecimalAtoms(snapshot.raw?.num_zyield, ZEPHYR_ATOM_DECIMALS)
    ?? parsePositiveNumericLike(snapshot.on_chain?.zys_circ);
  const publishedSharePrice = positiveFixedPoint(
    snapshot.pricing_record?.yield_price,
    ZEPHYR_PRICE_DECIMALS,
  )
    ?? positiveFixedPoint(snapshot.raw?.pr?.yield_price, ZEPHYR_PRICE_DECIMALS);
  const requiredReserveAmount = requirePositive(reserveAmount, "ZSD yield reserve");
  const requiredShareSupply = requirePositive(shareSupply, "ZYS circulation");
  const sharePriceZsd = publishedSharePrice
    ?? requiredReserveAmount / requiredShareSupply;
  assertRateReconciliation(
    requiredReserveAmount,
    requiredShareSupply,
    sharePriceZsd,
  );

  const liabilityAmountZsd = requiredShareSupply * sharePriceZsd;
  const collateralizationRatio = requiredReserveAmount / liabilityAmountZsd;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(snapshot.captured_at)
    ?? parseTimestampLikeToUnixSeconds(snapshot.pricing_record?.timestamp)
    ?? parseTimestampLikeToUnixSeconds(snapshot.raw?.pr?.timestamp);
  const warnings = buildYieldReserveWarnings(collateralizationRatio);

  return {
    slices: [ZEPHYR_YIELD_RESERVE_SLICE],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "zephyr-scanner-yield-reserve-snapshot",
        "Zephyr yield-reserve snapshot did not expose a trustworthy source timestamp",
      ),
      reserveAmountZsd: requiredReserveAmount,
      liabilityAmountZsd,
      zysCirculating: requiredShareSupply,
      sharePriceZsd,
      collateralizationRatio,
      reserveHeight: snapshot.reserve_height,
      previousHeight: snapshot.previous_height,
      hardForkVersion: snapshot.hf_version,
      details: {
        proofKind: "zephyr-scanner-yield-reserve-snapshot",
        reserveSourceLabel: "Zephyr Scanner ZSD yield reserve snapshot",
        reserveAssetId: ZEPHYR_ZSD_ASSET_ID,
        reserveAssetAmountZsd: requiredReserveAmount,
        zysCirculating: requiredShareSupply,
        sharePriceZsd,
        adapterStatus: buildYieldAdapterStatus(sourceTimestamp),
      },
    },
  };
}

function adaptYieldLiveStats(payload: ZephyrLiveStatsPayload): AdapterResult {
  const reserveAmount = requirePositive(
    parsePositiveNumericLike(payload.zsd_in_yield_reserve),
    "ZSD yield reserve",
  );
  const shareSupply = requirePositive(
    parsePositiveNumericLike(payload.zys_circ),
    "ZYS circulation",
  );
  const zsdPrice = requirePositive(
    parsePositiveNumericLike(payload.zsd_price),
    "ZSD price",
  );
  const zysPrice = requirePositive(
    parsePositiveNumericLike(payload.zys_price),
    "ZYS price",
  );
  const sharePriceZsd = zysPrice / zsdPrice;
  assertRateReconciliation(reserveAmount, shareSupply, sharePriceZsd);

  const totalReserveUsd = reserveAmount * zsdPrice;
  const supplyUsd = shareSupply * zysPrice;
  const collateralizationRatio = totalReserveUsd / supplyUsd;
  const warnings = buildYieldReserveWarnings(collateralizationRatio);

  return {
    slices: [ZEPHYR_YIELD_RESERVE_SLICE],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...unverifiedFreshnessMetadata(
        "zephyr-scanner-yield-livestats",
        "Zephyr yield livestats payload does not include a trustworthy source timestamp",
      ),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      details: {
        proofKind: "zephyr-scanner-yield-livestats",
        reserveSourceLabel: "Zephyr Scanner ZSD yield reserve live stats",
        reserveAssetId: ZEPHYR_ZSD_ASSET_ID,
        reserveAssetAmountZsd: reserveAmount,
        zysCirculating: shareSupply,
        sharePriceZsd,
        adapterStatus: buildYieldAdapterStatus(null),
      },
    },
  };
}

export function adaptZephyrScanner(
  payload: ZephyrScannerPayload,
  assetId: string = ZEPHYR_ZSD_ASSET_ID,
): AdapterResult {
  if (assetId === ZEPHYR_ZYS_ASSET_ID) {
    if (isZephyrSnapshotPayload(payload) && payload.results != null && payload.results.length > 0) {
      return adaptYieldSnapshot(payload);
    }
    if (isZephyrLiveStatsPayload(payload)) {
      return adaptYieldLiveStats(payload);
    }
    throw new Error("zephyr-scanner payload did not include a valid ZYS snapshot or live-stats format");
  }
  if (assetId !== ZEPHYR_ZSD_ASSET_ID) {
    throw new Error(`zephyr-scanner does not support asset ${assetId}`);
  }
  if (isZephyrSnapshotPayload(payload) && payload.results != null && payload.results.length > 0) {
    return adaptSnapshot(payload);
  }
  if (isZephyrLiveStatsPayload(payload)) {
    return adaptLiveStats(payload);
  }
  throw new Error("zephyr-scanner payload did not include a valid snapshot or live-stats format");
}

export async function fetchZephyrScannerReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<ZephyrScannerPayload>(
    config,
    "zephyr-scanner",
    signal,
    12_000,
    ctx,
  );
  return adaptZephyrScanner(payload, coin.id);
}
