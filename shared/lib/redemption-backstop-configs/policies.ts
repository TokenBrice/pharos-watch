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
  RedemptionFreshnessPolicyEntry | RedemptionDegradedSyncWarningPolicyEntry | RedemptionUnusedTelemetryPolicyEntry;

const POLICY_OWNER = "redemption-backstop-v4";

const SCOREABLE_REDEMPTION_FRESHNESS_KINDS = new Set<RedemptionLiveFreshnessKind>([
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
  "reviewed-static",
]);

// TODO(redemption-backstop): live fee telemetry follow-ups. These are stale-risk
// assumptions baked into per-coin cost models that are not yet enforced by a typed
// policy kind above; tracked here so the risk is discoverable in the policy surface
// rather than only in a per-coin note.
//   - eearn-ember: costModel is fixedFee(0, ...) but the eEARN exit/withdrawal fee
//     is admin-configurable on the proxy (verified zero on-chain at review time).
//     If the admin sets a non-zero fee the static 0-bps assumption silently goes
//     wrong. Wire the live proxy fee into telemetry so the cost model tracks it.
//     See stablecoin-redeem/configs.ts.
export const REDEMPTION_BACKSTOP_POLICY_ENTRIES: readonly RedemptionBackstopPolicyEntry[] = [
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
    kind: "degraded-sync-warning-exception",
    stablecoinId: "iusd-infinifi",
    warningCode: "source-total-gap",
    capacityNote:
      "Using InfiniFi's live liquid-farm total as redemption capacity despite unreconciled TVL, which sits entirely in illiquid positions outside the redeemable slice",
    reason:
      "InfiniFi's 7.84% source-total gap ($3.77M at the 2026-08-12 review) is composed wholly of illiquid farm positions the redemption route cannot draw from, while the two liquid farms reconcile to totalLiquidAssetNormalized exactly, so the liquid capacity read stays a reviewed live proxy.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-08-12",
  },
  {
    kind: "degraded-sync-warning-exception",
    stablecoinId: "usdf-falcon",
    warningCode: "unknown-asset",
    capacityNote:
      "Using Falcon's tracked stablecoin reserve bucket as redemption capacity despite an unmapped altcoin in the high-risk 'other' bucket, which does not back the immediate-redeemable stable slice",
    reason:
      "Falcon's stablecoin-bucket redemption capacity stays a reviewed live proxy when the only degraded warning is an unmapped asset in the high-risk 'other' bucket, since that exposure sits outside the immediate-redeemable stable slice the capacity is drawn from.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-06-23",
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
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "deuro-deuro",
    reason:
      "The collateral-positions-api adapter only emits redemption capacity when a redemptionBridge param is configured, and dEURO's liveReservesConfig has none, so a reserve-sync-metadata route would stay permanently unrated; the documented full-system collateral-redemption model remains until a dEURO redemption bridge or capacity feed is wired.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-06-10",
  },
];

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
