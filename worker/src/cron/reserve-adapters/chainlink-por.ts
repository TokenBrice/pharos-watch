import { toErrorMessage } from "@shared/lib/error-utils";
import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { AdapterContext, AdapterResult } from "./types";
import { parseChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchJsonPostWithRetry,
  fetchTronErc20TotalSupply,
  makeOnchainCallers,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;
const CHAINLINK_POR_RESERVE_UNITS = ["USD", "XAU", "XAG", "SHARES"] as const;

export type ChainlinkPorReserveUnit = (typeof CHAINLINK_POR_RESERVE_UNITS)[number];

const NON_USD_RESERVE_UNIT_LABELS = {
  XAU: "troy ounces of gold",
  XAG: "troy ounces of silver",
  SHARES: "underlying fund shares",
} as const satisfies Record<Exclude<ChainlinkPorReserveUnit, "USD">, string>;

/** Units whose feed answer is comparable against token supply: USD-valued
 *  reserves, and 1:1 tracker-certificate share quantities (SHARES). Commodity
 *  quantity feeds (XAU/XAG) prove physical holdings, not a per-token claim. */
const SUPPLY_COMPARABLE_RESERVE_UNITS: Record<ChainlinkPorReserveUnit, boolean> = {
  USD: true,
  XAU: false,
  XAG: false,
  SHARES: true,
};

export interface ChainlinkPorIssuerCirculationProbe {
  kind: "backed-graphql";
  url: string;
  reserveSymbol: string;
}

export interface ChainlinkPorParams {
  porFeedAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  reserveUnit?: ChainlinkPorReserveUnit;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  maxOracleAgeSec?: number;
  issuerCirculationProbe?: ChainlinkPorIssuerCirculationProbe;
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

export interface ChainlinkPorCirculationContribution {
  chain: string;
  tokenAddress: string;
  circulatingRaw: string;
  decimals: number;
}

/** Issuer-published circulating supply, admitted only when every nonzero
 *  deployment matched a canonical configured contract (address + chain). */
export interface ChainlinkPorCirculationAggregate {
  circulatingTokens: number;
  contributions: ChainlinkPorCirculationContribution[];
}

export interface ChainlinkPorCirculationProbeFailure {
  reason: string;
  unmatchedDeployments?: Array<{ chainId: string; network?: string; address?: string }>;
}

export type ChainlinkPorCirculationOutcome =
  | { aggregate: ChainlinkPorCirculationAggregate; failure?: undefined }
  | { aggregate?: undefined; failure: ChainlinkPorCirculationProbeFailure };

function isEvmContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "evm";
}

function isTronContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "tron";
}

function parseReserveUnit(raw: unknown): ChainlinkPorReserveUnit | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string" && CHAINLINK_POR_RESERVE_UNITS.includes(raw as ChainlinkPorReserveUnit)) {
    return raw as ChainlinkPorReserveUnit;
  }
  throw new Error("chainlink-por adapter params invalid.reserveUnit: Expected USD, XAU, XAG, or SHARES");
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
    reserveUnitLabel: NON_USD_RESERVE_UNIT_LABELS[reserveUnit],
    totalReserveQuantity: reserveValue,
  };
}

const BACKED_CIRCULATION_QUERY =
  "{ assetReserves { symbol token { symbol deployments { chainId network address totalSupply circulatingSupply } } } }";

interface BackedDeployment {
  chainId?: string | number;
  network?: string;
  address?: string;
  totalSupply?: string | number | null;
  circulatingSupply?: string | number | null;
}

export interface BackedAssetReservesResponse {
  data?: {
    assetReserves?: Array<{
      symbol?: string;
      token?: Array<{ symbol?: string; deployments?: BackedDeployment[] }>;
    }>;
  };
}

