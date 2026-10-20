import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  decimalFromDigitString,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseFiniteNumber,
  parsePositiveNumericLike,
  summarizeSourceTimestampsRequiringCoverage,
} from "./helpers";

const ZEPHYR_ATOM_DECIMALS = 12;
const ZEPHYR_PRICE_DECIMALS = 12;
const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";
const ZEPHYR_SNAPSHOT_SOURCE =
  "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc";

function buildZephyrReserveSlice(): ReserveSlice {
  return {
    name: "ZEPH protocol reserve",
    pct: 100,
    risk: "high",
    assetClass: "cryptoasset",
    issuerOrObligor: "Zephyr Protocol on-chain ZEPH reserve",
    riskFactors: [
      "smart-contract",
      "market",
      "liquidity",
      "concentration",
      "custody",
    ],
    liquidityHorizon: "unknown",
  };
}

function buildZephyrYieldReserveSlice(): ReserveSlice {
  return {
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

function positiveDecimalAtoms(value: unknown, decimals: number): number | null {
  const parsed = decimalFromDigitString(value, decimals);
  return parsed != null && parsed > 0 ? parsed : null;
}

function positiveFixedPoint(value: unknown, decimals: number): number | null {
  try {
    return parseFiniteNumber(value, { label: "zephyr-scanner fixed-point value", min: Number.MIN_VALUE })
      / 10 ** decimals;
  } catch {
    return null;
  }
}

function requirePositive(value: number | null | undefined, label: string): number {
  try {
    return parseFiniteNumber(value, { label: `zephyr-scanner missing positive ${label}`, min: Number.MIN_VALUE });
  } catch {
    throw new Error(`zephyr-scanner missing positive ${label}`);
  }
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
    message: (pct) => `Zephyr ZEPH reserve covers ${pct}% of ZSD supply backing ZYS shares`,
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
  const publishedSpot = positiveFixedPoint(snapshot.pricing_record?.spot, ZEPHYR_PRICE_DECIMALS);
  const reserveAssetPriceUsd = publishedSpot
    ?? positiveFixedPoint(snapshot.raw?.pr?.spot, ZEPHYR_PRICE_DECIMALS);
  const rawAssets = positiveDecimalAtoms(snapshot.raw?.assets, ZEPHYR_ATOM_DECIMALS);
  const totalReserveUsd = rawAssets
    ?? (reserveAssetAmount != null && reserveAssetPriceUsd != null ? reserveAssetAmount * reserveAssetPriceUsd : null);
  const supplyUsd = positiveDecimalAtoms(snapshot.raw?.liabilities, ZEPHYR_ATOM_DECIMALS)
    ?? positiveDecimalAtoms(snapshot.raw?.num_stables, ZEPHYR_ATOM_DECIMALS)
    ?? positiveDecimalAtoms(snapshot.on_chain?.zsd_circ_atoms, ZEPHYR_ATOM_DECIMALS)
    ?? parsePositiveNumericLike(snapshot.on_chain?.zsd_circ);
  const observedRatio = parsePositiveNumericLike(snapshot.on_chain?.reserve_ratio)
    ?? parsePositiveNumericLike(snapshot.raw?.reserve_ratio);
  const publishedRatio = positiveFixedPoint(snapshot.pricing_record?.reserve_ratio, ZEPHYR_PRICE_DECIMALS);
  const rawPricingRatio = positiveFixedPoint(snapshot.raw?.pr?.reserve_ratio, ZEPHYR_PRICE_DECIMALS);
  const collateralizationRatio = observedRatio
    ?? publishedRatio
    ?? rawPricingRatio
    ?? (totalReserveUsd != null && supplyUsd != null ? totalReserveUsd / supplyUsd : null);
  // Amounts belong to this captured height; raw USD assets and normalized
  // coverage also incorporate its pricing record, not the capture clock.
  const materialClocks: unknown[] = [snapshot.captured_at];
  if (reserveAssetPriceUsd != null) {
    materialClocks.push((publishedSpot != null ? snapshot.pricing_record : snapshot.raw?.pr)?.timestamp);
  }
  if (rawAssets != null || observedRatio != null) {
    materialClocks.push((snapshot.raw?.pr ?? snapshot.pricing_record)?.timestamp);
  }
  if (observedRatio == null && collateralizationRatio != null && (
    publishedRatio != null || rawPricingRatio != null
  )) {
    materialClocks.push((publishedRatio != null ? snapshot.pricing_record : snapshot.raw?.pr)?.timestamp);
  }
  const clocks = summarizeSourceTimestampsRequiringCoverage(materialClocks);
  const sourceTimestamp = clocks.untimestampedCount === 0 ? clocks.sourceTimestamp : null;
  const freshness = freshnessMetadataFromTimestamp(
    sourceTimestamp,
    "zephyr-scanner-reserve-snapshot",
    "Zephyr reserve snapshot omitted a material amount or pricing clock",
  );

  const requiredTotalReserveUsd = requirePositive(totalReserveUsd, "total reserve USD");
  const requiredSupplyUsd = requirePositive(supplyUsd, "ZSD supply USD");
  const requiredRatio = requirePositive(collateralizationRatio, "collateralization ratio");

  return {
    slices: [buildZephyrReserveSlice()],
    ...(buildWarnings(requiredRatio).length > 0 ? { warnings: buildWarnings(requiredRatio) } : {}),
    metadata: {
      ...freshness,
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
        ...("details" in freshness ? freshness.details : {}),
        capturedAt: snapshot.captured_at,
        proofKind: "zephyr-scanner-reserve-snapshot",
        reserveSourceLabel: "Zephyr Scanner reserve snapshot",
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
  const publishedYieldPrice = positiveFixedPoint(snapshot.pricing_record?.yield_price, ZEPHYR_PRICE_DECIMALS);
  const publishedSharePrice = publishedYieldPrice
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

  const observedCoverage = parsePositiveNumericLike(snapshot.on_chain?.reserve_ratio)
    ?? parsePositiveNumericLike(snapshot.raw?.reserve_ratio);
  const publishedCoverage = positiveFixedPoint(snapshot.pricing_record?.reserve_ratio, ZEPHYR_PRICE_DECIMALS);
  const zsdCoverageRatio = observedCoverage
    ?? publishedCoverage
    ?? positiveFixedPoint(snapshot.raw?.pr?.reserve_ratio, ZEPHYR_PRICE_DECIMALS);
  const liabilityAmountZsd = requiredShareSupply * sharePriceZsd;
  const collateralizationRatio = requirePositive(zsdCoverageRatio, "ZSD ZEPH reserve coverage ratio");
  const materialClocks: unknown[] = [
    snapshot.captured_at,
    (observedCoverage != null
      ? snapshot.raw?.pr ?? snapshot.pricing_record
      : publishedCoverage != null ? snapshot.pricing_record : snapshot.raw?.pr)?.timestamp,
  ];
  if (publishedSharePrice != null) {
    materialClocks.push((publishedYieldPrice != null ? snapshot.pricing_record : snapshot.raw?.pr)?.timestamp);
  }
  const clocks = summarizeSourceTimestampsRequiringCoverage(materialClocks);
  const sourceTimestamp = clocks.untimestampedCount === 0 ? clocks.sourceTimestamp : null;
  const freshness = freshnessMetadataFromTimestamp(
    sourceTimestamp,
    "zephyr-scanner-yield-reserve-snapshot",
    "Zephyr yield-reserve snapshot omitted a material amount, price or coverage clock",
  );
  const warnings = buildYieldReserveWarnings(collateralizationRatio);

  return {
    slices: [buildZephyrYieldReserveSlice()],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...freshness,
      reserveAmountZsd: requiredReserveAmount,
      liabilityAmountZsd,
      zysCirculating: requiredShareSupply,
      sharePriceZsd,
      collateralizationRatio,
      reserveHeight: snapshot.reserve_height,
      previousHeight: snapshot.previous_height,
      hardForkVersion: snapshot.hf_version,
      details: {
        ...("details" in freshness ? freshness.details : {}),
        capturedAt: snapshot.captured_at,
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

export function adaptZephyrScanner(
  payload: ZephyrSnapshotPayload,
  assetId: string = ZEPHYR_ZSD_ASSET_ID,
): AdapterResult {
  const hasResults = payload.results != null && payload.results.length > 0;
  if (assetId === ZEPHYR_ZYS_ASSET_ID) {
    if (hasResults) {
      return adaptYieldSnapshot(payload);
    }
    throw new Error("zephyr-scanner payload did not include a valid ZYS snapshot");
  }
  if (assetId !== ZEPHYR_ZSD_ASSET_ID) {
    throw new Error(`zephyr-scanner does not support asset ${assetId}`);
  }
  if (hasResults) {
    return adaptSnapshot(payload);
  }
  throw new Error("zephyr-scanner payload did not include a valid snapshot");
}

export async function fetchZephyrScannerReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<ZephyrSnapshotPayload>(
    config,
    "zephyr-scanner",
    signal,
    12_000,
    ctx,
  );
  return adaptZephyrScanner(payload, coin.id);
}
