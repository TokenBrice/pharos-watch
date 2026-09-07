import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { PAUSED_SELECTOR, encodeUint256 } from "../../lib/evm-selectors";
import { getPublicRpcUrl } from "../../lib/public-rpc-registry";
import { rethrowIfAborted } from "../../lib/abort";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  catchAndWarn,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveInfoWarning,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
import { decodeUint256Word } from "./abi-decode";
import {
  addressObservation,
  boolObservation,
  customObservation,
  executeEvmObservationPlan,
  uint256Observation,
} from "./evm-observation-plan";
import { cefiPositionMeta, wrapperAssetMeta } from "./wrapper-assets";

interface InfiniFiFarm {
  name: string;
  label: string;
  assetsNormalized: number;
  type: "LIQUID" | "ILLIQUID" | "PROTOCOL";
  underlyingAssetSymbol: string;
}

export interface InfiniFiProtocolData {
  code: string;
  data: {
    stats: {
      asset: {
        totalTVLAssetNormalized: number;
        totalLiquidAssetNormalized?: number;
        totalIlliquidAssetNormalized?: number;
        pendingRedemptionsAssetNormalized?: number;
      };
      staked?: {
        exchangeRateNormalized?: number;
      };
      receipt?: {
        totalSupplyNormalized?: number;
      };
    };
    /** Pre-2026-08 payload shape; the live feed nests receipt under `stats`. */
    receipt?: {
      totalSupplyNormalized?: number;
    };
    farms: InfiniFiFarm[];
  };
}

function readReceiptSupply(payload: InfiniFiProtocolData): number | undefined {
  return payload.data.stats.receipt?.totalSupplyNormalized ?? payload.data.receipt?.totalSupplyNormalized;
}

export interface InfiniFiRateHistoryResponse {
  code: string;
  data?: {
    dataPoints?: unknown;
  };
}

interface FarmRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  blacklistable?: boolean;
}

