import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  makeOnchainCallers,
  requireOnchainInput,
  verifiedFreshnessMetadata,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

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

export function adaptUsd1BundleOracle(input: {
  bundle: `0x${string}`;
  latestBundleTimestamp: bigint;
  bundleDecimals: readonly number[];
  totalSupplyRaw: bigint;
  tokenDecimals: number;
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
  if (input.totalSupplyRaw <= 0n) {
    throw new Error("usd1-bundle-oracle observed zero USD1 supply");
  }

  const totalReserveUsd = decimalNumberFromBigInt(totalReserveRaw, reserveDecimals);
  const supplyUsd = decimalNumberFromBigInt(input.totalSupplyRaw, input.tokenDecimals);

  return {
    slices: [
      {
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
        fundScope: "WLFI aggregate fund reserves; denominator is USD1 supply only",
      },
      totalReserveUsd,
      supplyUsd,
      fundBackingTotalRatio: totalReserveUsd / supplyUsd,
      totalReservesRaw: totalReserveRaw.toString(),
      reserveDecimals,
      totalSupplyRaw: input.totalSupplyRaw.toString(),
      tokenDecimals: input.tokenDecimals,
      redemption: buildDocumentedRedemptionTelemetry(bundleTimestamp, { holderEligibility: "verified-customer" }),
    },
  };
}

export async function fetchUsd1BundleOracleReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "usd1-bundle-oracle");
  if (input.chain !== "ethereum") {
    throw new Error(`usd1-bundle-oracle only supports ethereum, got "${input.chain}"`);
  }
  const params = parseLiveReserveAdapterParams("usd1-bundle-oracle", config.params);
  const tokenContract = coin.contracts?.find((contract) => contract.chain === input.chain);
  if (!tokenContract) {
    throw new Error(`usd1-bundle-oracle missing ${input.chain} USD1 contract metadata`);
  }

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const [rawBundle, latestBundleTimestamp, rawBundleDecimals, totalSupplyRaw] = await Promise.all([
    onchain.raw(USD1_BUNDLE_ORACLE, LATEST_BUNDLE_SELECTOR),
    onchain.uint256(USD1_BUNDLE_ORACLE, LATEST_BUNDLE_TIMESTAMP_SELECTOR),
    onchain.raw(USD1_BUNDLE_ORACLE, BUNDLE_DECIMALS_SELECTOR),
    fetchErc20TotalSupply(
      input,
      tokenContract.address,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);

  if (!rawBundle) throw new Error("usd1-bundle-oracle latestBundle() call failed");
  if (latestBundleTimestamp == null) throw new Error("usd1-bundle-oracle latestBundleTimestamp() call failed");
  if (!rawBundleDecimals) throw new Error("usd1-bundle-oracle bundleDecimals() call failed");
  if (totalSupplyRaw == null) throw new Error("usd1-bundle-oracle totalSupply() call failed");

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

  return adaptUsd1BundleOracle({
    bundle,
    latestBundleTimestamp,
    bundleDecimals,
    totalSupplyRaw,
    tokenDecimals: tokenContract.decimals,
  });
}
