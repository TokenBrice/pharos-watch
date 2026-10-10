import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings, fetchJsonAdapterInput, parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning, reserveInfoWarning, slicesFromValues, strictAmountParser,
  sumBackingAssetAmounts, verifiedFreshnessMetadata,
} from "./helpers";

type Asset = { name: string; risk: ReserveSlice["risk"]; coinId: string; sourceKey?: string };
export interface BackingAndSupplyPayload {
  /** USD amounts; numeric strings are deliberately supported and converted. */
  backingAssets?: Record<string, Array<{ amount?: number | string; custodian?: string }>>;
  assetsInMotion?: number | string;
  lastUpdatedAt?: string;
  supply?: number | string;
}
type CustodyProfile = {
  key: "megausd-custody" | "usdtb-transparency";
  displayName: string;
  selfToken: string;
  selfTokenName: string;
  selfWarningCode: string;
  liability: "ignored" | "payload-global-supply";
  assets: Record<string, Asset>;
};
// BUIDL's two share classes merge into the same reviewed fund slice.
const BUIDL: Asset = {
  name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)",
  risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low",
  coinId: "buidl-blackrock", sourceKey: "usdtb-transparency:buidl",
};
const CUSTODY_PROFILES: Record<CustodyProfile["key"], CustodyProfile> = {
  "megausd-custody": {
    key: "megausd-custody", displayName: "MegaUSD", selfToken: "USDM", selfTokenName: "USDm",
    selfWarningCode: "megausd-self-holding-excluded", liability: "ignored",
    // The reported MegaUSD supply is local, not a tracked global liability.
    assets: {
      USDC: { name: "USDC cash-equivalent reserves", risk: getCanonicalReserveAssetRisk("USDC") ?? "low", coinId: "usdc-circle" },
      USDTB: { name: "USDtb cash-equivalent reserves", risk: getCanonicalReserveAssetRisk("USDTB") ?? "low", coinId: "usdtb-ethena" },
    },
  },
  "usdtb-transparency": {
    key: "usdtb-transparency", displayName: "USDtb", selfToken: "USDTB", selfTokenName: "USDtb",
    selfWarningCode: "usdtb-self-holding-excluded", liability: "payload-global-supply",
    assets: {
      BUIDL, "BUIDL-I": BUIDL,
      USDC: { name: "USDC cash-equivalent reserves", risk: getCanonicalReserveAssetRisk("USDC") ?? "low", coinId: "usdc-circle", sourceKey: "usdtb-transparency:usdc" },
      USDT: { name: "USDT cash-equivalent reserves", risk: getCanonicalReserveAssetRisk("USDT") ?? "low", coinId: "usdt-tether", sourceKey: "usdtb-transparency:usdt" },
    },
  },
};

export function adaptCustodyInventory(key: CustodyProfile["key"], payload: BackingAndSupplyPayload): AdapterResult {
  const profile = CUSTODY_PROFILES[key];
  const backingAssets = payload.backingAssets;
  if (!backingAssets || typeof backingAssets !== "object") throw new Error(`${key} payload missing backingAssets`);
  const parseAmount = strictAmountParser(key);
  const supplyUsd = profile.liability === "payload-global-supply" ? parseAmount(payload.supply, "supply") : null;
  if (supplyUsd != null && !(supplyUsd > 0)) throw new Error(`${key} payload has invalid supply`);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.lastUpdatedAt);
  if (sourceTimestamp == null) throw new Error(`${key} payload has an unreadable lastUpdatedAt`);
  const warnings: LiveReserveWarning[] = [];
  const sliceInputs: Array<{ value: number; sourceKey: string; name: string; risk: ReserveSlice["risk"]; coinId?: string; depType?: ReserveSlice["depType"] }> = [];
  for (const [assetKey, entries] of Object.entries(backingAssets)) {
    const amount = sumBackingAssetAmounts(key, assetKey, entries);
    const normalizedKey = assetKey.trim().toUpperCase();
    if (normalizedKey === profile.selfToken) {
      if (amount > 0) warnings.push(reserveInfoWarning(profile.selfWarningCode,
        `${profile.displayName} backing payload reports ${amount.toFixed(2)} self-held ${profile.selfTokenName}; excluded from backing as self-referential`));
      continue;
    }
    if (amount <= 0) continue;
    const config = profile.assets[normalizedKey];
    const sourceKey = config?.sourceKey ?? `${key}:${normalizedKey.toLowerCase()}`;
    if (!config) {
      warnings.push(reserveDegradedWarning("unknown-asset", `Unmapped ${profile.displayName} backing asset: ${assetKey} ($${amount.toFixed(2)})`));
      sliceInputs.push({ sourceKey, name: `${assetKey} (unmapped)`, value: amount, risk: "high" });
    } else {
      sliceInputs.push({ sourceKey, name: config.name, value: amount, risk: config.risk, coinId: config.coinId, depType: "collateral" });
    }
  }
  if (profile.liability === "payload-global-supply") {
    const assetsInMotionUsd = payload.assetsInMotion != null ? parseAmount(payload.assetsInMotion, "assetsInMotion") : 0;
    if (assetsInMotionUsd < 0) throw new Error(`${key} assetsInMotion is negative`);
    if (assetsInMotionUsd > 0) sliceInputs.push({ sourceKey: `${key}:assets-in-motion`, name: "Assets in motion (settlement float)", value: assetsInMotionUsd, risk: "low" });
  }
  if (sliceInputs.length === 0) throw new Error(`${key} payload contained no positive backing asset amounts`);
  const totalReserveUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);
  const collateralizationRatio = supplyUsd != null ? totalReserveUsd / supplyUsd : null;
  if (collateralizationRatio != null) warnings.push(...buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    coverageRatio: collateralizationRatio,
    message: (coveragePct) => `${profile.displayName} backing including assets in motion covers ${coveragePct}% of supply`,
  }));
  return {
    slices: slicesFromValues(sliceInputs), ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp), totalReserveUsd,
      ...(supplyUsd != null && collateralizationRatio != null ? { supplyUsd, collateralizationRatio } : {}),
      details: { lastUpdatedAt: payload.lastUpdatedAt },
    },
  };
}
export async function fetchCustodyInventoryReserves(
  _coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const key = config.adapter as CustodyProfile["key"];
  const payload = await fetchJsonAdapterInput<BackingAndSupplyPayload>(config, key, signal, 12_000, ctx);
  return adaptCustodyInventory(key, payload);
}