const FARM_RISK_MAP: Record<string, FarmRiskConfig> = {
  "fasanara-rwa-farm":       { risk: "high", ...cefiPositionMeta() },
  "fasanara-gdaf":           { risk: "high", ...cefiPositionMeta(), coinId: "mglobal-midas-fasanara", depType: "collateral" },
  "falconx-farm":            { risk: "high", ...cefiPositionMeta() },
  "morpho-v2-sentora-pyusd": { risk: "high", ...wrapperAssetMeta("pyusd") },
  "maple-farm-institutional": { risk: "high", ...cefiPositionMeta() },
  "maple-farm-syrup":        { risk: "high", ...wrapperAssetMeta("usdc") },
  "spark-sUSDC-refcode":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "fluid-fUSDC":             { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3":                  { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-horizon-usdc":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-rlusd-farm":       { risk: "low", ...wrapperAssetMeta("usdc") },
  "aave-v4-usdg":            { risk: "low" },
  "euler-sentora-usdc":      { risk: "low", ...wrapperAssetMeta("usdc") },
  "morpho-steakUSDCinfinifi": { risk: "medium", ...wrapperAssetMeta("usdc") },
  "capfarm":                 { risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
  SwapFarm:                  { risk: "low" },
  "tokemak-autoUSD":         { risk: "medium" },
  "tokemak-auto-infinifiUSD": { risk: "medium" },
  "gauntlet-alpha-farm":     { risk: "medium" },
  "reservoir-wsrUSD":        { risk: "medium" },
  "sGHO":                    { risk: "medium", coinId: "sgho-aave", depType: "collateral" },
  "liquid-cap":              { risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
  "cowswap-fxSave":          { risk: "medium", coinId: "fxsave-f-x-protocol", depType: "collateral" },
  "pendle-v3-PT-apxUSD-18JUN2026": { risk: "high", coinId: "apxusd-apyx", depType: "collateral" },
  "pendle-v3-PT-apyUSD-18JUN2026": { risk: "high", coinId: "apyusd-apyx", depType: "collateral" },
  "new-silver-junior":       { risk: "high", ...cefiPositionMeta() },
  // Senior tranche of the same New Silver private residential-credit facility
  // as new-silver-junior; less loss-absorbing but the same off-chain lender.
  "new-silver-senior":       { risk: "high", ...cefiPositionMeta() },
  // "BASE Liquidity Farm" (Outland): USDC-denominated managed liquidity on
  // Base with no published strategy identity — reviewed 2026-08-27 at $3 of
  // exposure; stays high risk with no dependency link until the strategy is
  // publicly documented.
  "base-outland-farm":       { risk: "high" },
  "morpho-v2-sentora-prime": { risk: "high", coinId: "pyusd-paypal", depType: "collateral" },
  // STRCx is Backed Assets' tokenized wrapper of Strategy's STRC perpetual
  // preferred stock — an off-chain security held in centralized custody whose
  // quasi-peg has already broken twice (to ~$90 in Nov 2025 and ~$93 in Feb
  // 2026), dragging STRC-backed synthetics like apxUSD/sUSDat well below $1.
  "strcx":                   { risk: "high", ...cefiPositionMeta() },
};

const SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT = 0.5;

// The protocol /data payload exposes no timestamp of its own. The transparency
// dashboard's siUSD rate-history series is written by the same backend
// snapshotter on a 2-hour cadence; its latest point timestamps that snapshot,
// and matching its value against the live staked exchange rate ties the
// timestamp to the reserve state we are reporting. History values are rounded
// to 4 decimals, so the tolerance covers rounding plus sub-cadence yield drift.
const INFINIFI_RATE_HISTORY_PATH = "/api/protocol/rate-history/siUSD?daysAgo=7";
const RATE_CROSS_CHECK_TOLERANCE = 5e-4;
const RATE_HISTORY_PROBE_TIMEOUT_MS = 6_000;

export function resolveInfiniFiFreshness(
  payload: InfiniFiProtocolData,
  rateHistory: InfiniFiRateHistoryResponse | null,
):
  | { sourceTimestamp: number; freshnessMode: "verified" }
  | { freshnessMode: "unverified"; details: { freshnessSource: string; freshnessReason: string } } {
  const points = rateHistory?.code === "OK" && Array.isArray(rateHistory.data?.dataPoints)
    ? rateHistory.data.dataPoints
    : [];
  let latest: { time: number; value: number } | null = null;
  for (const point of points) {
    if (
      point != null
      && typeof point === "object"
      && "time" in point
      && "value" in point
      && typeof point.time === "number" && Number.isFinite(point.time)
      && typeof point.value === "number" && Number.isFinite(point.value)
    ) {
      latest = { time: point.time, value: point.value };
    }
  }
  if (latest == null) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi protocol stats payload does not expose a trustworthy source timestamp",
    );
  }

  const liveRate = payload.data.stats.staked?.exchangeRateNormalized;
  if (
    typeof liveRate !== "number"
    || !Number.isFinite(liveRate)
    || Math.abs(liveRate - latest.value) > RATE_CROSS_CHECK_TOLERANCE
  ) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi siUSD rate-history freshness probe diverged from the live staked exchange rate",
    );
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(latest.time);
  if (sourceTimestamp == null) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi siUSD rate-history latest point carried an unreadable timestamp",
    );
  }
  return verifiedFreshnessMetadata(sourceTimestamp);
}

export interface AdaptInfiniFiResult {
  slices: ReserveSlice[];
  /** Farm names not found in FARM_RISK_MAP (for operator awareness). */
  unknownFarms: string[];
  unknownExposurePct: number;
  sourceTotalGapPct: number;
  excludedProtocolFarms: string[];
  activeFarmCount: number;
  immediateRedeemableUsd: number;
  supplyUsd?: number;
}

