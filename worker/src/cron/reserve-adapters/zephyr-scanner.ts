import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

const ZEPHYR_ATOM_DECIMALS = 12;
const ZEPHYR_PRICE_DECIMALS = 12;
const ZEPHYR_RESERVE_SLICE = {
  name: "ZEPH protocol reserve",
  pct: 100,
  risk: "high",
} as const;

interface ZephyrLiveStatsPayload {
  zsd_circ?: number;
  zsd_price?: number;
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
  };
  pricing_record?: {
    spot?: number;
    timestamp?: number;
    reserve_ratio?: number;
    reserve_ratio_ma?: number;
  };
  raw?: {
    assets?: string;
    liabilities?: string;
    zeph_reserve?: string;
    num_stables?: string;
    zyield_reserve?: string;
    reserve_ratio?: string;
    reserve_ratio_ma?: string;
    pr?: {
      spot?: number;
      timestamp?: number;
      reserve_ratio?: number;
      reserve_ratio_ma?: number;
    };
  };
}

interface ZephyrSnapshotPayload {
  results?: ZephyrSnapshotResult[];
}

type ZephyrScannerPayload = ZephyrLiveStatsPayload | ZephyrSnapshotPayload;

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
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    throw new Error(`zephyr-scanner missing positive ${label}`);
  }
  return value;
}

function buildWarnings(collateralizationRatio: number): LiveReserveWarning[] {
  return collateralizationRatio < 0.995
    ? [
        reserveDegradedWarning(
          "reserve-undercollateralized",
          `Zephyr ZEPH reserve covers ${(collateralizationRatio * 100).toFixed(2)}% of ZSD supply`,
        ),
      ]
    : [];
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
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "zephyr-scanner-reserve-snapshot",
            "Zephyr reserve snapshot did not expose a trustworthy source timestamp",
          )),
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

export function adaptZephyrScanner(payload: ZephyrScannerPayload): AdapterResult {
  if ("results" in payload) {
    return adaptSnapshot(payload);
  }
  return adaptLiveStats(payload);
}

export async function fetchZephyrScannerReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "zephyr-scanner");
  const payload = await fetchJsonWithRetry<ZephyrScannerPayload>(input.url, signal, 12_000, ctx);
  return adaptZephyrScanner(payload);
}
