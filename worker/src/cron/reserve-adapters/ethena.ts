import type { StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveRedemptionTelemetry,
  LiveReservesConfig,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import { encodeAddress, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decodeAbiWordAt,
  decodeAddressWord,
  decodeBoolWord,
  decodeUint256Word,
  decodeUint8Word,
} from "./abi-decode";
import {
  accumulateBucketedExposure,
  buildBucketSlices,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  summarizeSourceTimestamps,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
import { buildBrowserHeaders } from "./request";

interface EthenaCollateralRow {
  asset: string;
  exchange: string;
  timestamp: number;
  usdAmount: number;
}

export interface EthenaCollateralResponse {
  collateral: EthenaCollateralRow[];
  totalBackingAssetsInUsd: number;
}

type EthenaBucket = "stable" | "btc" | "eth" | "other";

const ETHENA_ETH_ASSETS = new Set(["ETH", "stETH", "WBETH", "mETH", "LsETH"]);
const ETHENA_BTC_ASSETS = new Set(["BTC"]);
const ETHENA_STABLE_ASSETS = new Set(["Liquid Cash"]);
const ETHENA_OTHER_ASSETS = new Set(["SOL", "XRP", "BNB", "HYPE"]);
const ETHENA_BROWSER_HEADERS = buildBrowserHeaders(
  "https://app.ethena.fi",
  "https://app.ethena.fi/dashboards/transparency",
);

function bucketForEthenaAsset(asset: string): EthenaBucket {
  if (ETHENA_STABLE_ASSETS.has(asset)) return "stable";
  if (ETHENA_BTC_ASSETS.has(asset)) return "btc";
  if (ETHENA_ETH_ASSETS.has(asset)) return "eth";
  return "other";
}

export function listUnexpectedEthenaAssets(payload: EthenaCollateralResponse): string[] {
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  return Array.from(new Set(payload.collateral.map((row) => row.asset)))
    .filter((asset) => !knownAssets.has(asset));
}

export function adaptEthenaCollateral(
  payload: EthenaCollateralResponse,
  _sourceUrl?: string,
): AdapterResult {
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  const {
    bucketTotals,
    totalValue: computedTotalBackingAssetsInUsd,
    unknownValue: unknownExposureUsd,
  } = accumulateBucketedExposure({
    items: payload.collateral,
    getValue: (row) => row.usdAmount,
    getBucket: (row) => bucketForEthenaAsset(row.asset),
    isUnknown: (row) => !knownAssets.has(row.asset),
  });

  if (
    payload.totalBackingAssetsInUsd > 0
    && Math.abs(computedTotalBackingAssetsInUsd - payload.totalBackingAssetsInUsd) / payload.totalBackingAssetsInUsd > 0.02
  ) {
    throw new Error(
      `Ethena collateral total ${computedTotalBackingAssetsInUsd.toFixed(2)} does not match totalBackingAssetsInUsd ${payload.totalBackingAssetsInUsd.toFixed(2)}`,
    );
  }

  const { slices } = buildBucketSlices(
    bucketTotals,
    [
      {
        name: "Liquid Cash strategy basket",
        bucket: "stable",
        risk: "medium",
      },
      {
        name: "BTC collateral",
        bucket: "btc",
        risk: "medium",
      },
      {
        name: "ETH / liquid staking collateral",
        bucket: "eth",
        risk: "medium",
      },
      {
        name: "Other crypto collateral",
        bucket: "other",
        risk: "high",
      },
    ],
    "stable",
  );

  const assetCount = new Set(payload.collateral.map((row) => row.asset)).size;
  const timestampSummary = summarizeSourceTimestamps(
    payload.collateral
      .filter((row) => Number.isFinite(row.usdAmount) && row.usdAmount > 0)
      .map((row) => row.timestamp),
  );
  const lastUpdatedAt = timestampSummary?.latestSourceTimestamp ?? 0;
  const warnings: LiveReserveWarning[] = [];
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `Ethena material collateral rows span ${timestampSummary.sourceTimestampSpreadSec}s of source timestamps`,
    ));
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount,
      computedTotalBackingAssetsInUsd,
      totalBackingAssetsInUsd: payload.totalBackingAssetsInUsd,
      lastUpdatedAt,
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            latestRowUpdatedAt: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "issuer-api",
            "Ethena collateral rows did not expose a trustworthy source timestamp",
          )),
      unknownExposurePct:
        computedTotalBackingAssetsInUsd > 0
          ? (unknownExposureUsd / computedTotalBackingAssetsInUsd) * 100
          : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Live redemption capacity (EthenaMinting)