/** Convert raw InfiniFi protocol data to ReserveSlice[]. Pure function — no I/O. */
export function adaptInfiniFi(payload: InfiniFiProtocolData): AdaptInfiniFiResult {
  const tvl = payload.data.stats.asset.totalTVLAssetNormalized;
  if (!tvl || tvl <= 0) {
    return {
      slices: [],
      unknownFarms: [],
      unknownExposurePct: 0,
      sourceTotalGapPct: 0,
      excludedProtocolFarms: [],
      activeFarmCount: 0,
      immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
      ...(readReceiptSupply(payload) != null ? { supplyUsd: readReceiptSupply(payload) } : {}),
    };
  }

  const activeFarms = payload.data.farms.filter(
    (f) => f.type !== "PROTOCOL" && f.assetsNormalized > 0,
  );
  const excludedProtocolFarms = payload.data.farms.filter(
    (f) => f.type === "PROTOCOL" && f.assetsNormalized > 0,
  );
  const activeFarmTotal = activeFarms.reduce((sum, farm) => sum + farm.assetsNormalized, 0);
  const sourceTotalGapUsd = Math.max(0, tvl - activeFarmTotal);
  const sourceTotalGapPct = (sourceTotalGapUsd / tvl) * 100;

  const unknownFarms: string[] = [];
  let unknownExposurePct = 0;

  const rawSlices: ReserveSlice[] = [];

  for (const f of activeFarms) {
    const pct = (f.assetsNormalized / tvl) * 100;
    const config = FARM_RISK_MAP[f.name];
    if (!config) {
      unknownFarms.push(f.name);
      unknownExposurePct += pct;
    }
    const risk: ReserveSlice["risk"] = config?.risk
      ?? (f.type === "LIQUID" ? "low" : "medium");
    rawSlices.push({
      name: f.label,
      pct,
      risk,
      ...(config?.coinId ? { coinId: config.coinId } : {}),
      ...(config?.depType ? { depType: config.depType } : {}),
      ...(config?.blacklistable != null ? { blacklistable: config.blacklistable } : {}),
    } satisfies ReserveSlice);
  }

  if (sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    rawSlices.push({
      name: excludedProtocolFarms.length > 0
        ? "InfiniFi protocol-level reserve positions"
        : "Unmapped InfiniFi TVL gap",
      pct: sourceTotalGapPct,
      risk: "high",
    });
  }

  return {
    slices: normalizeSlices(rawSlices),
    unknownFarms,
    unknownExposurePct,
    sourceTotalGapPct,
    excludedProtocolFarms: excludedProtocolFarms.map((farm) => farm.name).sort(),
    activeFarmCount: activeFarms.length,
    immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
    ...(readReceiptSupply(payload) != null ? { supplyUsd: readReceiptSupply(payload) } : {}),
  };
}

// The redemption route is Gateway.redeem() -> RedeemController.redeem(). The
// controller's own USDC balance is dust (~$0.0007) because BeforeRedeemHook
// unwinds liquid farms into it inside the same transaction, so no single view
// reads the route's capacity. What the chain does expose same-run is whether
// the route is passable at all, and how much is already queued ahead of a new
// redeemer — which is what this probe reads.
const INFINIFI_GATEWAY = "0x3f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5";
const INFINIFI_RECEIPT_TOKEN = "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c"; // iUSD
const INFINIFI_ASSET_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC
const INFINIFI_RECEIPT_DECIMALS = 18;
const INFINIFI_ASSET_DECIMALS = 6;
const ROUTE_PROBE_TIMEOUT_MS = 10_000;

const GATEWAY_REDEEM_CONTROLLER_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000001072656465656d436f6e74726f6c6c657200000000000000000000000000000000";
const GATEWAY_YIELD_SHARING_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000000c7969656c6453686172696e670000000000000000000000000000000000000000";
const GATEWAY_RECEIPT_TOKEN_CALLDATA =
  "0xbf40fac10000000000000000000000000000000000000000000000000000000000000020"
  + "000000000000000000000000000000000000000000000000000000000000000c72656365697074546f6b656e0000000000000000000000000000000000000000";

