import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterResult } from "./types";
import { requireJsonInput, fetchJsonWithRetry, getAdapterTimeout, normalizeSlices } from "./helpers";

interface AsymmetryBranchStats {
  coll_value?: string;
}

interface AsymmetryPayload {
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
  ysyBOLD: { risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
  scrvUSD: { risk: "medium", coinId: "crvusd-curve", depType: "wrapper" },
  sUSDS: { risk: "low", coinId: "usds-sky", depType: "wrapper" },
  sfrxUSD: { risk: "medium", coinId: "frax-frax", depType: "wrapper" },
  tBTC: { risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" },
  WBTC: { risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" },
};

export function adaptAsymmetry(payload: AsymmetryPayload): AdapterResult {
  const branches = payload.usdaf?.branch ?? {};
  const warnings: LiveReserveWarning[] = [];
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
        const config = BRANCH_RISK_MAP[entry.name] ?? { risk: "medium" as const };
        if (!(entry.name in BRANCH_RISK_MAP)) {
          warnings.push({
            code: "unknown-branch",
            message: `Asymmetry branch defaulted to medium risk: ${entry.name}`,
            severity: "warning",
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
  };
}

export async function fetchAsymmetryReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "asymmetry");
  const payload = await fetchJsonWithRetry<AsymmetryPayload>(input.url, signal, getAdapterTimeout(config, 12_000));
  return adaptAsymmetry(payload);
}
