import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import {
  aggregateScopedLiabilitySupply,
  decimalNumberFromBigInt,
  evaluateLiabilityCoverage,
  makeOnchainCallers,
  pinnedEvmTokenReader,
  requireOnchainInput,
  verifiedFreshnessMetadata,
  type ScopedLiabilitySupply,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { pinnedBlockPlan } from "./evm-observation-plan";

const USD1_BUNDLE_ORACLE = "0x691b74146cdba162449012aa32d3cbf5df77d4c4";
const USD1_RESERVE_LABEL = "U.S. Treasury Bills, Money Market Funds & Cash";

const USD1_BUNDLE_ORACLE_ABI = parseAbi([
  "function latestBundle() view returns (bytes)",
  "function latestBundleTimestamp() view returns (uint256)",
  "function bundleDecimals() view returns (uint8[])",
]);

const LATEST_BUNDLE_SELECTOR = encodeFunctionData({
  abi: USD1_BUNDLE_ORACLE_ABI,
  functionName: "latestBundle",
});
const LATEST_BUNDLE_TIMESTAMP_SELECTOR = encodeFunctionData({
  abi: USD1_BUNDLE_ORACLE_ABI,
  functionName: "latestBundleTimestamp",
});
const BUNDLE_DECIMALS_SELECTOR = encodeFunctionData({
  abi: USD1_BUNDLE_ORACLE_ABI,
  functionName: "bundleDecimals",
});

// The oracle's `description()` is "USD1 BitGo Reported Reserves": BitGo's
// USD1 redemption assets, which equal KPMG's examined USD1 redemption assets
// to the dollar (docs/live-reserves.md "Reviewed liability scopes").
const USD1_RESERVE_SCOPE =
  "BitGo-reported USD1 redemption assets (oracle description 'USD1 BitGo Reported Reserves'), measured against USD1 supply on the reviewed issuer-native chains";

export function adaptUsd1BundleOracle(input: {
  bundle: `0x${string}`;
  latestBundleTimestamp: bigint;
  bundleDecimals: readonly number[];
  supply: ScopedLiabilitySupply;
}): AdapterResult {
  const [bundleTimestampRaw, totalReserveRaw] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    input.bundle,
  );
  const bundleTimestamp = Number(bundleTimestampRaw);
  const latestBundleTimestamp = Number(input.latestBundleTimestamp);
  if (!Number.isSafeInteger(bundleTimestamp) || bundleTimestamp <= 0) {
    throw new Error("usd1-bundle-oracle bundle timestamp is invalid");
  }
  if (latestBundleTimestamp !== bundleTimestamp) {
    throw new Error(
      `usd1-bundle-oracle timestamp mismatch: bundle=${bundleTimestamp}, latest=${latestBundleTimestamp}`,
    );
  }

  const reserveDecimals = input.bundleDecimals[0];
  if (!Number.isInteger(reserveDecimals) || reserveDecimals < 0) {
    throw new Error("usd1-bundle-oracle reserve decimals are invalid");
  }
  if (totalReserveRaw <= 0n) {
    throw new Error("usd1-bundle-oracle reported zero reserves");
  }

  const totalReserveUsd = decimalNumberFromBigInt(totalReserveRaw, reserveDecimals);
  const supplyUsd = input.supply.contributions.reduce(
    (total, contribution) => total + decimalNumberFromBigInt(contribution.raw, contribution.decimals),
    0,
  );
  if (supplyUsd <= 0) {
    throw new Error("usd1-bundle-oracle observed zero USD1 supply");
  }

  // Reserves and supply stay published as independent facts; only the ratio
  // needs the reviewed perimeter, complete included reads and time identity.
  const coverage = evaluateLiabilityCoverage({ supply: input.supply, reserveObservedAt: bundleTimestamp });
  const primaryContribution = input.supply.contributions[0];

  return {
    slices: [
      {
        sourceKey: "usd1-bundle-oracle:0x691b74146cdba162449012aa32d3cbf5df77d4c4",
        name: USD1_RESERVE_LABEL,
        pct: 100,
        risk: "very-low",
      },
    ],
    metadata: {
      ...verifiedFreshnessMetadata(bundleTimestamp),
      details: {
        proofKind: "usd1-chainlink-bundle-oracle",
        reserveSourceLabel: USD1_RESERVE_LABEL,
        oracleAddress: USD1_BUNDLE_ORACLE,
        reserveScope: USD1_RESERVE_SCOPE,
      },
      totalReserveUsd,
      supplyUsd,
      ...(coverage.ratioUnavailableReason == null ? { collateralizationRatio: totalReserveUsd / supplyUsd } : {}),
      totalReservesRaw: totalReserveRaw.toString(),
      reserveDecimals,
      supplyContributions: input.supply.contributions.map((contribution) => ({
        chain: contribution.chain,
        tokenAddress: contribution.tokenAddress,
        supplyRaw: contribution.raw.toString(),
        decimals: contribution.decimals,
        ...(contribution.observedAt != null ? { observedAt: contribution.observedAt } : {}),
      })),
      ...coverage.metadata,
      ...(primaryContribution
        ? {
            supplyRaw: primaryContribution.raw.toString(),
            supplyDecimals: primaryContribution.decimals,
            supplyTokenAddress: primaryContribution.tokenAddress,
          }
        : {}),
      redemption: buildDocumentedRedemptionTelemetry(bundleTimestamp, { holderEligibility: "verified-customer" }),
    },
    ...(coverage.warnings.length > 0 ? { warnings: coverage.warnings } : {}),
  };
}

