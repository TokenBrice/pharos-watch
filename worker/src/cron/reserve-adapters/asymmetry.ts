import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  assertFiniteNonNegativeReserveRows,
  freshnessMetadataFromTimestamp,
  requireJsonInput,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
} from "./helpers";

interface AsymmetryBranchStats {
  coll_value?: string;
}

interface AsymmetryPayload {
  timestamp?: string | number;
  usdaf?: {
    total_bold_supply?: string;
    branch?: Record<string, AsymmetryBranchStats>;
  };
}

interface BranchRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

const BRANCH_RISK_MAP: Record<string, BranchRiskConfig> = {
  ysybold: { risk: "medium", coinId: "bold-liquity", depType: "collateral" },
  scrvusd: { risk: "medium", coinId: "scrvusd-curve", depType: "collateral" },
  susds: { risk: "low", coinId: "susds-sky", depType: "collateral" },
  sfrxusd: { risk: "medium", coinId: "sfrxusd-frax", depType: "collateral" },
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
  const branchRows = Object.entries(branches).map(([name, stats]) => ({
    name,
    usd: Number(stats.coll_value ?? "0"),
  }));
  assertFiniteNonNegativeReserveRows(branchRows, (entry) => entry.usd, "Asymmetry branch collateral");
  const entries = branchRows.filter((entry) => entry.usd > 0);

  const total = entries.reduce((acc, entry) => acc + entry.usd, 0);
  const supply = Number(payload.usdaf?.total_bold_supply);
  if (!Number.isFinite(supply) || supply <= 0) {
    throw new Error("Asymmetry missing or invalid usdaf.total_bold_supply");
  }
  if (total <= 0) return { slices: [] };

  // Clamp redemption capacity to the lesser of declared supply and measured
  // collateral; surface under-collateralization explicitly.
  const capacityUsd = Math.min(supply, total);
  const capacityRatioOfSupply = capacityUsd / supply;
  if (supply > total) {
    warnings.push(reserveDegradedWarning(
      "under-collateralization",
      `Asymmetry branch collateral (${total.toFixed(0)}) covers only ${((total / supply) * 100).toFixed(2)}% of BOLD supply`,
    ));
  }

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
          sourceKey: `asymmetry:${normalizeBranchKey(entry.name)}`,
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
      unknownBranchCount: warnings.filter((w) => w.code === "unknown-branch").length,
      unknownExposurePct: total > 0 ? (unknownExposureUsd / total) * 100 : 0,
      totalReserveUsd: total,
      supplyUsd: supply,
      collateralizationRatio: total / supply,
      redemption: {
        capacityUsd,
        capacityRatioOfSupply,
        capacityKind: "live-direct-bounded",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "same-run-api",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://app.asymmetry.finance/api/stats",
          "https://docs.asymmetry.finance/usdaf-stablecoin/redemptions",
        ],
      },
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "protocol-branch-api",
        "Asymmetry branch composition payload does not expose a trustworthy source timestamp",
      ),
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
