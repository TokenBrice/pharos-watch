import type { LiveReserveWarning } from "../../types/live-reserves";
import type { RedemptionLiveFreshnessKind } from "../../types/redemption";

export type RedemptionBackstopPolicyKind =
  | "unverified-freshness"
  | "legacy-freshness-bridge"
  | "degraded-sync-warning-exception"
  | "unused-live-redemption-telemetry";

interface RedemptionBackstopPolicyBase {
  kind: RedemptionBackstopPolicyKind;
  stablecoinId: string;
  reason: string;
  owner: string;
  reviewedAt: string;
}

export interface RedemptionFreshnessPolicyEntry extends RedemptionBackstopPolicyBase {
  kind: "unverified-freshness" | "legacy-freshness-bridge";
}

export interface RedemptionDegradedSyncWarningPolicyEntry extends RedemptionBackstopPolicyBase {
  kind: "degraded-sync-warning-exception";
  warningCode: LiveReserveWarning["code"];
  capacityNote: string;
}

export interface RedemptionUnusedTelemetryPolicyEntry extends RedemptionBackstopPolicyBase {
  kind: "unused-live-redemption-telemetry";
}

export type RedemptionBackstopPolicyEntry =
  | RedemptionFreshnessPolicyEntry
  | RedemptionDegradedSyncWarningPolicyEntry
  | RedemptionUnusedTelemetryPolicyEntry;

const POLICY_OWNER = "redemption-backstop-v4";

const SCOREABLE_REDEMPTION_FRESHNESS_KINDS = new Set<RedemptionLiveFreshnessKind>([
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
  "reviewed-static",
]);