export async function fetchUsd1BundleOracleReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "usd1-bundle-oracle");
  if (input.chain !== "ethereum") {
    throw new Error(`usd1-bundle-oracle only supports ethereum, got "${input.chain}"`);
  }
  const params = parseLiveReserveAdapterParams("usd1-bundle-oracle", config.params);

  const baseCtx = ctx;
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl });
  ctx = plan.ctx;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const [rawBundle, latestBundleTimestamp, rawBundleDecimals] = await Promise.all([
    onchain.raw(USD1_BUNDLE_ORACLE, LATEST_BUNDLE_SELECTOR),
    onchain.uint256(USD1_BUNDLE_ORACLE, LATEST_BUNDLE_TIMESTAMP_SELECTOR),
    onchain.raw(USD1_BUNDLE_ORACLE, BUNDLE_DECIMALS_SELECTOR),
  ]);

  if (!rawBundle) throw new Error("usd1-bundle-oracle latestBundle() call failed");
  if (latestBundleTimestamp == null) throw new Error("usd1-bundle-oracle latestBundleTimestamp() call failed");
  if (!rawBundleDecimals) throw new Error("usd1-bundle-oracle bundleDecimals() call failed");

  const bundle = decodeFunctionResult({
    abi: USD1_BUNDLE_ORACLE_ABI,
    functionName: "latestBundle",
    data: rawBundle as `0x${string}`,
  });
  const bundleDecimals = decodeFunctionResult({
    abi: USD1_BUNDLE_ORACLE_ABI,
    functionName: "bundleDecimals",
    data: rawBundleDecimals as `0x${string}`,
  });

  // Liabilities are USD1 supply over the reviewed issuer-native perimeter
  // (params.liabilityScope): each included chain is read with its declared
  // reader and on-chain decimals; CCIP lock-mint representations are excluded
  // because their supply is already locked inside Ethereum totalSupply.
  const supply = await aggregateScopedLiabilitySupply({
    coin,
    scope: params.liabilityScope,
    adapterKey: "usd1-bundle-oracle",
    signal,
    nowSec: ctx.nowSec ?? Math.floor(Date.now() / 1000),
    ctx,
    tronCtx: baseCtx,
    readEvmToken: pinnedEvmTokenReader({
      input,
      signal,
      ctx: baseCtx,
      primaryPlan: Promise.resolve(plan),
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
    }),
  });

  const result = adaptUsd1BundleOracle({
    bundle,
    latestBundleTimestamp,
    bundleDecimals,
    supply,
  });
  return { ...result, metadata: { ...result.metadata, observedBlock: plan.observedBlock } };
}