function parseRawUnits(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Pure projection of Backed's public assetReserves GraphQL payload onto the
 * coin's canonical contract roster. Backed distinguishes gross `totalSupply`
 * (which includes unsold issuer pre-mint inventory) from `circulatingSupply`
 * (the actual reserve liability). Every deployment with nonzero circulating
 * supply MUST match a configured contract (chain + address) so its decimals
 * are canonical; any unmatched or unparseable nonzero deployment fails the
 * probe closed instead of guessing scale. Exported for testing.
 */
export function adaptBackedCirculationResponse(
  payload: BackedAssetReservesResponse,
  probe: ChainlinkPorIssuerCirculationProbe,
  contracts: readonly ContractDeployment[],
): ChainlinkPorCirculationOutcome {
  const row = payload.data?.assetReserves?.find((entry) => entry.symbol === probe.reserveSymbol);
  if (!row) {
    return { failure: { reason: `assetReserves row not found for symbol ${probe.reserveSymbol}` } };
  }
  const deployments = (row.token ?? []).flatMap((token) => token.deployments ?? []);
  if (deployments.length === 0) {
    return { failure: { reason: `assetReserves row for ${probe.reserveSymbol} exposes no token deployments` } };
  }

  const contributions: ChainlinkPorCirculationContribution[] = [];
  const unmatched: Array<{ chainId: string; network?: string; address?: string }> = [];
  let circulatingTokens = 0;
  for (const deployment of deployments) {
    const circulatingRaw = parseRawUnits(deployment.circulatingSupply);
    if (circulatingRaw == null) {
      const totalRaw = parseRawUnits(deployment.totalSupply);
      if (totalRaw === 0) continue;
      return {
        failure: {
          reason: `deployment ${deployment.network ?? deployment.chainId ?? "?"} has no parseable circulatingSupply`,
        },
      };
    }
    if (circulatingRaw === 0) continue;
    const chainIdNumber = Number(deployment.chainId);
    const chain = Number.isInteger(chainIdNumber) ? resolveChainId(chainIdNumber) : null;
    const address = typeof deployment.address === "string" ? deployment.address.toLowerCase() : null;
    const contract = chain != null && address != null
      ? contracts.find((entry) => entry.chain === chain && entry.address.toLowerCase() === address)
      : undefined;
    if (!contract || contract.decimals == null) {
      unmatched.push({
        chainId: String(deployment.chainId ?? "?"),
        ...(deployment.network != null ? { network: deployment.network } : {}),
        ...(deployment.address != null ? { address: deployment.address } : {}),
      });
      continue;
    }
    circulatingTokens += circulatingRaw / 10 ** contract.decimals;
    contributions.push({
      chain: contract.chain,
      tokenAddress: contract.address,
      circulatingRaw: String(deployment.circulatingSupply),
      decimals: contract.decimals,
    });
  }

  if (unmatched.length > 0) {
    return {
      failure: {
        reason: "nonzero circulating deployments did not match a configured canonical contract",
        unmatchedDeployments: unmatched,
      },
    };
  }
  return { aggregate: { circulatingTokens, contributions } };
}

async function fetchIssuerCirculation(
  probe: ChainlinkPorIssuerCirculationProbe,
  contracts: readonly ContractDeployment[],
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ChainlinkPorCirculationOutcome> {
  try {
    const payload = await fetchJsonPostWithRetry<BackedAssetReservesResponse>(
      probe.url,
      { query: BACKED_CIRCULATION_QUERY },
      signal,
      10_000,
      ctx,
    );
    return adaptBackedCirculationResponse(payload, probe, contracts);
  } catch (error) {
    return { failure: { reason: toErrorMessage(error) } };
  }
}

/** Pure transformation from decoded Chainlink data + params → AdapterResult. Exported for testing. */
export function adaptChainlinkPorResponse(
  data: ChainlinkPorData,
  params: ChainlinkPorParams,
  supply?: ChainlinkPorSupplyAggregate | null,
  circulation?: ChainlinkPorCirculationOutcome | null,
): AdapterResult {
  if (data.reserves <= 0n) {
    throw new Error("chainlink-por: feed reported zero or negative reserves");
  }

  const reserveUnit = params.reserveUnit ?? "USD";
  const reserveValue = decimalNumberFromBigInt(data.reserves, data.decimals);
  const comparesSupply = SUPPLY_COMPARABLE_RESERVE_UNITS[reserveUnit];
  const supplyTokens =
    comparesSupply && supply && supply.contributions.length > 0
      ? supply.contributions.reduce(
          (acc, contribution) => acc + decimalNumberFromBigInt(contribution.raw, contribution.decimals),
          0,
        )
      : undefined;
  const probeActive = params.issuerCirculationProbe != null && comparesSupply;
  const circulatingTokens = probeActive ? circulation?.aggregate?.circulatingTokens : undefined;
  // Issuer-published circulation must stay inside the on-chain gross supply
  // envelope; a circulation figure above what is minted is implausible and
  // withholds the coverage verdict instead of shrinking the liability.
  const circulationPlausible =
    circulatingTokens != null && (supplyTokens == null || circulatingTokens <= supplyTokens * 1.001);
  // When a probe is configured, gross totalSupply is proven non-authoritative
  // (it includes unsold issuer pre-mint inventory), so a failed or implausible
  // probe publishes NO coverage ratio rather than a misleading gross one.
  const liabilityBasis: "issuer-circulating" | "onchain-total-supply" | undefined = probeActive
    ? (circulationPlausible ? "issuer-circulating" : undefined)
    : "onchain-total-supply";
  const liabilityTokens =
    liabilityBasis === "issuer-circulating" ? circulatingTokens : liabilityBasis != null ? supplyTokens : undefined;
  const collateralizationRatio =
    liabilityTokens != null && liabilityTokens > 0 ? reserveValue / liabilityTokens : undefined;

  const liabilityLabel = liabilityBasis === "issuer-circulating"
    ? "issuer-reported circulating supply"
    : "multichain token supply";
  const warnings: LiveReserveWarning[] = buildCoverageShortfallWarnings({
    code: "por-reserve-under-supply",
    message: (pct) => `Chainlink PoR reserves cover ${pct}% of ${liabilityLabel}`,
    coverageRatio: collateralizationRatio,
  });
  if (collateralizationRatio != null && collateralizationRatio > 1.1) {
    warnings.push(
      liabilityBasis === "issuer-circulating"
        ? reserveInfoWarning(
            "por-reserve-over-supply",
            `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of issuer-reported circulating supply; the surplus is issuer-held inventory backing`,
          )
        : reserveDegradedWarning(
            "por-reserve-over-supply",
            `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of multichain token supply (possible scope mismatch)`,
          ),
    );
  }
  if (probeActive && circulation?.failure) {
    warnings.push(
      reserveDegradedWarning(
        "por-circulation-probe-failed",
        `Issuer circulation probe failed; no authoritative coverage ratio this run: ${circulation.failure.reason}`,
      ),
    );
  }
  if (probeActive && circulatingTokens != null && !circulationPlausible) {
    warnings.push(
      reserveDegradedWarning(
        "por-circulation-implausible",
        `Issuer-reported circulating supply (${circulatingTokens.toFixed(2)}) exceeds on-chain multichain supply; no authoritative coverage ratio this run`,
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
      ...(supplyTokens != null
        ? {
            // USD feeds value both sides in dollars; SHARES feeds compare
            // share quantities against token quantities (1:1 tracker claims).
            ...(reserveUnit === "USD" ? { supplyUsd: supplyTokens } : { supplyTokens }),
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
      ...(probeActive
        ? {
            ...(liabilityBasis != null ? { liabilityBasis } : {}),
            ...(circulation?.aggregate
              ? {
                  circulatingSupplyTokens: circulation.aggregate.circulatingTokens,
                  circulationContributions: circulation.aggregate.contributions,
                }
              : {}),
            ...(circulation?.failure
              ? {
                  circulationProbeFailure: {
                    reason: circulation.failure.reason,
                    ...(circulation.failure.unmatchedDeployments
                      ? { unmatchedDeployments: circulation.failure.unmatchedDeployments }
                      : {}),
                  },
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

  if (!SUPPLY_COMPARABLE_RESERVE_UNITS[params.reserveUnit ?? "USD"]) {
    return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params, null);
  }

  // 3. Aggregate totalSupply across every registry-typed EVM + Tron chain in
  //    coin.contracts. Non-EVM chains (Solana, NEAR, …) are omitted from the
  //    gross-supply diagnostic and surfaced as an info warning.
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
  // A null read is an RPC/read failure; a zero read is a valid empty deployment
  // (for example a chain whose supply was fully burned or never minted).
  const failed = supplyReads.filter((entry) => entry.raw == null);

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

  const circulation = params.issuerCirculationProbe
    ? await fetchIssuerCirculation(params.issuerCirculationProbe, allContracts, signal, ctx)
    : null;

  return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params, supplyAggregate, circulation);
}