const ASSET_TOKEN_SELECTOR = "0x1083f761"; // assetToken()
const BEFORE_REDEEM_HOOK_SELECTOR = "0xce25b2c6"; // beforeRedeemHook()
const QUEUE_LENGTH_SELECTOR = "0xab91c7b0"; // queueLength()
const TOTAL_ENQUEUED_REDEMPTIONS_SELECTOR = "0x3f3b03ca"; // totalEnqueuedRedemptions()
const TOTAL_PENDING_CLAIMS_SELECTOR = "0x70bf2381"; // totalPendingClaims()
const LIQUIDITY_SELECTOR = "0x1a686502"; // liquidity()
const RECEIPT_TO_ASSET_SELECTOR = "0xf308cf65"; // receiptToAsset(uint256)
const UNACCRUED_YIELD_SELECTOR = "0xf843336c"; // unaccruedYield()

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface InfiniFiRouteProbe {
  redeemController: string;
  yieldSharing: string;
  beforeRedeemHook: string | null;
  gatewayPaused: boolean;
  controllerPaused: boolean;
  yieldSharingPaused: boolean;
  hookPaused: boolean | null;
  /** Gateway.redeem() reverts with PendingLossesUnapplied when unaccruedYield() < 0. */
  hasUnaccruedLosses: boolean;
  queueLength: number;
  /** Enqueued iUSD converted at the controller's live receipt/asset ratio. */
  queuedUsd: number;
  /** Already-funded claims the controller holds for earlier redeemers. */
  pendingClaimsUsd: number;
  controllerLiquidityUsd: number;
}

/** int256 word -> bigint. unaccruedYield() is signed and negative closes the route. */
function decodeInt256Word(raw: string | null | undefined): bigint | null {
  const unsigned = decodeUint256Word(raw);
  if (unsigned == null) return null;
  return unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
}

/**
 * Same-run read of the iUSD redemption route. Every read is resolved from the
 * Gateway's own address registry rather than pinned, and the run is dropped
 * unless the registry still points at the tracked iUSD and USDC — a migrated
 * gateway reports nothing rather than stale gate state.
 */
