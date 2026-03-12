import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterResult } from "./index";
import { requireJsonInput, fetchJsonWithRetry, normalizeSlices } from "./helpers";

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
  tBTC: { risk: "medium" },
  WBTC: { risk: "medium" },
};

export function adaptAsymmetry(payload: AsymmetryPayload): ReserveSlice[] {
  const branches = payload.usdaf?.branch ?? {};
  const entries = Object.entries(branches)
    .map(([name, stats]) => ({
      name,
      usd: Number(stats.coll_value ?? "0"),
    }))
    .filter((entry) => Number.isFinite(entry.usd) && entry.usd > 0);

  const total = entries.reduce((acc, entry) => acc + entry.usd, 0);
  if (total <= 0) return [];

  return normalizeSlices(
    entries.map((entry) => {
      const config = BRANCH_RISK_MAP[entry.name] ?? { risk: "medium" as const };
      return {
        name: entry.name,
        pct: (entry.usd / total) * 100,
        risk: config.risk,
        ...(config.coinId ? { coinId: config.coinId } : {}),
        ...(config.depType ? { depType: config.depType } : {}),
      };
    }),
  );
}

export async function fetchAsymmetryReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "asymmetry");
  const payload = await fetchJsonWithRetry<AsymmetryPayload>(input.url, signal);
  return {
    slices: adaptAsymmetry(payload),
  };
}
