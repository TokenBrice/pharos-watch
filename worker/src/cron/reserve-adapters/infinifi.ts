import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  fetchJsonWithRetry,
  normalizeSlices,
  requireJsonInputFromConfig,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { cefiPositionMeta, wrapperAssetMeta } from "./wrapper-assets";

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
  blacklistable?: boolean;
}

const FARM_RISK_MAP: Record<string, FarmRiskConfig> = {
  "fasanara-rwa-farm":       { risk: "high", ...cefiPositionMeta() },
  "fasanara-gdaf":           { risk: "high", ...cefiPositionMeta() },
  "falconx-farm":            { risk: "high", ...cefiPositionMeta() },
  "morpho-v2-sentora-pyusd": { risk: "high", ...wrapperAssetMeta("pyusd") },
  "maple-farm-institutional": { risk: "high", ...cefiPositionMeta() },
  "maple-farm-syrup":        { risk: "high", ...wrapperAssetMeta("usdc") },
  "spark-sUSDC-refcode":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "fluid-fUSDC":             { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3":                  { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-horizon-usdc":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-rlusd-farm":       { risk: "low", ...wrapperAssetMeta("usdc") },
  "euler-sentora-usdc":      { risk: "low", ...wrapperAssetMeta("usdc") },
  "morpho-steakUSDCinfinifi": { risk: "medium", ...wrapperAssetMeta("usdc") },
  "capfarm":                 { risk: "medium" },
  SwapFarm:                  { risk: "low" },
  "tokemak-autoUSD":         { risk: "medium" },
  "tokemak-auto-infinifiUSD": { risk: "medium" },
  "gauntlet-alpha-farm":     { risk: "medium" },
  "reservoir-wsrUSD":        { risk: "medium" },
  "sGHO":                    { risk: "medium", ...wrapperAssetMeta("gho") },
};

export interface AdaptInfiniFiResult {
  slices: ReserveSlice[];
  /** Farm names not found in FARM_RISK_MAP (for operator awareness). */
  unknownFarms: string[];
  unknownExposurePct: number;
  activeFarmCount: number;
  immediateRedeemableUsd: number;
  supplyUsd?: number;
}

/** Convert raw InfiniFi protocol data to ReserveSlice[]. Pure function — no I/O. */
export function adaptInfiniFi(payload: InfiniFiProtocolData): AdaptInfiniFiResult {
  const tvl = payload.data.stats.asset.totalTVLAssetNormalized;
  if (!tvl || tvl <= 0) {
    return {
      slices: [],
      unknownFarms: [],
      unknownExposurePct: 0,
      activeFarmCount: 0,
      immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
      ...(payload.data.receipt?.totalSupplyNormalized != null ? { supplyUsd: payload.data.receipt.totalSupplyNormalized } : {}),
    };
  }

  const activeFarms = payload.data.farms.filter(
    (f) => f.type !== "PROTOCOL" && f.assetsNormalized > 0,
  );

  const unknownFarms: string[] = [];
  let unknownExposurePct = 0;

  const rawSlices: ReserveSlice[] = [];

  for (const f of activeFarms) {
    const pct = (f.assetsNormalized / tvl) * 100;
    const config = FARM_RISK_MAP[f.name];
    if (!config) {
      unknownFarms.push(f.name);
      unknownExposurePct += pct;
    }
    const risk: ReserveSlice["risk"] = config?.risk
      ?? (f.type === "LIQUID" ? "low" : "medium");
    rawSlices.push({
      name: f.label,
      pct,
      risk,
      ...(config?.coinId ? { coinId: config.coinId } : {}),
      ...(config?.depType ? { depType: config.depType } : {}),
      ...(config?.blacklistable != null ? { blacklistable: config.blacklistable } : {}),
    } satisfies ReserveSlice);
  }

  return {
    slices: normalizeSlices(rawSlices),
    unknownFarms,
    unknownExposurePct,
    activeFarmCount: activeFarms.length,
    immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
    ...(payload.data.receipt?.totalSupplyNormalized != null ? { supplyUsd: payload.data.receipt.totalSupplyNormalized } : {}),
  };
}

/** Fetch + adapt infiniFi protocol data. Uses fetchWithRetry for resilience. */
export async function fetchInfiniFiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "infinifi");

  const url = primaryInput.url;
  const payload = await fetchJsonWithRetry<InfiniFiProtocolData>(url, signal, 12_000, ctx);
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  const adapted = adaptInfiniFi(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownFarms.length > 0
    ? [buildUnknownExposureWarning({
        code: "unknown-position",
        message: `Unmapped reserve positions: ${adapted.unknownFarms.sort().join(", ")}`,
        unknownExposurePct: adapted.unknownExposurePct,
      })]
    : [];

  const totalReserveUsd = payload.data.stats.asset.totalTVLAssetNormalized;
  const illiquidReserveUsd = payload.data.stats.asset.totalIlliquidAssetNormalized ?? 0;

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      farmCount: payload.data.farms.length,
      activeFarmCount: adapted.activeFarmCount,
      unknownFarmCount: adapted.unknownFarms.length,
      unknownExposurePct: adapted.unknownExposurePct,
      ...unverifiedFreshnessMetadata(
        "protocol-stats-api",
        "InfiniFi protocol stats payload does not expose a trustworthy source timestamp",
      ),
      totalReserveUsd,
      immediateRedeemableUsd: adapted.immediateRedeemableUsd,
      illiquidReserveUsd,
      ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
        ? { immediateRedeemableRatio: adapted.immediateRedeemableUsd / adapted.supplyUsd }
        : {}),
      pendingRedemptionsUsd:
        payload.data.stats.asset.pendingRedemptionsAssetNormalized,
      ...(adapted.supplyUsd != null ? { supplyUsd: adapted.supplyUsd } : {}),
      redemption: {
        capacityUsd: adapted.immediateRedeemableUsd,
        ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
          ? { capacityRatioOfSupply: adapted.immediateRedeemableUsd / adapted.supplyUsd }
          : {}),
        capacityKind: "live-queue" as const,
        freshnessKind: "unverified" as const,
        routeStatus: "unknown" as const,
        ...(payload.data.stats.asset.pendingRedemptionsAssetNormalized != null
          ? { queueDepthUsd: payload.data.stats.asset.pendingRedemptionsAssetNormalized }
          : {}),
        sourceUrls: [url],
      },
    },
  };
}