async function probeInfiniFiRedeemRoute(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<InfiniFiRouteProbe | null> {
  const chain = "ethereum";
  const rpcUrl = getPublicRpcUrl(chain);
  if (!rpcUrl) return null;
  const read = (calls: Parameters<typeof fetchOnchainMulticall3>[0]["calls"]) =>
    fetchOnchainMulticall3({ calls, chain, signal, ctx, rpcUrl, timeoutMs: ROUTE_PROBE_TIMEOUT_MS });

  try {
    const gateway = await executeEvmObservationPlan({
      adapterKey: "infinifi-redemption-gateway",
      fields: [
        boolObservation({ label: "gateway:paused", contract: INFINIFI_GATEWAY, data: PAUSED_SELECTOR }),
        addressObservation({
          label: "gateway:redeem-controller",
          contract: INFINIFI_GATEWAY,
          data: GATEWAY_REDEEM_CONTROLLER_CALLDATA,
          verify: (value) => value === ZERO_ADDRESS ? "redeem controller is the zero address" : null,
        }),
        addressObservation({
          label: "gateway:yield-sharing",
          contract: INFINIFI_GATEWAY,
          data: GATEWAY_YIELD_SHARING_CALLDATA,
          verify: (value) => value === ZERO_ADDRESS ? "yield sharing is the zero address" : null,
        }),
        addressObservation({
          label: "gateway:receipt-token",
          contract: INFINIFI_GATEWAY,
          data: GATEWAY_RECEIPT_TOKEN_CALLDATA,
          verify: (value) => value === INFINIFI_RECEIPT_TOKEN ? null : "receipt-token identity drifted",
        }),
      ] as const,
      read,
    });
    const gatewayPaused = gateway.values["gateway:paused"];
    const redeemController = gateway.values["gateway:redeem-controller"];
    const yieldSharing = gateway.values["gateway:yield-sharing"];

    const controller = await executeEvmObservationPlan({
      adapterKey: "infinifi-redemption-controller",
      fields: [
        boolObservation({ label: "rc:paused", contract: redeemController, data: PAUSED_SELECTOR }),
        addressObservation({
          label: "rc:asset-token",
          contract: redeemController,
          data: ASSET_TOKEN_SELECTOR,
          verify: (value) => value === INFINIFI_ASSET_TOKEN ? null : "asset-token identity drifted",
        }),
        addressObservation({ label: "rc:hook", contract: redeemController, data: BEFORE_REDEEM_HOOK_SELECTOR }),
        uint256Observation({ label: "rc:queue-length", contract: redeemController, data: QUEUE_LENGTH_SELECTOR }),
        uint256Observation({ label: "rc:enqueued", contract: redeemController, data: TOTAL_ENQUEUED_REDEMPTIONS_SELECTOR }),
        uint256Observation({ label: "rc:pending-claims", contract: redeemController, data: TOTAL_PENDING_CLAIMS_SELECTOR }),
        uint256Observation({ label: "rc:liquidity", contract: redeemController, data: LIQUIDITY_SELECTOR }),
        uint256Observation({
          label: "rc:receipt-to-asset",
          contract: redeemController,
          data: `${RECEIPT_TO_ASSET_SELECTOR}${encodeUint256(10n ** BigInt(INFINIFI_RECEIPT_DECIMALS))}`,
          verify: (value) => value > 0n ? null : "receipt-to-asset rate is not positive",
        }),
        boolObservation({ label: "ys:paused", contract: yieldSharing, data: PAUSED_SELECTOR }),
        customObservation({
          label: "ys:unaccrued-yield",
          contract: yieldSharing,
          data: UNACCRUED_YIELD_SELECTOR,
          decode: (raw, label) => {
            const value = decodeInt256Word(raw);
            if (value == null) throw new Error(`${label} returned malformed int256 data`);
            return value;
          },
        }),
      ] as const,
      read,
    });

    const controllerPaused = controller.values["rc:paused"];
    const yieldSharingPaused = controller.values["ys:paused"];
    const unaccruedYield = controller.values["ys:unaccrued-yield"];
    const queueLengthRaw = controller.values["rc:queue-length"];
    const enqueuedRaw = controller.values["rc:enqueued"];
    const pendingClaimsRaw = controller.values["rc:pending-claims"];
    const liquidityRaw = controller.values["rc:liquidity"];
    const receiptToAssetRaw = controller.values["rc:receipt-to-asset"];

    // The hook is optional in the controller; when set, its own pause reverts
    // redeem() before any liquidity is reached.
    const hook = controller.values["rc:hook"];
    let hookPaused: boolean | null = null;
    if (hook !== ZERO_ADDRESS) {
      const hookObservation = await executeEvmObservationPlan({
        adapterKey: "infinifi-redemption-hook",
        fields: [boolObservation({ label: "hook:paused", contract: hook, data: PAUSED_SELECTOR })] as const,
        read,
      });
      hookPaused = hookObservation.values["hook:paused"];
    }

    return {
      redeemController,
      yieldSharing,
      beforeRedeemHook: hook === ZERO_ADDRESS ? null : hook,
      gatewayPaused,
      controllerPaused,
      yieldSharingPaused,
      hookPaused,
      hasUnaccruedLosses: unaccruedYield < 0n,
      queueLength: Number(queueLengthRaw),
      queuedUsd: decimalNumberFromBigInt(
        (enqueuedRaw * receiptToAssetRaw) / 10n ** BigInt(INFINIFI_RECEIPT_DECIMALS),
        INFINIFI_ASSET_DECIMALS,
      ),
      pendingClaimsUsd: decimalNumberFromBigInt(pendingClaimsRaw, INFINIFI_ASSET_DECIMALS),
      controllerLiquidityUsd: decimalNumberFromBigInt(liquidityRaw, INFINIFI_ASSET_DECIMALS),
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

/**
 * A closed gate anywhere on the path makes redeem() revert. With every gate
 * open the route still degrades once the queue is non-empty: the controller
 * enqueues a new redeemer outright instead of paying from liquidity.
 */
function resolveInfiniFiRouteStatus(
  probe: InfiniFiRouteProbe,
): { routeStatus: "open" | "degraded" | "paused"; routeStatusReason: string } {
  const closedGates = [
    ...(probe.gatewayPaused ? ["Gateway paused()"] : []),
    ...(probe.controllerPaused ? ["RedeemController paused()"] : []),
    ...(probe.yieldSharingPaused ? ["YieldSharing paused()"] : []),
    ...(probe.hookPaused ? ["BeforeRedeemHook paused()"] : []),
    ...(probe.hasUnaccruedLosses ? ["YieldSharing unaccruedYield() below zero"] : []),
  ];
  if (closedGates.length > 0) {
    return {
      routeStatus: "paused",
      routeStatusReason: `InfiniFi redemption is closed this run: ${closedGates.join(", ")}`,
    };
  }
  const openGates =
    "Gateway, RedeemController, YieldSharing and BeforeRedeemHook all read unpaused with non-negative unaccruedYield()";
  return probe.queueLength > 0
    ? {
        routeStatus: "degraded",
        routeStatusReason:
          `${openGates}, but queueLength() is ${probe.queueLength}: RedeemController enqueues new redemptions `
          + "instead of settling them from liquidity until the queue is funded",
      }
    : {
        routeStatus: "open",
        routeStatusReason: `${openGates}, and queueLength() is zero so redemptions settle from hook-unwound liquidity`,
      };
}

const INFINIFI_GATEWAY_DOC_URL = "https://docs.infinifi.xyz/dev-docs/gateway";
const INFINIFI_REDEEM_CONTROLLER_DOC_URL = "https://docs.infinifi.xyz/dev-docs/funding/redeem-controller";

/** Fetch + adapt infiniFi protocol data. Uses fetchWithRetry for resilience. */
export async function fetchInfiniFiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "infinifi");

  const url = primaryInput.url;
  const payload = await fetchJsonWithRetry<InfiniFiProtocolData>(url, signal, 12_000, ctx);
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  const adapted = adaptInfiniFi(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownFarms.length > 0
    ? [buildUnknownExposureWarning({
        code: "unknown-position",
        message: `Unmapped reserve positions: ${adapted.unknownFarms.sort().join(", ")}`,
        unknownExposurePct: adapted.unknownExposurePct,
      })]
    : [];
  if (adapted.sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    warnings.push(buildUnknownExposureWarning({
      code: "source-total-gap",
      message: adapted.excludedProtocolFarms.length > 0
        ? `InfiniFi PROTOCOL farm exposure excluded from mapped farm rows: ${adapted.excludedProtocolFarms.join(", ")}`
        : "InfiniFi total TVL exceeds mapped active farm assets",
      unknownExposurePct: adapted.sourceTotalGapPct,
      thresholdPct: SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
    }));
  }

  // The freshness probe is optional context: bound it to a hard 6s overall
  // budget (including retries) so a slow probe can never push the attempt past
  // the orchestrator's 20s wall and cost us an otherwise-good snapshot.
  const rateHistoryUrl = new URL(INFINIFI_RATE_HISTORY_PATH, url).toString();
  const [rateHistory, routeProbe] = await Promise.all([
    catchAndWarn(
      fetchJsonWithRetry<InfiniFiRateHistoryResponse>(
        rateHistoryUrl,
        AbortSignal.any([signal, AbortSignal.timeout(RATE_HISTORY_PROBE_TIMEOUT_MS)]),
        RATE_HISTORY_PROBE_TIMEOUT_MS,
        ctx,
      ),
      "freshness-probe-failed",
      "InfiniFi siUSD rate-history freshness probe",
      warnings,
    ),
    probeInfiniFiRedeemRoute(signal, ctx),
  ]);
  const freshness = resolveInfiniFiFreshness(payload, rateHistory);
  if (routeProbe == null) {
    warnings.push(reserveInfoWarning(
      "infinifi-redemption-route-unreadable",
      "InfiniFi redemption gates and queue state were unreadable this run; redemption telemetry withheld",
    ));
  }

  const totalReserveUsd = payload.data.stats.asset.totalTVLAssetNormalized;
  const illiquidReserveUsd = payload.data.stats.asset.totalIlliquidAssetNormalized ?? 0;

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      farmCount: payload.data.farms.length,
      activeFarmCount: adapted.activeFarmCount,
      unknownFarmCount: adapted.unknownFarms.length,
      unknownExposurePct: adapted.unknownExposurePct,
      sourceTotalGapPct: adapted.sourceTotalGapPct,
      ...(adapted.excludedProtocolFarms.length > 0 ? { excludedProtocolFarms: adapted.excludedProtocolFarms } : {}),
      ...freshness,
      totalReserveUsd,
      immediateRedeemableUsd: adapted.immediateRedeemableUsd,
      illiquidReserveUsd,
      ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
        ? { immediateRedeemableRatio: adapted.immediateRedeemableUsd / adapted.supplyUsd }
        : {}),
      pendingRedemptionsUsd:
        payload.data.stats.asset.pendingRedemptionsAssetNormalized,
      ...(adapted.supplyUsd != null ? { supplyUsd: adapted.supplyUsd } : {}),
      ...(routeProbe != null
        ? {
            ...buildRedemptionSnapshotMetadata({
              // The honest bound is the liquid farm total the BeforeRedeemHook
              // can unwind into the controller, not the controller's own idle
              // balance and not a queue measurement — so this stays a proxy the
              // same-run gate reads validate, never a live-direct capacity.
              capacityUsd: adapted.immediateRedeemableUsd,
              ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
                ? { capacityRatioOfSupply: adapted.immediateRedeemableUsd / adapted.supplyUsd }
                : {}),
              capacityKind: "live-queue",
              ...(freshness.freshnessMode === "verified"
                ? { freshnessKind: "verified-source-timestamp" as const, sourceTimestamp: freshness.sourceTimestamp }
                : { freshnessKind: "same-run-api" as const }),
              ...resolveInfiniFiRouteStatus(routeProbe),
              routeStatusSource: "onchain",
              queueDepthUsd: routeProbe.queuedUsd,
              sourceUrls: [url, INFINIFI_GATEWAY_DOC_URL, INFINIFI_REDEEM_CONTROLLER_DOC_URL],
            }),
            details: {
              ...(freshness.freshnessMode === "unverified" ? freshness.details : {}),
              redeemRoute: {
                proofKind: "infinifi-gateway-registry-gates-and-queue",
                gateway: INFINIFI_GATEWAY,
                redeemController: routeProbe.redeemController,
                yieldSharing: routeProbe.yieldSharing,
                beforeRedeemHook: routeProbe.beforeRedeemHook,
                queueLength: routeProbe.queueLength,
                queuedUsd: routeProbe.queuedUsd,
                pendingClaimsUsd: routeProbe.pendingClaimsUsd,
                controllerLiquidityUsd: routeProbe.controllerLiquidityUsd,
              },
            },
          }
        : {}),
    },
  };
}
