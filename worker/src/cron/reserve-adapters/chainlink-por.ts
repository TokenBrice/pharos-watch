import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchTronErc20TotalSupply,
  makeOnchainCallers,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;
const CHAINLINK_POR_RESERVE_UNITS = ["USD", "XAU", "XAG"] as const;

export type ChainlinkPorReserveUnit = (typeof CHAINLINK_POR_RESERVE_UNITS)[number];

const COMMODITY_RESERVE_UNIT_LABELS = {
  XAU: "troy ounces of gold",
  XAG: "troy ounces of silver",
} as const satisfies Record<Exclude<ChainlinkPorReserveUnit, "USD">, string>;

export interface ChainlinkPorParams {
  porFeedAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  reserveUnit?: ChainlinkPorReserveUnit;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
}

interface ChainlinkPorData {
  reserves: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: number;
}

export interface ChainlinkPorSupplyContribution {
  chain: string;
  tokenAddress: string;
  raw: bigint;
  decimals: number;
}

export interface ChainlinkPorSupplyAggregate {
  contributions: ChainlinkPorSupplyContribution[];
  omittedNonEvmChains: string[];
  omittedReadFailureChains: string[];
}

function isEvmContract(contract: ContractDeployment): boolean {
  return contract.chain !== "tron" && contract.chain !== "solana";
}

function isTronContract(contract: ContractDeployment): boolean {
  return contract.chain === "tron";
}

function parseReserveUnit(raw: unknown): ChainlinkPorReserveUnit | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string" && CHAINLINK_POR_RESERVE_UNITS.includes(raw as ChainlinkPorReserveUnit)) {
    return raw as ChainlinkPorReserveUnit;
  }
  throw new Error("chainlink-por adapter params invalid.reserveUnit: Expected USD, XAU, or XAG");
}

function readParams(config: LiveReservesConfig): ChainlinkPorParams {
  const { reserveUnit: rawReserveUnit, ...schemaParams } = config.params ?? {};
  const parsed = parseLiveReserveAdapterParams("chainlink-por", schemaParams);
  return {
    ...parsed,
    reserveUnit: parseReserveUnit(rawReserveUnit),
  };
}

function inferReserveUnit(coin: StablecoinMeta, params: ChainlinkPorParams): ChainlinkPorReserveUnit {
  if (params.reserveUnit) return params.reserveUnit;
  if (coin.flags.pegCurrency === "GOLD") return "XAU";
  if (coin.flags.pegCurrency === "SILVER") return "XAG";
  return "USD";
}

function buildReserveValueMetadata(
  reserveValue: number,
  reserveUnit: ChainlinkPorReserveUnit,
): Record<string, unknown> {
  if (reserveUnit === "USD") {
    return { totalReserveUsd: reserveValue };
  }

  return {
    reserveUnit,
    reserveUnitLabel: COMMODITY_RESERVE_UNIT_LABELS[reserveUnit],
    totalReserveQuantity: reserveValue,
  };
}

