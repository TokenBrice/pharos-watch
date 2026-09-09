import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { AdapterContext, AdapterResult } from "./types";
import {
  aggregateMultichainErc20Supply,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  makeOnchainCallers,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  verifiedFreshnessMetadata,
  type MultichainSupplyAggregate,
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

export type Usd1SupplyAggregate = MultichainSupplyAggregate;

export function adaptUsd1BundleOracle(input: {
  bundle: `0x${string}`;
  latestBundleTimestamp: bigint;
  bundleDecimals: readonly number[];
  supply: Usd1SupplyAggregate;
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

  const warnings: LiveReserveWarning[] = [];
  if (input.supply.omittedNonEvmChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-chain-omitted",
        `Supply aggregation omits non-EVM chains: ${input.supply.omittedNonEvmChains.join(", ")}`,
      ),
    );
  }
  if (input.supply.omittedNoRpcChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-chain-omitted",
        `Supply aggregation omits chains with no RPC configured: ${input.supply.omittedNoRpcChains.join(", ")}`,
      ),
    );
  }
  if (input.supply.omittedReadFailureChains.length > 0) {
    warnings.push(
      reserveDegradedWarning(
        "partial-supply-read-failure",
        `Supply aggregation omits chains whose totalSupply() read failed: ${input.supply.omittedReadFailureChains.join(", ")}`,
      ),
    );
  }

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
        fundScope: "WLFI aggregate fund reserves; denominator is USD1 supply only",
      },
      totalReserveUsd,
      supplyUsd,
      fundBackingTotalRatio: totalReserveUsd / supplyUsd,
      totalReservesRaw: totalReserveRaw.toString(),
      reserveDecimals,
      supplyContributions: input.supply.contributions.map((contribution) => ({
        chain: contribution.chain,
        tokenAddress: contribution.tokenAddress,
        supplyRaw: contribution.raw.toString(),
        decimals: contribution.decimals,
      })),
      supplyReadComplete: input.supply.omittedReadFailureChains.length === 0,
      ...(primaryContribution
        ? {
            supplyRaw: primaryContribution.raw.toString(),
            supplyDecimals: primaryContribution.decimals,
            supplyTokenAddress: primaryContribution.tokenAddress,
          }
        : {}),
      redemption: buildDocumentedRedemptionTelemetry(bundleTimestamp, { holderEligibility: "verified-customer" }),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
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

  // Aggregate totalSupply across every registry-typed EVM + Tron chain in
  // coin.contracts, mirroring chainlink-por's multichain liability scope.
  // Non-EVM chains (Solana, Aptos, …) are omitted from the gross-supply
  // denominator and surfaced as an info warning.
  const chainPlans = new Map([[input.chain, Promise.resolve(plan)]]);
  const supply = await aggregateMultichainErc20Supply({
    coin,
    adapterKey: "usd1-bundle-oracle",
    signal,
    ctx,
    tronCtx: baseCtx,
    readEvmSupply: async (contract) => {
      let chainPlan = chainPlans.get(contract.chain);
      if (!chainPlan) {
        // Primary RPC overrides and any inherited pin belong to Ethereum.
        chainPlan = pinnedBlockPlan({ chain: contract.chain, signal, ctx: { ...baseCtx, observedBlock: undefined } });
        chainPlans.set(contract.chain, chainPlan);
      }
      const pinned = await chainPlan;
      return fetchErc20TotalSupply(
        { ...input, chain: contract.chain }, contract.address, signal, pinned.ctx,
        contract.chain === input.chain ? params.rpcUrl : undefined,
        contract.chain === input.chain ? params.fallbackRpcUrl : undefined,
      );
    },
  });

  const result = adaptUsd1BundleOracle({
    bundle,
    latestBundleTimestamp,
    bundleDecimals,
    supply,
  });
  return { ...result, metadata: { ...result.metadata, observedBlock: plan.observedBlock } };
}