export const REDEMPTION_BACKSTOP_POLICY_ENTRIES = [
  {
    kind: "unverified-freshness",
    stablecoinId: "frxusd-frax",
    reason: "Frax redemption telemetry is sourced from protocol reserve state but lacks a verified source timestamp.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "unverified-freshness",
    stablecoinId: "iusd-infinifi",
    reason: "InfiniFi exposes reviewed reserve-backed redemption telemetry without a source timestamp guarantee.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "unverified-freshness",
    stablecoinId: "usdf-falcon",
    reason: "Falcon redemption telemetry is reviewed as a direct reserve proxy while freshness remains unverified.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "unverified-freshness",
    stablecoinId: "wsrusd-reservoir",
    reason: "Reservoir wrapped sRUSD telemetry inherits reviewed reserve state without verified timestamp metadata.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "legacy-freshness-bridge",
    stablecoinId: "zchf-frankencoin",
    reason: "Legacy live-reserve bridge metadata predates nested redemption freshness fields.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "degraded-sync-warning-exception",
    stablecoinId: "gho-aave",
    warningCode: "aggregated-residual-issuance",
    capacityNote:
      "Using tracked live GSM backing as a lower-bound redemption capacity despite aggregated residual issuance outside configured GSM modules",
    reason:
      "GHO GSM telemetry remains a reviewed lower-bound redemption capacity when the only degraded warning is residual issuance outside the tracked GSM modules.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "ousd-origin-protocol",
    reason:
      "Origin vault balance telemetry is available, but OUSD redemption terms still require route review before replacing the documented eventual full-supply model.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "sgho-aave",
    reason:
      "sGHO wrapper telemetry describes wrapper liquidity; the configured route remains documented eventual until wrapper-to-GHO redemption and downstream GHO exit semantics are reviewed together.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "ybold-yearn",
    reason:
      "ERC-4626 idle-underlying telemetry exists, but yBOLD redemption capacity needs Yearn vault-specific review before promoting from documented eventual modeling.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "cjpy-yamato",
    reason:
      "Yamato adapter telemetry exists, but CJPY redemption modeling needs protocol-specific validation before it can replace the documented collateral-redemption route.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "fpi-frax",
    reason:
      "FPI collateral telemetry is available as a proxy; the route remains documented eventual pending review of the proxy's executable redemption bound.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "frax-frax",
    reason:
      "FRAX has live balance-sheet telemetry but no configured public redemption backstop yet; coverage remains explicitly waived until the active asset is reviewed for route eligibility.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "rusd-reservoir",
    reason:
      "Reservoir RUSD telemetry exists, but the active direct asset is not yet configured; wrapped Reservoir routes stay covered separately while this route is reviewed.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "gramg-token-teknoloji",
    reason:
      "Single-asset live-reserve metadata is fee-only for redemption modeling, so no executable-capacity redemption route is configured yet.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "grams-token-teknoloji",
    reason:
      "Single-asset live-reserve metadata is fee-only for redemption modeling, so no executable-capacity redemption route is configured yet.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "ggbr-goldfish-gold",
    reason:
      "Single-asset live-reserve metadata is fee-only for redemption modeling, so no executable-capacity redemption route is configured yet.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "pht-pht",
    reason:
      "Single-asset live-reserve metadata is fee-only for redemption modeling, so no executable-capacity redemption route is configured yet.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  ...[
    "apyusd-apyx",
    "cusdo-openeden",
    "fxsave-f-x-protocol",
    "gtusdc-gauntlet",
    "gtusdcp-gauntlet",
    "msy-main-street",
    "said-gaib",
    "savusd-avant",
    "sbold-k3-capital",
    "srusde-strata",
    "steakusdc-steakhouse",
    "steakusdt-steakhouse",
    "stkgho-umbrella-aave",
    "stusds-sky",
    "susdd-tron-dao-reserve",
    "susde-ethena",
    "susn-noon",
    "syrupusdc-maple",
    "syrupusdt-maple",
    "syusd-aegis",
    "syzusd-yuzu",
    "yousd-yield-optimizer",
    "yusd-yieldfi",
    "yvusdc-yearn",
  ].map((stablecoinId) => ({
    kind: "unused-live-redemption-telemetry" as const,
    stablecoinId,
    reason:
      "ERC-4626-style idle-underlying telemetry exists, but the route remains on documented static modeling until the asset-specific wrapper exit and downstream redemption-capacity treatment are reviewed for reserve-sync scoring.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  })),
  ...["ebusd-ebisu", "nect-beraborrow", "usdk-orki"].map((stablecoinId) => ({
    kind: "unused-live-redemption-telemetry" as const,
    stablecoinId,
    reason:
      "Liquity v2 branch telemetry exists, but the route remains on documented full-system collateral redemption until branch-level debt capacity is reviewed for this asset.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  })),
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "deuro-deuro",
    reason:
      "Collateral-position telemetry exists, but DEURO remains modeled as documented full-system collateral redemption until current executable capacity treatment is reviewed.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "ussd-sonic-labs",
    reason:
      "Frax balance-sheet proxy telemetry exists, but USSD remains modeled as documented collateral redemption until Sonic-specific proxy capacity semantics are reviewed.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-23",
  },
] as const satisfies readonly RedemptionBackstopPolicyEntry[];

const UNVERIFIED_FRESHNESS_APPROVALS = new Set<string>(
  REDEMPTION_BACKSTOP_POLICY_ENTRIES.filter((entry) => entry.kind === "unverified-freshness").map(
    (entry) => entry.stablecoinId,
  ),
);

const LEGACY_FRESHNESS_BRIDGE_APPROVALS = new Set<string>(
  REDEMPTION_BACKSTOP_POLICY_ENTRIES.filter((entry) => entry.kind === "legacy-freshness-bridge").map(
    (entry) => entry.stablecoinId,
  ),
);

const DEGRADED_SYNC_WARNING_APPROVALS = new Map<string, RedemptionDegradedSyncWarningPolicyEntry>();
const UNUSED_TELEMETRY_APPROVALS = new Map<string, RedemptionUnusedTelemetryPolicyEntry>();
for (const entry of REDEMPTION_BACKSTOP_POLICY_ENTRIES) {
  if (entry.kind === "degraded-sync-warning-exception") {
    DEGRADED_SYNC_WARNING_APPROVALS.set(`${entry.stablecoinId}:${entry.warningCode}`, entry);
  }
  if (entry.kind === "unused-live-redemption-telemetry") {
    UNUSED_TELEMETRY_APPROVALS.set(entry.stablecoinId, entry);
  }
}

export function isRedemptionFreshnessAllowedByPolicy(args: {
  stablecoinId: string;
  freshnessKind: RedemptionLiveFreshnessKind | null;
  hasScoringEligibleFreshness: boolean;
}): boolean {
  if (args.freshnessKind) {
    if (SCOREABLE_REDEMPTION_FRESHNESS_KINDS.has(args.freshnessKind)) return true;
    return args.freshnessKind === "unverified" && UNVERIFIED_FRESHNESS_APPROVALS.has(args.stablecoinId);
  }
  return args.hasScoringEligibleFreshness || LEGACY_FRESHNESS_BRIDGE_APPROVALS.has(args.stablecoinId);
}

export function getAllowedRedemptionCapacityWarningReason(
  stablecoinId: string,
  warning: Pick<LiveReserveWarning, "code" | "effect">,
): string | null {
  if (warning.effect === "info") return null;
  return DEGRADED_SYNC_WARNING_APPROVALS.get(`${stablecoinId}:${warning.code}`)?.capacityNote ?? null;
}

export function getUnusedLiveRedemptionTelemetryPolicy(
  stablecoinId: string,
): RedemptionUnusedTelemetryPolicyEntry | null {
  return UNUSED_TELEMETRY_APPROVALS.get(stablecoinId) ?? null;
}
