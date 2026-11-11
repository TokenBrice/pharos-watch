import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import type { LiabilityRatioUnavailableReason, LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { requireChainlinkLatestRoundData } from "../../lib/pricing/chainlink-round-data";
import {
  aggregateMultichainErc20Supply,
  aggregateScopedLiabilitySupply,
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  evaluateLiabilityCoverage,
  fetchErc20TotalSupply,
  fetchOnchainMulticall3,
  pinnedEvmTokenReader,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  type MultichainSupplyAggregate,
  type ScopedLiabilitySupply,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { decodeUint256Word } from "./abi-decode";
import {
  BACKED_INVENTORY_OWNERS,
  BACKED_POLICIES,
  fetchIssuerCirculation,
  fetchVerifiedBackedCirculation,
  type ChainlinkPorCirculationOutcome,
} from "./backed-liabilities";
const DEFAULT_MAX_ORACLE_AGE_SEC = 2 * DAY_SECONDS;

export type ChainlinkPorReserveUnit = NonNullable<LiveReserveAdapterParamsByKey["chainlink-por"]["reserveUnit"]>;

const NON_USD_RESERVE_UNIT_LABELS = {
  XAU: "troy ounces of gold",
  XAG: "troy ounces of silver",
  XAU_G: "grams of fine gold",
  XAG_G: "grams of fine silver",
  SHARES: "underlying fund shares",
} as const satisfies Record<Exclude<ChainlinkPorReserveUnit, "USD">, string>;

/** Units whose feed answer is comparable against token supply: USD-valued
 *  reserves, 1:1 tracker-certificate share quantities (SHARES), and
 *  gram-denominated commodity quantities (XAU_G/XAG_G) for tokens pegged to
 *  one gram of the metal (e.g. Kinesis KAU: 1 token = 1 g of fine gold).
 *  Troy-ounce commodity feeds (XAU/XAG) prove physical holdings, not a
 *  per-token claim, so their quantities are never divided by token supply. */
const SUPPLY_COMPARABLE_RESERVE_UNITS: Record<ChainlinkPorReserveUnit, boolean> = {
  USD: true,
  XAU: false,
  XAG: false,
  XAU_G: true,
  XAG_G: true,
  SHARES: true,
};

export type ChainlinkPorParams = LiveReserveAdapterParamsByKey["chainlink-por"];

interface ChainlinkPorData {
  reserves: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: number;
}

export type ChainlinkPorSupplyAggregate = MultichainSupplyAggregate | ScopedLiabilitySupply;

function inferReserveUnit(coin: ReserveAdapterCoin, params: ChainlinkPorParams): ChainlinkPorReserveUnit {
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
  // One admission result for every liability basis: the reviewed scope (or,
  // without one, the full registry roster) must be covered and read, and a
  // scoped reserve/supply pair must sit inside the scope's skew bound. A
  // declared not-comparable basis always withholds the ratio.
  const coverage = comparesSupply && supply
    ? evaluateLiabilityCoverage({
        supply,
        ...(params.liabilityScope?.basis === "not-comparable" ? { notComparable: params.liabilityScope } : {}),
        reserveObservedAt: data.updatedAt,
      })
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
  // A timestamp-less endpoint stays diagnostic unless the reviewed inventory
  // policy has independently reproduced every deployment at current blocks.
  const verifiedCirculation = circulationPlausible && circulation?.aggregate?.verifiedAt != null
    && coverage?.supplyCoverageComplete === true;
  const circulationTimes = circulation?.aggregate?.observations?.map((row) => row.timestamp);
  const circulationObservedAt = circulationTimes?.length
    ? { min: Math.min(...circulationTimes), max: Math.max(...circulationTimes) }
    : undefined;
  const circulationSkewSec = circulationObservedAt
    ? Math.max(Math.abs(data.updatedAt - circulationObservedAt.min), Math.abs(data.updatedAt - circulationObservedAt.max))
    : undefined;
  const temporalPolicy = params.issuerCirculationProbe;
  const temporalReason: LiabilityRatioUnavailableReason | undefined = verifiedCirculation
    ? temporalPolicy?.maxReserveSupplySkewSec == null || !temporalPolicy.temporalReview
      ? "reserve-supply-temporal-policy-unreviewed"
      : circulationTimes?.some((timestamp) => !Number.isFinite(timestamp) || timestamp <= 0)
        || circulationSkewSec == null || circulationSkewSec > temporalPolicy.maxReserveSupplySkewSec
        ? "reserve-supply-time-skew"
        : undefined
    : undefined;
  const liabilityBasis = coverage?.ratioUnavailableReason === "not-comparable" ? undefined
    : !probeActive && coverage != null && coverage.ratioUnavailableReason == null ? "onchain-total-supply"
    : verifiedCirculation && temporalReason == null ? "onchain-verified-issuer-circulation" : undefined;
  const liabilityTokens = liabilityBasis === "onchain-verified-issuer-circulation" ? circulatingTokens
    : liabilityBasis === "onchain-total-supply" ? supplyTokens : undefined;
  const collateralizationRatio =
    liabilityTokens != null && liabilityTokens > 0 ? reserveValue / liabilityTokens : undefined;
  const ratioUnavailableReason: LiabilityRatioUnavailableReason | undefined =
    !comparesSupply ? "not-comparable"
    : verifiedCirculation && circulatingTokens === 0 ? "zero-liability-denominator"
    : temporalReason ?? (liabilityTokens === 0 ? "zero-liability-denominator" : coverage?.ratioUnavailableReason);

  const warnings: LiveReserveWarning[] = buildCoverageShortfallWarnings({
    code: "por-reserve-under-supply",
    message: (pct) => `Chainlink PoR reserves cover ${pct}% of multichain token supply`,
    coverageRatio: collateralizationRatio,
  });
  if (collateralizationRatio != null && collateralizationRatio > 1.1) {
    warnings.push(reserveDegradedWarning(
      "por-reserve-over-supply",
      `Chainlink PoR reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of multichain token supply (possible scope mismatch)`,
    ));
  }
  if (probeActive && !verifiedCirculation) {
    warnings.push(reserveDegradedWarning(
      "por-circulation-freshness-unverified",
      "Issuer circulation has no independently verified source timestamp; retained as diagnostic only, with coverage ratio withheld",
    ));
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
  warnings.push(...(coverage?.warnings ?? []));
  if (temporalReason) {
    warnings.push(reserveInfoWarning(
      temporalReason,
      temporalReason === "reserve-supply-temporal-policy-unreviewed"
        ? "Issuer circulation is verified but no source-reviewed reserve/circulation skew policy is configured; ratio withheld"
        : `Reserve/circulation observations differ by ${circulationSkewSec ?? "unavailable"} seconds; ratio withheld (bound ${temporalPolicy?.maxReserveSupplySkewSec ?? "unreviewed"})`,
    ));
  }

  const primaryContribution = supply?.contributions[0];

  return {
    slices: [
      {
        sourceKey: `chainlink-por:feed:${params.porFeedAddress.toLowerCase()}`,
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
            // USD feeds value both sides in dollars; SHARES and gram-commodity
            // feeds compare quantities against token quantities (1:1 tracker
            // claims; gram units for tokens pegged to one gram).
            ...(reserveUnit === "USD" ? { supplyUsd: supplyTokens } : { supplyTokens }),
            supplyContributions: supply!.contributions.map((contribution) => ({
              chain: contribution.chain,
              tokenAddress: contribution.tokenAddress,
              supplyRaw: contribution.raw.toString(),
              decimals: contribution.decimals,
              ...(contribution.observedAt != null ? { observedAt: contribution.observedAt } : {}),
            })),
            ...coverage!.metadata,
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
                  ...(circulation.aggregate.verifiedAt != null ? {
                    circulationVerifiedAt: circulation.aggregate.verifiedAt,
                    circulationObservations: circulation.aggregate.observations,
                    circulationExcludedInventoryOwners: [...BACKED_INVENTORY_OWNERS],
                  } : {}),
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
      ...(probeActive ? {
        reserveObservedAt: data.updatedAt,
        ...(circulationObservedAt ? { supplyObservedAt: circulationObservedAt } : {}),
        ...(circulationSkewSec != null ? { ratioSkewSec: circulationSkewSec } : {}),
        ...(temporalPolicy?.temporalReview ? { circulationTemporalReview: temporalPolicy.temporalReview } : {}),
      } : {}),
      ...(ratioUnavailableReason ? { ratioUnavailableReason } : {}),
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function fetchChainlinkPorReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-por");
  const parsedParams = parseLiveReserveAdapterParams("chainlink-por", config.params);
  const params: ChainlinkPorParams = {
    ...parsedParams,
    reserveUnit: inferReserveUnit(coin, parsedParams),
  };

  // Fetch the input-independent feed pair in one same-chain aggregate. Supply
  // reads stay separate below because they span the coin's deployment chains.
  const feedReads = await fetchOnchainMulticall3({
    calls: [
      { label: "feed-decimals", contract: params.porFeedAddress, data: DECIMALS_SELECTOR },
      { label: "feed-latest-round-data", contract: params.porFeedAddress, data: LATEST_ROUND_DATA_SELECTOR },
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
  const rawDecimals = decodeUint256Word(resultData("feed-decimals"));
  if (rawDecimals == null) {
    throw new Error("chainlink-por: decimals() call failed");
  }
  const decimals = Number(rawDecimals);

  const rawRoundData = resultData("feed-latest-round-data");
  if (rawRoundData == null) {
    throw new Error("chainlink-por: latestRoundData() call failed");
  }

  const { roundId, answer, updatedAt } = requireChainlinkLatestRoundData(rawRoundData, "chainlink-por");
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

  if (params.issuerCirculationProbe && BACKED_POLICIES[coin.id]) {
    const verified = await fetchVerifiedBackedCirculation(coin, params, input.chain, params.issuerCirculationProbe, signal, ctx);
    return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params,
      verified.supply, verified.circulation);
  }

  const allContracts = coin.contracts ?? [];
  const liabilityScope = params.liabilityScope;
  // A reviewed issuer-native scope reads exactly its included chains, each at
  // a pinned block with on-chain decimals. Without one, totalSupply is
  // aggregated over every registry-typed EVM + Tron deployment, and any chain
  // the roster cannot read withholds the ratio.
  const supplyAggregate: ChainlinkPorSupplyAggregate = liabilityScope?.basis === "issuer-native-supply"
    ? await aggregateScopedLiabilitySupply({
        coin,
        scope: liabilityScope,
        adapterKey: "chainlink-por",
        signal,
        nowSec: now,
        ctx,
        readEvmToken: pinnedEvmTokenReader({
          input,
          signal,
          ctx,
          rpcUrl: params.rpcUrl,
          fallbackRpcUrl: params.fallbackRpcUrl,
        }),
      })
    : await aggregateMultichainErc20Supply({
        coin,
        adapterKey: "chainlink-por",
        signal,
        ctx,
        readEvmSupply: (contract) => fetchErc20TotalSupply(
          { ...input, chain: contract.chain },
          contract.address,
          signal,
          ctx,
          contract.chain === input.chain ? params.rpcUrl : undefined,
          contract.chain === input.chain ? params.fallbackRpcUrl : undefined,
        ),
      });

  const circulation = params.issuerCirculationProbe
    ? await fetchIssuerCirculation(params.issuerCirculationProbe, allContracts, signal, ctx)
    : null;

  return adaptChainlinkPorResponse({ reserves: answer, decimals, roundId, updatedAt }, params, supplyAggregate, circulation);
}
