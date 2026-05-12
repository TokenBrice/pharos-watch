import type { LiveReserveWarning } from "../../types/live-reserves";
import type { RedemptionLiveFreshnessKind } from "../../types/redemption";

export type RedemptionBackstopPolicyKind =
  | "unverified-freshness"
  | "legacy-freshness-bridge"
  | "degraded-sync-warning-exception";

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

export type RedemptionBackstopPolicyEntry =
  | RedemptionFreshnessPolicyEntry
  | RedemptionDegradedSyncWarningPolicyEntry;

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
for (const entry of REDEMPTION_BACKSTOP_POLICY_ENTRIES) {
  if (entry.kind === "degraded-sync-warning-exception") {
    DEGRADED_SYNC_WARNING_APPROVALS.set(`${entry.stablecoinId}:${entry.warningCode}`, entry);
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