// ---------------------------------------------------------------------------

// USDe redemptions run through the EthenaMinting contract, whose `redeem` pays
// the beneficiary out of the contract's own collateral balance
// (`_transferToBeneficiary`). Those balances are therefore the executable float
// of the primary (whitelisted-benefactor) redemption rail. Addresses and view
// signatures are pinned from the deployed verified source:
// https://etherscan.io/address/0xe3490297a08d6fc8da46edb7b6142e4f461b62d3#code
// Route documentation: https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism
const ETHENA_MINTING_ADDRESS = "0xe3490297a08d6fc8da46edb7b6142e4f461b62d3";
// EthenaMinting.usde() must return the tracked USDe token, else the reads are
// discarded rather than attributed to the wrong asset.
const ETHENA_USDE_ADDRESS = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3";
const ETHENA_MINTING_CONTRACT_URL =
  "https://etherscan.io/address/0xe3490297a08d6fc8da46edb7b6142e4f461b62d3#code";
const ETHENA_PEG_ARBITRAGE_DOC_URL = "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism";
const ETHENA_USDE_SELECTOR = "0x0fd761e0"; // usde()
const ETHENA_GLOBAL_CONFIG_SELECTOR = "0xa7c1abe0"; // globalConfig()
const ETHENA_TOKEN_CONFIG_SELECTOR = "0xfe136c4e"; // tokenConfig(address)
// tokenConfig().tokenType: 0 = STABLE. Only STABLE collateral goes through
// verifyStablesLimit(), so only STABLE assets may be valued 1:1 against USDe.
const ETHENA_TOKEN_TYPE_STABLE = 0;
const ETHENA_REDEEM_COLLATERAL = [
  { label: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
  { label: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
] as const;
const ETHENA_MINTING_RPC_URL = getPublicRpcUrl("ethereum");
const ETHENA_MINTING_FALLBACK_RPC_URL = getSecondaryFallbackRpcUrl("ethereum");
const USDE_DECIMALS = 18;

/** Raw ABI return payloads keyed by multicall label; null marks a failed read. */
export type EthenaMintRedeemReads = Record<string, string | null>;

function ethenaTokenConfigLabel(asset: string): string {
  return `tokenConfig:${asset}`;
}

function ethenaBalanceLabel(asset: string): string {
  return `balanceOf:${asset}`;
}

/**
 * Turns one multicall pass over EthenaMinting into redemption telemetry.
 *
 * Fail-closed: any missing, malformed, or non-STABLE read returns null, so a
 * partial pass never publishes partial capacity and the reviewed config
 * fallback stays in charge.
 */
export function buildEthenaRedemptionTelemetry(
  reads: EthenaMintRedeemReads,
): LiveReserveRedemptionTelemetry | null {
  if (decodeAddressWord(reads.usde ?? null)?.toLowerCase() !== ETHENA_USDE_ADDRESS) return null;

  // globalConfig() -> (uint128 globalMaxMintPerBlock, uint128 globalMaxRedeemPerBlock)
  const globalMaxRedeemPerBlockRaw = decodeUint256Word(decodeAbiWordAt(reads.globalConfig ?? null, 1));
  if (globalMaxRedeemPerBlockRaw == null) return null;

  let capacityUsd = 0;
  const closedAssets: string[] = [];
  for (const asset of ETHENA_REDEEM_COLLATERAL) {
    // tokenConfig(address) -> (uint8 tokenType, bool isActive, uint128 maxMintPerBlock, uint128 maxRedeemPerBlock)
    const tokenConfig = reads[ethenaTokenConfigLabel(asset.label)] ?? null;
    const tokenType = decodeUint8Word(decodeAbiWordAt(tokenConfig, 0));
    const isActive = decodeBoolWord(decodeAbiWordAt(tokenConfig, 1));
    const maxRedeemPerBlockRaw = decodeUint256Word(decodeAbiWordAt(tokenConfig, 3));
    const balanceRaw = decodeUint256Word(reads[ethenaBalanceLabel(asset.label)] ?? null);
    if (tokenType == null || isActive == null || maxRedeemPerBlockRaw == null || balanceRaw == null) return null;
    if (tokenType !== ETHENA_TOKEN_TYPE_STABLE) return null;

    // A deactivated asset, a zeroed per-asset cap, or the gatekeeper's
    // disableMintRedeem() (which zeroes the global cap) closes the rail, so the
    // balance behind it is not executable.
    if (!isActive || maxRedeemPerBlockRaw === 0n || globalMaxRedeemPerBlockRaw === 0n) {
      closedAssets.push(asset.label);
      continue;
    }
    capacityUsd += decimalNumberFromBigInt(balanceRaw, asset.decimals);
  }
  if (!Number.isFinite(capacityUsd)) return null;

  const allClosed = closedAssets.length === ETHENA_REDEEM_COLLATERAL.length;
  const routeStatus = allClosed ? "paused" : closedAssets.length > 0 || capacityUsd <= 0 ? "degraded" : "open";
  const routeStatusReason = allClosed
    ? globalMaxRedeemPerBlockRaw === 0n
      ? "EthenaMinting globalMaxRedeemPerBlock is zero, so mint and redeem are disabled"
      : "EthenaMinting reports no active redemption collateral"
    : closedAssets.length > 0
      ? `EthenaMinting redemption collateral balances are readable, but ${closedAssets.join(", ")} is inactive`
      : capacityUsd <= 0
        ? "EthenaMinting collateral is active but currently holds no redeemable stablecoin balance"
        : "EthenaMinting holds readable USDT and USDC balances behind active per-asset redemption configs";

  return {
    capacityUsd,
    capacityKind: "live-direct",
    freshnessKind: "same-run-onchain",
    routeStatus,
    routeStatusSource: "onchain",
    routeStatusReason,
    holderEligibility: "whitelisted-primary",
    sourceUrls: [ETHENA_PEG_ARBITRAGE_DOC_URL, ETHENA_MINTING_CONTRACT_URL],
    mintRedeemContract: ETHENA_MINTING_ADDRESS,
    // Per-block ceiling on order.usde_amount (belowMaxRedeemPerBlock /
    // belowGlobalMaxRedeemPerBlock). It bounds what a single redemption request
    // can clear in one block, not the multi-block drain of the balances above,
    // so it is recorded as context rather than folded into capacityUsd.
    globalMaxRedeemPerBlockUsde: decimalNumberFromBigInt(globalMaxRedeemPerBlockRaw, USDE_DECIMALS),
  };
}

async function fetchEthenaRedemptionTelemetry(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<LiveReserveRedemptionTelemetry | null> {
  try {
    const results = await fetchOnchainMulticall3({
      calls: [
        { label: "usde", contract: ETHENA_MINTING_ADDRESS, data: ETHENA_USDE_SELECTOR },
        { label: "globalConfig", contract: ETHENA_MINTING_ADDRESS, data: ETHENA_GLOBAL_CONFIG_SELECTOR },
        ...ETHENA_REDEEM_COLLATERAL.flatMap((asset) => [
          {
            label: ethenaTokenConfigLabel(asset.label),
            contract: ETHENA_MINTING_ADDRESS,
            data: `${ETHENA_TOKEN_CONFIG_SELECTOR}${encodeAddress(asset.address)}`,
          },
          {
            label: ethenaBalanceLabel(asset.label),
            contract: asset.address,
            data: encodeBalanceOfCallData(ETHENA_MINTING_ADDRESS),
          },
        ]),
      ],
      chain: "ethereum",
      signal,
      ctx,
      rpcUrl: ETHENA_MINTING_RPC_URL,
      fallbackRpcUrl: ETHENA_MINTING_FALLBACK_RPC_URL,
      timeoutMs: 12_000,
    });
    if (!results) return null;

    const reads: EthenaMintRedeemReads = {};
    for (const result of results) {
      reads[result.label] = result.success ? result.returnData : null;
    }
    return buildEthenaRedemptionTelemetry(reads);
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

export async function fetchEthenaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "ethena");
  const payload = await fetchJsonWithRetry<EthenaCollateralResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
    { headers: ETHENA_BROWSER_HEADERS },
  );
  const adapted = adaptEthenaCollateral(payload, primaryInput.url);
  const warnings: LiveReserveWarning[] = listUnexpectedEthenaAssets(payload).map((asset) => reserveDegradedWarning(
    "unknown-asset",
    `Ethena asset bucketed into other-crypto: ${asset}`,
  ));
  const redemption = await fetchEthenaRedemptionTelemetry(signal, ctx);

  return {
    ...adapted,
    ...((adapted.warnings?.length ?? 0) + warnings.length > 0
      ? { warnings: [...(adapted.warnings ?? []), ...warnings] }
      : {}),
    metadata: {
      ...adapted.metadata,
      ...(redemption ? buildRedemptionSnapshotMetadata(redemption) : {}),
    },
  };
}