/** Pure transformation from decoded Chainlink data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkPorResponse(
  data: ChainlinkPorData,
  params: ChainlinkPorParams,
  supply?: ChainlinkPorSupplyAggregate | null,
): AdapterResult {
  if (data.reserves <= 0n) {
    throw new Error("chainlink-por: feed reported zero or negative reserves");
  }

  const reserveUnit = params.reserveUnit ?? "USD";
  const reserveValue = decimalNumberFromBigInt(data.reserves, data.decimals);
  const compareSupplyAsUsd = reserveUnit === "USD";
  const supplyUsd =
    compareSupplyAsUsd && supply && supply.contributions.length > 0
      ? supply.contributions.reduce(
          (acc, contribution) => acc + decimalNumberFromBigInt(contribution.raw, contribution.decimals),
          0,
        )
      : undefined;
  const collateralizationRatio = supplyUsd != null && supplyUsd > 0 ? reserveValue / supplyUsd : undefined;

  const warnings: LiveReserveWarning[] = buildCoverageShortfallWarnings({
    code: "por-reserve-under-supply",
    message: (pct) => `Chainlink PoR reserves cover ${pct}% of multichain token supply`,
    coverageRatio: collateralizationRatio,
  });
  if (collateralizationRatio != null && collateralizationRatio > 1.1) {
    warnings.push(
      reserveDegradedWarning(
        "por-reserve-over-supply",
        `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of multichain token supply (possible scope mismatch)`,
      ),
    );
  }
  if (supply && supply.omittedNonEvmChains.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-chain-omitted",
        `Supply aggregation omits non-EVM chains: ${supply.omittedNonEvmChains.join(", ")}`,
      ),
    );
  }
  if (supply && supply.omittedReadFailureChains.length > 0) {
    warnings.push(
      reserveDegradedWarning(
        "partial-supply-read-failure",
        `Supply aggregation omits chains whose totalSupply() read failed: ${supply.omittedReadFailureChains.join(", ")}`,
      ),
    );
  }

  const primaryContribution = supply?.contributions[0];

  return {
    slices: [
      {
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    metadata: {
      totalReservesRaw: data.reserves.toString(),
      feedDecimals: data.decimals,
      feedRoundId: data.roundId.toString(),
      feedUpdatedAt: data.updatedAt,
      sourceTimestamp: data.updatedAt,
      freshnessMode: "verified",
      redemption: buildDocumentedRedemptionTelemetry(data.updatedAt),
      ...buildReserveValueMetadata(reserveValue, reserveUnit),
      ...(supplyUsd != null
        ? {
            supplyUsd,
            supplyContributions: supply!.contributions.map((contribution) => ({
              chain: contribution.chain,
              tokenAddress: contribution.tokenAddress,
              supplyRaw: contribution.raw.toString(),
              decimals: contribution.decimals,
            })),
            supplyReadComplete: supply!.omittedReadFailureChains.length === 0,
            ...(primaryContribution
              ? {
                  supplyRaw: primaryContribution.raw.toString(),
                  supplyDecimals: primaryContribution.decimals,
                  supplyTokenAddress: primaryContribution.tokenAddress,
                }
              : {}),
          }
        : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function fetchChainlinkPorReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-por");
  const parsedParams = readParams(config);
  const params: ChainlinkPorParams = {
    ...parsedParams,
    reserveUnit: inferReserveUnit(coin, parsedParams),
  };

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  // 1. Fetch feed decimals (single uint8)
  const rawDecimals = await onchain.uint256(params.porFeedAddress, DECIMALS_SELECTOR);
  if (rawDecimals == null) {
    throw new Error("chainlink-por: decimals() call failed");
  }
  const decimals = Number(rawDecimals);

  // 2. Fetch latestRoundData() (5 words)
  const rawRoundData = await onchain.raw(params.porFeedAddress, LATEST_ROUND_DATA_SELECTOR);
  if (rawRoundData == null) {
    throw new Error("chainlink-por: latestRoundData() call failed");
  }

  const { roundId, answer, updatedAt } = parseChainlinkLatestRoundData(rawRoundData, "chainlink-por");
  const maxOracleAgeSec = params.maxOracleAgeSec ?? DEFAULT_MAX_ORACLE_AGE_SEC;
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  if (updatedAt > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(`chainlink-por: feed data timestamp is in the future (${updatedAt - now}s)`);
  }
  const ageSec = now - updatedAt;
  if (ageSec > maxOracleAgeSec) {
    throw new Error(`chainlink-por: feed data is stale (${ageSec}s > ${maxOracleAgeSec}s)`);
  }

  if (params.reserveUnit !== "USD") {
    return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params, null);
  }

  // 3. Aggregate totalSupply across all EVM + Tron chains in coin.contracts.
  //    Solana is the only chain still omitted, surfaced as an info warning.
  const allContracts = coin.contracts ?? [];
  const evmContracts = allContracts.filter(isEvmContract);
  const tronContracts = allContracts.filter(isTronContract);
  const omittedNonEvmChains = allContracts
    .filter((c) => !isEvmContract(c) && !isTronContract(c))
    .map((c) => c.chain);
  const readableContracts = [...evmContracts, ...tronContracts];

  if (readableContracts.length === 0) {
    throw new Error(`chainlink-por: no EVM or Tron contracts available for ${coin.id}`);
  }

  const supplyReads = await Promise.all(
    readableContracts.map(async (contract) => {
      if (contract.decimals == null) {
        logWorkerEventArgs("handler", "warn",
          `[chainlink-por] ${contract.chain} supply probe skipped for ${coin.symbol}: contract decimals are missing`,
        );
        return { contract, raw: null };
      }
      const raw = isTronContract(contract)
        ? await fetchTronErc20TotalSupply(contract.address, signal, ctx)
        : await fetchErc20TotalSupply(
            { ...input, chain: contract.chain },
            contract.address,
            signal,
            ctx,
            params.rpcUrl,
            params.fallbackRpcUrl,
          );
      return { contract, raw };
    }),
  );

  const successful = supplyReads.filter(
    (entry): entry is { contract: ContractDeployment; raw: bigint } => entry.raw != null && entry.raw > 0n,
  );
  const failed = supplyReads.filter((entry) => entry.raw == null || entry.raw <= 0n);

  if (successful.length === 0) {
    throw new Error(`chainlink-por: totalSupply() calls failed on all EVM/Tron chains for ${coin.id}`);
  }

  const supplyAggregate: ChainlinkPorSupplyAggregate = {
    contributions: successful.map((entry) => ({
      chain: entry.contract.chain,
      tokenAddress: entry.contract.address,
      raw: entry.raw,
      decimals: entry.contract.decimals,
    })),
    omittedNonEvmChains,
    omittedReadFailureChains: failed.map((entry) => entry.contract.chain),
  };

  return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params, supplyAggregate);
}
