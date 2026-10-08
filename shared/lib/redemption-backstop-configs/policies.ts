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

export const REDEMPTION_BACKSTOP_POLICY_ENTRIES: readonly RedemptionBackstopPolicyEntry[] = [
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "krusdc-keyrock",
    reason:
      "Arc VaultV2 reserve-derived withdrawal liquidity is not a hash-bound same-notional redeem receipt. The reviewed USDC route deliberately uses an unquantified baseline; only its separately admitted execution observations quantify capacity, and missing or failed execution reads must not fall back to reserve telemetry.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-05",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "steakusdg-steakhouse",
    reason:
      "Robinhood VaultV2 reserve-derived withdrawal liquidity is not a hash-bound same-notional redeem receipt. The reviewed USDG route deliberately uses an unquantified baseline; only its separately admitted execution observations quantify capacity, without substituting idle assets or supply for an actual withdrawal.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-05",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "steakeurcv-steakhouse",
    reason:
      "EURCV-denominated VaultV2 reserve telemetry does not establish same-notional executable USD capacity. The unquantified route requires both a real redeem receipt and fresh admissible EURCV valuation; neither nominal EURCV, USD parity nor reserve telemetry substitutes for those execution inputs.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-05",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "usdr-rise",
    reason:
      "The M-wrapper producer measures native-M backing and a sampled approved-swapper cohort, not executable wM output through the reviewed same-chain holder route. Native-M telemetry must not be attributed to the configured USDR-to-wM route; exact wM output capacity requires separate producer evidence.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-03",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "mantrausd-mantra",
    reason:
      "The M-wrapper producer measures native-M backing and a sampled approved-swapper cohort, not executable wM output through the reviewed same-chain holder route. Native-M telemetry must not be attributed to wM capacity; the route remains source-reviewed unconfigured.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-03",
  },
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
    kind: "legacy-freshness-bridge",
    stablecoinId: "zchf-frankencoin",
    reason: "Legacy live-reserve bridge metadata predates nested redemption freshness fields.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-05-12",
  },
  {
    kind: "degraded-sync-warning-exception",
    stablecoinId: "thusd-theo",
    warningCode: "theo-redemption-rail-closed",
    capacityNote: "Retaining measured zero capacity behind readable Theo pause, zero-cap or unsupported-output guards",
    reason: "The fixed-identity same-block observer establishes a closed rail, not a missing capacity read.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-09-30",
  },
  {
    kind: "degraded-sync-warning-exception",
    stablecoinId: "thusd-theo",
    warningCode: "theo-redemption-buffer-empty",
    capacityNote: "Retaining measured zero allowance-limited Theo spendable float",
    reason: "A complete readable supported-asset probe with zero spendable float is an adverse capacity fact.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-09-30",
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
    stablecoinId: "witry-brix",
    reason:
      "wiTRY's ERC-4626 wrapper feed is reserve evidence only: the TRY-denominated underlying has no same-path USD valuation, so nominal TRY is not emitted as USD capacity. Canonical cooldown terms are reviewed separately and do not price the iTRY output.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-03",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "apyusd-apyx",
    reason:
      "Generic reserve telemetry measures idle apxUSD backing and asynchronous queue diagnostics, not the exact funded UnlockReceipt path. The configured route consumes only its standalone executable observer's receipt identity, vested output and claim guards; reserve balances or generic async state cannot substitute for that capacity evidence.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-07",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "susdx-axis",
    reason:
      "The StakedUSDx reserve feed measures active-share USDx backing and asynchronous request diagnostics. Reserved burned-share liabilities and the eligibility cooldown do not establish funded capacity or bounded completion for new requests through privileged queue servicing; the configured USDx-output route remains unquantified.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-07",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "usdat-saturn",
    reason:
      "USDat's MultiMint wrapper measures PYUSDx backing, not executable holder throughput through the configured USDC redemption rail. Backing balances, downstream conversion descriptions and unmeasured liquidity cannot establish exact same-notional USDC output capacity; this telemetry remains rejected for that route.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-10-07",
  },
  {
    kind: "unused-live-redemption-telemetry",
    stablecoinId: "musd-metamask",
    reason:
      "mUSD's M-wrapper producer measures M backing and a sampled whitelisted SwapFacility redemption cohort; this capacity does not establish the liquidity of the configured Bridge fiat-redemption rail, so it remains reserve evidence rather than that route's redemption capacity.",
    owner: POLICY_OWNER,
    reviewedAt: "2026-09-30",
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
