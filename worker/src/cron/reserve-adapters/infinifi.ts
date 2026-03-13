import type { LiveReservesConfig, LiveReserveWarning, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, isHttpJsonInput, normalizeSlices } from "./helpers";

interface InfiniFiFarm {
  name: string;
  label: string;
  assetsNormalized: number;
  type: "LIQUID" | "ILLIQUID" | "PROTOCOL";
  underlyingAssetSymbol: string;
}

export interface InfiniFiProtocolData {
  code: string;
  data: {
    stats: {
      asset: {
        totalTVLAssetNormalized: number;
        totalLiquidAssetNormalized?: number;
        totalIlliquidAssetNormalized?: number;
        pendingRedemptionsAssetNormalized?: number;
      };
    };
    receipt?: {
      totalSupplyNormalized?: number;
    };
    farms: InfiniFiFarm[];
  };
}

interface FarmRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

const FARM_RISK_MAP: Record<string, FarmRiskConfig> = {
  "fasanara-rwa-farm":       { risk: "high" },
  "fasanara-gdaf":           { risk: "high" },
  "falconx-farm":            { risk: "high" },
  "morpho-v2-sentora-pyusd": { risk: "high" },
  "maple-farm-institutional": { risk: "high" },
  "maple-farm-syrup":        { risk: "high" },
  "spark-sUSDC-refcode":     { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "fluid-fUSDC":             { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3":                  { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3-horizon-usdc":     { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3-rlusd-farm":       { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "euler-sentora-usdc":      { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "morpho-steakUSDCinfinifi": { risk: "medium" },
  "capfarm":                 { risk: "medium" },
  "tokemak-autoUSD":         { risk: "medium" },
  "gauntlet-alpha-farm":     { risk: "medium" },
  "reservoir-wsrUSD":        { risk: "medium" },
  "sGHO":                    { risk: "medium" },
};

export interface AdaptInfiniFiResult {
  slices: ReserveSlice[];
  /** Farm names not found in FARM_RISK_MAP (for operator awareness). */
  unknownFarms: string[];
}

/** Convert raw InfiniFi protocol data to ReserveSlice[]. Pure function — no I/O. */
export function adaptInfiniFi(payload: InfiniFiProtocolData): AdaptInfiniFiResult {
  const tvl = payload.data.stats.asset.totalTVLAssetNormalized;
  if (!tvl || tvl <= 0) return { slices: [], unknownFarms: [] };

  const activeFarms = payload.data.farms.filter(
    (f) => f.type !== "PROTOCOL" && f.assetsNormalized > 0,
  );

  const unknownFarms: string[] = [];

  const rawSlices: ReserveSlice[] = [];

  for (const f of activeFarms) {
    const pct = Math.round((f.assetsNormalized / tvl) * 100);
    if (pct <= 0) continue;
    const config = FARM_RISK_MAP[f.name];
    if (!config) unknownFarms.push(f.name);
    const risk: ReserveSlice["risk"] = config?.risk
      ?? (f.type === "LIQUID" ? "low" : "medium");
    rawSlices.push({
      name: f.label,
      pct,
      risk,
      ...(config?.coinId ? { coinId: config.coinId } : {}),
      ...(config?.depType ? { depType: config.depType } : {}),
    } satisfies ReserveSlice);
  }

  return { slices: normalizeSlices(rawSlices), unknownFarms };
}

/** Fetch + adapt infiniFi protocol data. Uses fetchWithRetry for resilience. */
export async function fetchInfiniFiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = config.inputs.primary;
  if (!isHttpJsonInput(primaryInput)) {
    throw new Error("infiniFi adapter requires an http-json primary input");
  }

  const url = primaryInput.url;
  const payload = await fetchJsonWithRetry<InfiniFiProtocolData>(url, signal);
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  const adapted = adaptInfiniFi(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownFarms.map((farmName) => ({
    code: "unknown-position",
    message: `Unmapped reserve position: ${farmName}`,
    severity: "warning",
  }));

  const totalReserveUsd = payload.data.stats.asset.totalTVLAssetNormalized;
  const immediateRedeemableUsd =
    payload.data.stats.asset.totalLiquidAssetNormalized ?? 0;
  const illiquidReserveUsd =
    payload.data.stats.asset.totalIlliquidAssetNormalized ?? 0;

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      farmCount: payload.data.farms.length,
      activeFarmCount: adapted.slices.length,
      unknownFarmCount: adapted.unknownFarms.length,
      totalReserveUsd,
      immediateRedeemableUsd,
      illiquidReserveUsd,
      immediateRedeemableRatio:
        totalReserveUsd > 0
          ? immediateRedeemableUsd / totalReserveUsd
          : null,
      pendingRedemptionsUsd:
        payload.data.stats.asset.pendingRedemptionsAssetNormalized,
      supplyUsd: payload.data.receipt?.totalSupplyNormalized,
    },
  };
}
