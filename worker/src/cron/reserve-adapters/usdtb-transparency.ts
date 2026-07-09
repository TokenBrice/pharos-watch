import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";

interface UsdtbBackingAssetEntry {
  amount?: number;
  custodian?: string;
}

export interface UsdtbBackingAndSupplyPayload {
  assetsInMotion?: number;
  backingAssets?: Record<string, UsdtbBackingAssetEntry[]>;
  lastUpdatedAt?: string;
  supply?: number;
}

interface UsdtbAssetConfig {
  name: string;
  risk: ReserveSlice["risk"];
  coinId: string;
}

/** BUIDL and BUIDL-I are both share classes of the same BlackRock fund, so they
 *  share a name/coinId and merge into one slice when both carry a balance. */
const BUIDL_ASSET_CONFIG: UsdtbAssetConfig = {
  name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)",
  risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low",
  coinId: "buidl-blackrock",
};

const USDTB_ASSET_CONFIG: Record<string, UsdtbAssetConfig> = {
  BUIDL: BUIDL_ASSET_CONFIG,
  "BUIDL-I": BUIDL_ASSET_CONFIG,
  USDC: {
    name: "USDC cash-equivalent reserves",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
    coinId: "usdc-circle",
  },
  USDT: {
    name: "USDT cash-equivalent reserves",
    risk: getCanonicalReserveAssetRisk("USDT") ?? "low",
    coinId: "usdt-tether",
  },
};

/** USDtb's own self-holdings are self-referential (not external backing) and
 *  are excluded from the reserve mix entirely. */
const SELF_HOLDING_KEY = "USDTB";

function sumAssetAmount(entries: UsdtbBackingAssetEntry[] | undefined): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((total, entry) => {
    const amount = typeof entry?.amount === "number" && Number.isFinite(entry.amount) ? entry.amount : 0;
    return total + Math.max(0, amount);
  }, 0);
}

function parseFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export function adaptUsdtbTransparency(payload: UsdtbBackingAndSupplyPayload): AdapterResult {
  const backingAssets = payload.backingAssets;
  if (!backingAssets || typeof backingAssets !== "object") {
    throw new Error("usdtb-transparency payload missing backingAssets");
  }

  const supplyUsd = parseFiniteNumber(payload.supply);
  if (!(supplyUsd > 0)) {
    throw new Error("usdtb-transparency payload has invalid supply");
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.lastUpdatedAt);
  if (sourceTimestamp == null) {
    throw new Error("usdtb-transparency payload has an unreadable lastUpdatedAt");
  }

  const warnings: LiveReserveWarning[] = [];
  const sliceInputs: Array<{ value: number; name: string; risk: ReserveSlice["risk"]; coinId?: string }> = [];

  for (const [assetKey, entries] of Object.entries(backingAssets)) {
    const amount = sumAssetAmount(entries);
    const normalizedKey = assetKey.trim().toUpperCase();

    if (normalizedKey === SELF_HOLDING_KEY) {
      if (amount > 0) {
        warnings.push(reserveInfoWarning(
          "usdtb-self-holding-excluded",
          `USDtb backing payload reports ${amount.toFixed(2)} self-held USDtb; excluded from backing as self-referential`,
        ));
      }
      continue;
    }

    if (amount <= 0) continue;

    const config = USDTB_ASSET_CONFIG[normalizedKey];
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-asset",
        `Unmapped USDtb backing asset: ${assetKey} ($${amount.toFixed(2)})`,
      ));
      sliceInputs.push({ name: `${assetKey} (unmapped)`, value: amount, risk: "high" });
      continue;
    }

    sliceInputs.push({ name: config.name, value: amount, risk: config.risk, coinId: config.coinId });
  }

  const assetsInMotionUsd = Math.max(0, parseFiniteNumber(payload.assetsInMotion) || 0);
  if (assetsInMotionUsd > 0) {
    sliceInputs.push({ name: "Assets in motion (settlement float)", value: assetsInMotionUsd, risk: "low" });
  }

  if (sliceInputs.length === 0) {
    throw new Error("usdtb-transparency payload contained no positive backing asset amounts");
  }

  const totalReserveUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      details: { lastUpdatedAt: payload.lastUpdatedAt },
    },
  };
}

export async function fetchUsdtbTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "usdtb-transparency");
  const payload = await fetchJsonWithRetry<UsdtbBackingAndSupplyPayload>(input.url, signal, 12_000, ctx);
  return adaptUsdtbTransparency(payload);
}
