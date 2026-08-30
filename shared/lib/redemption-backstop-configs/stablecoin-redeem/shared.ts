import {
  cloneRedemptionBackstopConfig,
  documentedBoundSupplyFull,
  fixedFee,
  sourceRef,
  stablecoinRedeemBase,
  type RedemptionBackstopConfig,
} from "../shared";
import {
  REVIEWED_MAY_BATCH_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_WRAPPER_WAVE_AT,
  REVIEWED_YIELD_COVERAGE_WAVE_AT,
} from "../review-dates";

// Re-exported from review-dates as a convenience barrel so per-coin files in
// this directory can import cross-cutting review dates from a single local import.
export {
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_EXIT_CREDIT_WAVE_AT,
  REVIEWED_EXIT_CREDIT_WAVE2_AT,
  REVIEWED_EXIT_CREDIT_WAVE3_AT,
} from "../review-dates";

/** Scaffold for the one-coin modules in this directory: applies the shared
 *  `stablecoinRedeemBase` defaults so each module only states its overrides. */
export function defineStablecoinRedeemConfig(overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig { return { ...stablecoinRedeemBase, ...overrides }; }

export function defineReviewedStablecoinRedeemConfig(reviewedAt: string, overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig {
  return defineStablecoinRedeemConfig({ ...documentedBoundSupplyFull(reviewedAt), ...overrides });
}

type ReserveSyncFallback = Omit<
  Extract<RedemptionBackstopConfig["capacityModel"], { kind: "reserve-sync-metadata" }>,
  "kind"
>;

type Erc4626InstantOptions = {
  symbol: string;
  reviewedAt: string;
  docs: NonNullable<RedemptionBackstopConfig["docs"]>;
  fallback?: number | ReserveSyncFallback;
  outputAssets?: RedemptionBackstopConfig["outputAssets"];
  feeDescription: string;
  notes?: string[];
} & Partial<Pick<RedemptionBackstopConfig, "accessModel" | "settlementModel" | "executionModel" | "outputAssetType" | "routeExitCorrelation" | "totalScoreCap" | "v9RouteReviewTerms">>;

export function erc4626InstantConfig({ symbol, reviewedAt, docs, fallback, outputAssets, feeDescription, notes, ...optional }: Erc4626InstantOptions): RedemptionBackstopConfig {
  return cloneRedemptionBackstopConfig(defineStablecoinRedeemConfig({
    capacityModel: {
      kind: "reserve-sync-metadata",
      ...(fallback !== undefined ? (typeof fallback === "number" ? { fallbackRatio: fallback } : fallback) : {}),
    },
    executionModel: "rules-based-nav",
    ...optional,
    ...(outputAssets !== undefined ? { outputAssets: [...outputAssets] } : {}),
    costModel: fixedFee(0, feeDescription),
    reviewedAt,
    docs: docs.map(({ label, url, supports }) => sourceRef(label, url, supports ? [...supports] : undefined)),
    notes: notes
      ? [...notes]
      : [
          `Fresh ERC-4626 reserve telemetry reads the vault's idle ${symbol} balance as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.`,
        ],
  }));
}

/** steakUSDC and steakUSDT use the identical Steakhouse Prime Instant config, differing
 *  only by the redeemed-token symbol in the fee description and telemetry note. */
export function steakhousePrimeInstantConfig(symbol: "USDC" | "USDT"): RedemptionBackstopConfig {
  return defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      `Steakhouse Prime Instant uses Morpho vaults; withdrawals redeem to ${symbol} when liquidity is available and Morpho vault fees accrue from generated yield rather than a separate withdrawal fee.`,
    ),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef("Steakhouse Prime Instant", "https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
    ],
    notes: [
      `Fresh ERC-4626 reserve telemetry reads the vault's idle ${symbol} balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.`,
    ],
  });
}

/** gtUSDC and gtUSDCP use the identical Gauntlet MetaMorpho config, differing only in
 *  the per-vault docs[1] label and URL. */
export function gauntletMorphoConfig(vaultLabel: string, vaultUrl: string): RedemptionBackstopConfig {
  return defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "MetaMorpho vault withdrawals redeem to USDC when vault liquidity is available; Morpho vault fees accrue from generated yield rather than a separate withdrawal fee.",
    ),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("Morpho vault docs", "https://docs.morpho.org/curation/overview", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(vaultLabel, vaultUrl, ["route", "capacity", "access"]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
    ],
  });
}

export { REVIEWED_DIRECT_REDEMPTION_AT } from "../review-dates";
export const REVIEWED_ZCHF_BRIDGE_AT = "2026-05-25";
export const REVIEWED_WRAPPER_REDEMPTION_AT = REVIEWED_WRAPPER_WAVE_AT;
export const REVIEWED_STABLECOIN_BATCH_AT = REVIEWED_MAY_BATCH_AT;
export const REVIEWED_YIELD_EXPANSION_AT = REVIEWED_YIELD_COVERAGE_WAVE_AT;
export const REVIEWED_FXSAVE_LIVE_REDEMPTION_AT = "2026-05-27";
