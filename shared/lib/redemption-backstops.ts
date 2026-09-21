import { TRACKED_META_BY_ID } from "./stablecoins/registry";
import { REDEMPTION_BACKSTOP_CONFIGS } from "./redemption-backstop-configs";
import type { ExitRouteOutput } from "../types/exit-route";
import type { RedemptionBackstopConfig } from "./redemption-backstop-configs/shared";

export { REDEMPTION_BACKSTOP_CONFIGS };

/**
 * Canonical non-tracked collateral identities reviewed in redemption configs.
 * The config registry is the authority for this namespace; consumers must not
 * infer a tracked stablecoin id from an `asset:<symbol>` key.
 */
export const REVIEWED_REDEMPTION_COLLATERAL_ASSET_KEYS: ReadonlySet<string> = new Set(
  Object.values(REDEMPTION_BACKSTOP_CONFIGS).flatMap((config) =>
    (config.outputAssetType === "bluechip-collateral" || config.outputAssetType === "mixed-collateral"
      ? config.outputAssets ?? []
      : []
    ).filter((key) => key.startsWith("asset:")),
  ),
);

export interface RedemptionOutputIdentityIssue {
  code:
    | "unknown-tracked-output-id"
    | "unknown-collateral-output-key"
    | "undeclared-unresolved-output-key"
    | "output-identity-mismatch";
  key?: string;
}

function sameOutputIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((key, index) => key === sortedRight[index]);
}

/**
 * Enforce output identities at the route/review boundary. Tracked outputs use
 * stablecoin ids; collateral outputs use reviewed `asset:*` identities; an
 * unresolved output may only carry keys explicitly preserved by its config.
 */
export function validateRedemptionOutputIdentity(
  stablecoinId: string,
  output: ExitRouteOutput,
): RedemptionOutputIdentityIssue[] {
  const config = REDEMPTION_BACKSTOP_CONFIGS[stablecoinId];
  const issues: RedemptionOutputIdentityIssue[] = [];
  if (output.kind === "tracked-stablecoin") {
    for (const key of output.trackedAssetIds ?? []) {
      if (!TRACKED_META_BY_ID.has(key)) issues.push({ code: "unknown-tracked-output-id", key });
    }
    const expected = config?.outputAssets ?? [];
    if (expected.length > 0 && !sameOutputIdentitySet(output.trackedAssetIds ?? [], expected)) {
      issues.push({ code: "output-identity-mismatch" });
    }
  } else if (output.kind === "collateral") {
    for (const key of output.assetKeys ?? []) {
      if (!REVIEWED_REDEMPTION_COLLATERAL_ASSET_KEYS.has(key)) {
        issues.push({ code: "unknown-collateral-output-key", key });
      }
    }
    const expected = config?.outputAssets ?? [];
    if (expected.length > 0 && !sameOutputIdentitySet(output.assetKeys ?? [], expected)) {
      issues.push({ code: "output-identity-mismatch" });
    }
  } else if (output.kind === "unresolved-asset") {
    const declared = config?.unresolvedOutputAssetKeys ?? [];
    for (const key of output.assetKeys ?? []) {
      if (!declared.includes(key)) issues.push({ code: "undeclared-unresolved-output-key", key });
    }
    if (declared.length > 0 && !sameOutputIdentitySet(output.assetKeys ?? [], declared)) {
      issues.push({ code: "output-identity-mismatch" });
    }
  }
  return issues;
}

export function validateRedemptionBackstopConfigOutputIdentity(
  config: Pick<RedemptionBackstopConfig, "outputAssetType" | "outputAssets">,
): RedemptionOutputIdentityIssue[] {
  const issues: RedemptionOutputIdentityIssue[] = [];
  if (
    (config.outputAssetType === "stable-single" || config.outputAssetType === "stable-basket") &&
    config.outputAssets
  ) {
    for (const key of config.outputAssets) {
      if (!TRACKED_META_BY_ID.has(key)) issues.push({ code: "unknown-tracked-output-id", key });
    }
  }
  if (
    (config.outputAssetType === "bluechip-collateral" || config.outputAssetType === "mixed-collateral") &&
    config.outputAssets
  ) {
    for (const key of config.outputAssets) {
      if (!REVIEWED_REDEMPTION_COLLATERAL_ASSET_KEYS.has(key)) {
        issues.push({ code: "unknown-collateral-output-key", key });
      }
    }
  }
  return issues;
}

export {
  resolveMoreConservativeRedemptionSettlement,
  resolveReviewedRedemptionSettlement,
  resolveV9RedemptionRouteCostBpsAtNotional,
} from "./redemption-backstop-configs/shared";
export type { RedemptionBackstopConfig, RedemptionCapacityModel, RedemptionCostModel } from "./redemption-backstop-configs/shared";

for (const stablecoinId of Object.keys(REDEMPTION_BACKSTOP_CONFIGS)) {
  if (!TRACKED_META_BY_ID.has(stablecoinId)) {
    throw new Error(`Unknown redemption backstop config id "${stablecoinId}"`);
  }
}

export function getRedemptionBackstopConfig(stablecoinId: string): RedemptionBackstopConfig | null {
  return REDEMPTION_BACKSTOP_CONFIGS[stablecoinId] ?? null;
}

export function getConfiguredRedemptionBackstopIds(): string[] {
  return Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
}
