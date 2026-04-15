import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  requireJsonInput,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface AsymmetryBranchStats {
  coll_value?: string;
}

interface AsymmetryPayload {
  timestamp?: string | number;
  usdaf?: {
    branch?: Record<string, AsymmetryBranchStats>;
  };
}

interface BranchRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

const BRANCH_RISK_MAP: Record<string, BranchRiskConfig> = {
  ysybold: { risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
  scrvusd: { risk: "medium", coinId: "crvusd-curve", depType: "wrapper" },
  susds: { risk: "low", coinId: "usds-sky", depType: "wrapper" },
  sfrxusd: { risk: "medium", coinId: "frax-frax", depType: "wrapper" },
  tbtc: { risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" },
  wbtc: { risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" },
};

function normalizeBranchKey(name: string): string {
  return name.trim().toLowerCase();
}

export function adaptAsymmetry(payload: AsymmetryPayload): AdapterResult {
  const branches = payload.usdaf?.branch ?? {};
  const warnings: LiveReserveWarning[] = [];
  let unknownExposureUsd = 0;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.timestamp);
  const entries = Object.entries(branches)
    .map(([name, stats]) => ({
      name,
      usd: Number(stats.coll_value ?? "0"),
    }))
    .filter((entry) => Number.isFinite(entry.usd) && entry.usd > 0);

  const total = entries.reduce((acc, entry) => acc + entry.usd, 0);
  if (total <= 0) return { slices: [] };

  return {
    slices: normalizeSlices(
      entries.map((entry) => {
        const config = BRANCH_RISK_MAP[normalizeBranchKey(entry.name)] ?? { risk: "medium" as const };
        if (!(normalizeBranchKey(entry.name) in BRANCH_RISK_MAP)) {
          unknownExposureUsd += entry.usd;
          warnings.push({
            ...reserveDegradedWarning("unknown-branch", `Asymmetry branch defaulted to medium risk: ${entry.name}`),
          });
        }
        return {
          name: entry.name,
          pct: (entry.usd / total) * 100,
          risk: config.risk,
          ...(config.coinId ? { coinId: config.coinId } : {}),
          ...(config.depType ? { depType: config.depType } : {}),
        };
      }),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      branchCount: Object.keys(branches).length,
      activeBranchCount: entries.length,
      unknownBranchCount: warnings.length,
      unknownExposurePct: total > 0 ? (unknownExposureUsd / total) * 100 : 0,
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "protocol-branch-api",
            "Asymmetry branch composition payload does not expose a trustworthy source timestamp",
          )),
    },
  };
}

export async function fetchAsymmetryReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "asymmetry");
  const payload = await fetchJsonWithRetry<AsymmetryPayload>(input.url, signal, 12_000, ctx);
  return adaptAsymmetry(payload);
}
