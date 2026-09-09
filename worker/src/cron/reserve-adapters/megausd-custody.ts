import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";

interface MegausdBackingAssetEntry {
  /** USD amount; numeric strings are deliberately supported and converted. */
  amount?: number | string;
  custodian?: string;
}

export interface MegausdBackingAndSupplyPayload {
  backingAssets?: Record<string, MegausdBackingAssetEntry[]>;
  lastUpdatedAt?: string;
  supply?: number | string;
}

interface MegausdAssetConfig {
  name: string;
  risk: ReserveSlice["risk"];
  coinId: string;
}

/** MegaUSD's reviewed custodian inventory holds only USDC and USDtb as external
 *  backing. USDtb is the Ethena wrapper token whose own reserve is BUIDL-backed;
 *  its canonical risk is not in the symbol map, so it resolves to low. */
const MEGAUSD_ASSET_CONFIG: Record<string, MegausdAssetConfig> = {
  USDC: {
    name: "USDC cash-equivalent reserves",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
    coinId: "usdc-circle",
  },
  USDTB: {
    name: "USDtb cash-equivalent reserves",
    risk: getCanonicalReserveAssetRisk("USDTB") ?? "low",
    coinId: "usdtb-ethena",
  },
};

/** USDm's own self-holdings are self-referential (not external backing) and are
 *  excluded from the reserve mix entirely. */
const SELF_HOLDING_KEY = "USDM";

/** Strict amount parser shared by asset rows: finite numbers pass through,
 *  numeric strings are converted, and anything else throws so a malformed
 *  payload can never silently read as zero. */
function parseStrictAmount(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`megausd-custody ${label} is not a finite number: ${String(value)}`);
}

function sumAssetAmount(assetKey: string, entries: MegausdBackingAssetEntry[] | undefined): number {
  if (!Array.isArray(entries)) {
    throw new Error(`megausd-custody backing asset ${assetKey} entry list is not an array`);
  }
  return entries.reduce((total, entry, index) => {
    const amount = parseStrictAmount(entry?.amount, `backing asset ${assetKey} entry ${index} amount`);
    if (amount < 0) {
      throw new Error(`megausd-custody backing asset ${assetKey} entry ${index} has a negative amount`);
    }
    return total + amount;
  }, 0);
}

export function adaptMegausdCustody(payload: MegausdBackingAndSupplyPayload): AdapterResult {
  const backingAssets = payload.backingAssets;
  if (!backingAssets || typeof backingAssets !== "object") {
    throw new Error("megausd-custody payload missing backingAssets");
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.lastUpdatedAt);
  if (sourceTimestamp == null) {
    throw new Error("megausd-custody payload has an unreadable lastUpdatedAt");
  }

  const warnings: LiveReserveWarning[] = [];
  const sliceInputs: Array<{ value: number; sourceKey: string; name: string; risk: ReserveSlice["risk"]; coinId?: string }> = [];

  for (const [assetKey, entries] of Object.entries(backingAssets)) {
    const amount = sumAssetAmount(assetKey, entries);
    const normalizedKey = assetKey.trim().toUpperCase();

    if (normalizedKey === SELF_HOLDING_KEY) {
      if (amount > 0) {
        warnings.push(reserveInfoWarning(
          "megausd-self-holding-excluded",
          `MegaUSD backing payload reports ${amount.toFixed(2)} self-held USDm; excluded from backing as self-referential`,
        ));
      }
      continue;
    }

    if (amount <= 0) continue;

    const config = MEGAUSD_ASSET_CONFIG[normalizedKey];
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-asset",
        `Unmapped MegaUSD backing asset: ${assetKey} ($${amount.toFixed(2)})`,
      ));
      sliceInputs.push({ sourceKey: `megausd-custody:${normalizedKey.toLowerCase()}`, name: `${assetKey} (unmapped)`, value: amount, risk: "high" });
      continue;
    }

    sliceInputs.push({ sourceKey: `megausd-custody:${normalizedKey.toLowerCase()}`, name: config.name, value: amount, risk: config.risk, coinId: config.coinId });
  }

  if (sliceInputs.length === 0) {
    throw new Error("megausd-custody payload contained no positive backing asset amounts");
  }

  const totalReserveUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd,
      details: { lastUpdatedAt: payload.lastUpdatedAt },
    },
  };
}

export async function fetchMegausdCustodyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<MegausdBackingAndSupplyPayload>(config, "megausd-custody", signal, 12_000, ctx);
  return adaptMegausdCustody(payload);
}
