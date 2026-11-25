import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  LATEST_ROUND_DATA_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { requireChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  decimalStringFromBigInt,
  fetchOnchainMulticall3,
  freshnessMetadataFromTimestamp,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { decodeUint256Word } from "./abi-decode";
import { validateDecimals } from "./slice-math";
import { chainlinkNavMaxOracleAgeSec } from "./chainlink-nav-freshness";

export type ChainlinkNavParams = LiveReserveAdapterParamsByKey["chainlink-nav"];

export interface ChainlinkNavData {
  navPerToken: bigint;
  navDecimals: number;
  totalSupply: bigint;
  tokenDecimals: number;
  roundId: bigint;
  updatedAt: number;
  oracleTimestampSource?: "oracle-round" | "unavailable";
  /** Deployment whose contract supply is read; the datum is chain-scoped. */
  chain?: string;
  tokenAddress?: string;
}

function decodeDecimalsResult(raw: bigint | null, source: string): number {
  if (raw == null) {
    throw new Error(`chainlink-nav: ${source} decimals() call failed`);
  }
  try {
    return validateDecimals(raw, `chainlink-nav: ${source} decimals`);
  } catch {
    throw new Error(`chainlink-nav: ${source} decimals out of range (${raw})`);
  }
}

/** Pure transformation from decoded NAV oracle data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkNavResponse(data: ChainlinkNavData, params: ChainlinkNavParams): AdapterResult {
  if (data.navPerToken <= 0n) {
    throw new Error("chainlink-nav: oracle reported zero or negative NAV per token");
  }

  const oracleTimestampSource = data.oracleTimestampSource ?? (data.roundId === 0n ? "unavailable" : "oracle-round");

  return {
    slices: [
      {
        ...(params.sourceKey ? { sourceKey: params.sourceKey } : {}),
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    ...(params.navScope === "portfolio"
      ? {
        warnings: [reserveDegradedWarning(
          "nav-portfolio-composition-unverified",
          "NAV values the portfolio but does not verify its composition; dated holdings are required for scoring",
        )],
      }
      : {}),
    metadata: {
      navPerToken: decimalStringFromBigInt(data.navPerToken, data.navDecimals),
      totalSupplyFormatted: decimalStringFromBigInt(data.totalSupply, data.tokenDecimals),
      totalSupplyRaw: data.totalSupply.toString(),
      // The contract read is one deployment, never the token's cross-chain total.
      ...(data.chain ? { totalSupplyChain: data.chain } : {}),
      ...(data.tokenAddress ? { totalSupplyTokenAddress: data.tokenAddress } : {}),
      navDecimals: data.navDecimals,
      tokenDecimals: data.tokenDecimals,
      oracleRoundId: data.roundId.toString(),
      oracleUpdatedAt: data.updatedAt,
      oracleTimestampSource,
      ...freshnessMetadataFromTimestamp(
        data.updatedAt > 0 ? data.updatedAt : null,
        "onchain-oracle-round",
        "chainlink-nav oracle did not expose an update timestamp",
      ),
      redemption: buildDocumentedRedemptionTelemetry(data.updatedAt > 0 ? data.updatedAt : null),
    },
  };
}

/**
 * Shared NAV-read core. Fetches standard AggregatorV3Interface oracle + token
 * data in one Multicall3 batch, validates freshness, and produces an
 * AdapterResult. Used by the `chainlink-nav` and `superstate-liquidity`
 * registry-bound adapters.
 */
export async function fetchChainlinkNavCore(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-nav");
  const params = parseLiveReserveAdapterParams("chainlink-nav", config.params);
  const warnings = [];

  // Standard AggregatorV3Interface: decimals() + latestRoundData()
  const feedReads = await fetchOnchainMulticall3({
    calls: [
      { label: "token-decimals", contract: params.tokenAddress, data: DECIMALS_SELECTOR },
      { label: "token-total-supply", contract: params.tokenAddress, data: TOTAL_SUPPLY_SELECTOR },
      { label: "oracle-decimals", contract: params.oracleAddress, data: DECIMALS_SELECTOR },
      { label: "oracle-latest-round-data", contract: params.oracleAddress, data: LATEST_ROUND_DATA_SELECTOR },
    ],
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const resultData = (label: string) => {
    const result = feedReads?.find((entry) => entry.label === label);
    return result?.success ? result.returnData : null;
  };
  const rawTokenDecimals = decodeUint256Word(resultData("token-decimals"));
  const rawTotalSupply = decodeUint256Word(resultData("token-total-supply"));
  const rawOracleDecimals = decodeUint256Word(resultData("oracle-decimals"));
  const navDecimals = decodeDecimalsResult(rawOracleDecimals, "oracle");

  const rawRoundData = resultData("oracle-latest-round-data");
  if (rawRoundData == null) {
    throw new Error("chainlink-nav: latestRoundData() call failed");
  }
  const parsed = requireChainlinkLatestRoundData(rawRoundData, "chainlink-nav");
  const navPerToken = parsed.answer;
  const roundId = parsed.roundId;
  const updatedAt = parsed.updatedAt;
  const oracleTimestampSource: ChainlinkNavData["oracleTimestampSource"] = "oracle-round";

  if (updatedAt > 0) {
    const maxOracleAgeSec = chainlinkNavMaxOracleAgeSec(params);
    const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    if (updatedAt > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
      throw new Error(`chainlink-nav: oracle data timestamp is in the future (${updatedAt - now}s)`);
    }
    const ageSec = now - updatedAt;
    if (ageSec > maxOracleAgeSec) {
      throw new Error(`chainlink-nav: oracle data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
    }
  }

  const tokenDecimals = decodeDecimalsResult(rawTokenDecimals, "token");
  if (rawTotalSupply == null) {
    throw new Error("chainlink-nav: token totalSupply() call failed");
  }

  const adapted = adaptChainlinkNavResponse(
    {
      navPerToken,
      navDecimals,
      totalSupply: rawTotalSupply,
      tokenDecimals,
      roundId,
      updatedAt,
      oracleTimestampSource,
      chain: input.chain,
      tokenAddress: params.tokenAddress,
    },
    params,
  );
  // The contract supply read is one deployment, never the token's cross-chain
  // total. When the catalog lists other deployments, say the supply perimeter
  // is incomplete instead of publishing the single-chain number as complete.
  const omittedDeploymentChains = Array.from(new Set(
    (coin.contracts ?? [])
      .filter((contract) => contract.chain !== input.chain)
      .map((contract) => contract.chain),
  )).sort();
  if (omittedDeploymentChains.length > 0) {
    adapted.metadata = {
      ...adapted.metadata,
      supplyReadComplete: true,
      supplyCoverageComplete: false,
    };
    warnings.push(reserveInfoWarning(
      "por-supply-chain-omitted",
      `Supply is read from ${input.chain} only; catalog deployments omitted: ${omittedDeploymentChains.join(", ")}`,
    ));
  }
  return warnings.length > 0 ? { ...adapted, warnings: [...(adapted.warnings ?? []), ...warnings] } : adapted;
}
