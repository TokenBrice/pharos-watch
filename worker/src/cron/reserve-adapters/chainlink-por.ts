import { toErrorMessage } from "@shared/lib/error-utils";
import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { AdapterContext, AdapterResult } from "./types";
import { requireChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchJsonPostWithRetry,
  fetchOnchainMulticall3,
  fetchTronErc20TotalSupply,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";
import { decodeUint256Word } from "./abi-decode";
import { pinnedBlockPlan } from "./evm-observation-plan";
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

export interface ChainlinkPorIssuerCirculationProbe {
  kind: "backed-graphql";
  url: string;
  reserveSymbol: string;
}

/** Declared when the readable registry deployments are not the coin's
 *  canonical supply (Kinesis KAU: the feed covers the whole native-chain
 *  program while `totalSupply()` aggregates only the Ethereum representation
 *  wrapper). The aggregate is then a subset of the feed's reserve scope, so the
 *  snapshot publishes quantities and the gap instead of a coverage verdict. */
export interface ChainlinkPorIncompleteSupplyScope {
  chain: string;
  reason: string;
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
  incompleteSupplyScope?: ChainlinkPorIncompleteSupplyScope;
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
  verifiedAt?: number;
  observations?: Array<{ chain: string; block: number; timestamp: number; grossRaw: string; excludedRaw: string }>;
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

// Reviewed issuer policy: backed-fi/DefiLlama-Adapters@f8443518,
// projects/backed/index.js. These inventories are unsold certificates, not
// distributed liabilities. Every current and historical deployment is read;
// the timestamp-less issuer API must corroborate both gross and net exactly.
const BACKED_INVENTORY_OWNERS = [
  "0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad",
  "0x43624c744a4af40754ab19b00b6f681ca56f1e5b",
] as const;
const BACKED_CHAINS = ["ethereum", "polygon", "gnosis", "bsc", "avalanche", "fantom", "base", "arbitrum"];
const BACKED_POLICIES: Record<string, { address: string; symbol: string; reserveSymbol: string; feed: string }> = {
  "bc3m-backed": { address: "0x2f123cf3f37ce3328cc9b5b8415f9ec5109b45e7", symbol: "bC3M", reserveSymbol: "C3M.MI", feed: "0x648e0ff6a36d58f6fce5927cb77601b73cadc2af" },
  "bib01-backed": { address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", symbol: "bIB01", reserveSymbol: "IB01.L", feed: "0xad4395fc414fc1575a7a38c20b0bfdbdb09ee41a" },
};

// The API emits scientific-notation strings for uint256 quantities. Expand
// them without Number rounding; reject fractional, negative or oversized units.
export function parseBackedRawUnits(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || value.length > 160) return null;
  // Input is capped at 160 characters above; exponent expansion is bounded below.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]\+?(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const shift = Number(match[3] ?? 0) - fraction.length;
  let digits = match[1] + fraction;
  if (shift < 0) {
    if (-shift > digits.length || !/^0*$/.test(digits.slice(shift))) return null;
    digits = digits.slice(0, shift) || "0";
  } else {
    if (digits.length + shift > 160) return null;
    digits += "0".repeat(shift);
  }
  const raw = BigInt(digits);
  return raw < 2n ** 256n ? raw : null;
}

async function fetchVerifiedBackedCirculation(
  coin: StablecoinMeta,
  params: ChainlinkPorParams,
  feedChain: string,
  probe: ChainlinkPorIssuerCirculationProbe,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ supply: ChainlinkPorSupplyAggregate; circulation: ChainlinkPorCirculationOutcome }> {
  const policy = BACKED_POLICIES[coin.id];
  const contracts = coin.contracts ?? [];
  let supply: ChainlinkPorSupplyAggregate = {
    contributions: [], omittedNonEvmChains: [], omittedReadFailureChains: BACKED_CHAINS,
  };
  try {
    if (!policy || params.reserveUnit !== "SHARES" || params.porFeedAddress.toLowerCase() !== policy.feed
      || feedChain !== "polygon" || probe.url !== "https://api.backed.fi/graphql" || probe.reserveSymbol !== policy.reserveSymbol
      || contracts.length !== BACKED_CHAINS.length
      || new Set(contracts.map((contract) => contract.chain)).size !== BACKED_CHAINS.length
      || contracts.some((contract) => !BACKED_CHAINS.includes(contract.chain)
        || contract.address.toLowerCase() !== policy.address || contract.decimals !== 18)) {
      throw new Error("Backed reviewed deployment policy mismatch");
    }
    const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    const settled = await Promise.allSettled(contracts.map(async (contract) => {
      const plan = await pinnedBlockPlan({ chain: contract.chain, signal,
        ctx: { ...ctx, observedBlock: ctx?.observedBlock?.chain === contract.chain ? ctx.observedBlock : undefined } });
      if (now - plan.observedBlock.timestamp > 300 || plan.observedBlock.timestamp > now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
        throw new Error(`Backed ${contract.chain} observation block is not current`);
      }
      const calls = [
        { label: "gross", contract: contract.address, data: TOTAL_SUPPLY_SELECTOR },
        ...BACKED_INVENTORY_OWNERS.map((owner, index) => ({ label: `inventory${index}`, contract: contract.address, data: encodeBalanceOfCallData(owner) })),
      ];
      const rows = await fetchOnchainMulticall3({ chain: contract.chain, signal, ctx: plan.ctx, calls });
      const values = calls.map((call) => {
        const matches = rows?.filter((row) => row.label === call.label);
        if (matches?.length !== 1 || !matches[0].success) throw new Error(`Backed ${contract.chain} ${call.label} read failed`);
        const raw = decodeUint256Word(matches[0].returnData);
        if (raw == null) throw new Error(`Backed ${contract.chain} ${call.label} malformed uint256`);
        return raw;
      });
      const [gross, workingCapital, treasury] = values;
      const excluded = workingCapital + treasury;
      if (excluded > gross) throw new Error(`Backed ${contract.chain} inventory exceeds total supply`);
      return { contract, gross, excluded, net: gross - excluded, block: plan.observedBlock };
    }));
    const reads = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    supply = { contributions: reads.map((read) => ({ chain: read.contract.chain, tokenAddress: read.contract.address,
      raw: read.gross, decimals: 18 })), omittedNonEvmChains: [], omittedReadFailureChains: [] };
    const payload = await fetchJsonPostWithRetry<BackedAssetReservesResponse>(probe.url,
      { query: BACKED_CIRCULATION_QUERY }, signal, 10_000, ctx);
    const assets = payload.data?.assetReserves?.filter((row) => row.symbol === policy.reserveSymbol);
    if (assets?.length !== 1 || assets[0].token?.length !== 1 || assets[0].token[0].symbol !== policy.symbol) {
      throw new Error("Backed issuer asset/token identity mismatch");
    }
    const deployments = assets[0].token[0].deployments;
    if (!deployments?.length) throw new Error("Backed issuer deployment list is empty");
    const seen = new Set<string>();
    for (const deployment of deployments) {
      const numericChainId = Number(deployment.chainId);
      const chain = Number.isSafeInteger(numericChainId) ? resolveChainId(numericChainId) : null;
      const read = reads.find((entry) => entry.contract.chain === chain);
      if (!read || deployment.address?.toLowerCase() !== policy.address || seen.has(read.contract.chain)) {
        throw new Error("Backed issuer deployment identity mismatch or duplicate");
      }
      seen.add(read.contract.chain);
      if (parseBackedRawUnits(deployment.totalSupply) !== read.gross
        || parseBackedRawUnits(deployment.circulatingSupply) !== read.net) {
        throw new Error(`Backed ${read.contract.chain} issuer/on-chain raw supply disagreement`);
      }
    }
    if (reads.some((read) => !seen.has(read.contract.chain) && (read.gross !== 0n || read.net !== 0n))) {
      throw new Error("Backed issuer omits a nonempty deployment");
    }
    return {
      supply,
      circulation: { aggregate: {
        circulatingTokens: decimalNumberFromBigInt(reads.reduce((sum, read) => sum + read.net, 0n), 18),
        verifiedAt: Math.min(...reads.map((read) => read.block.timestamp)),
        observations: reads.map((read) => ({ chain: read.contract.chain, block: read.block.number,
          timestamp: read.block.timestamp, grossRaw: read.gross.toString(), excludedRaw: read.excluded.toString() })),
        contributions: reads.map((read) => ({ chain: read.contract.chain, tokenAddress: read.contract.address,
          circulatingRaw: read.net.toString(), decimals: 18 })),
      } },
    };
  } catch (error) {
    return { supply, circulation: { failure: { reason: toErrorMessage(error) } } };
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
  const supplyScope = params.incompleteSupplyScope;
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
  // probe publishes NO coverage ratio rather than a misleading gross one. A
  // declared incomplete supply scope works the same way: the readable
  // deployments are only part of the liability the feed covers, so neither
  // basis applies and the ratio stays withheld.
  // A partial gross supply aggregate is also withheld rather than used for a
  // coverage verdict.
  // A timestamp-less endpoint stays diagnostic unless the reviewed inventory
  // policy has independently reproduced every deployment at current blocks.
  const verifiedCirculation = circulationPlausible && circulation?.aggregate?.verifiedAt != null
    && supply != null && supply.omittedNonEvmChains.length === 0 && supply.omittedReadFailureChains.length === 0;
  const supplyReadComplete = supply != null && supply.omittedReadFailureChains.length === 0;
  const liabilityBasis = supplyScope != null ? undefined : !probeActive && supplyReadComplete ? "onchain-total-supply"
    : verifiedCirculation ? "onchain-verified-issuer-circulation" : undefined;
  const liabilityTokens = liabilityBasis === "onchain-verified-issuer-circulation" ? circulatingTokens
    : liabilityBasis === "onchain-total-supply" ? supplyTokens : undefined;
  const collateralizationRatio =
    liabilityTokens != null && liabilityTokens > 0 ? reserveValue / liabilityTokens : undefined;

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
  if (supplyScope != null) {
    warnings.push(
      reserveInfoWarning(
        "por-supply-scope-incomplete",
        `On-chain supply covers only registry deployments, while the canonical ${supplyScope.chain} supply is not readable by this adapter; no coverage ratio is published (${supplyScope.reason})`,
      ),
    );
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
            })),
            supplyReadComplete: supply!.omittedReadFailureChains.length === 0,
            // Coverage completeness is distinct from read success: a non-EVM
            // registry deployment (Solana, NEAR, …) is omitted by design and
            // degrades coverage here while still surfacing as the
            // `por-supply-chain-omitted` info warning, not a read failure. A
            // configured incomplete supply scope keeps coverage incomplete
            // regardless of which deployments were read.
            supplyCoverageComplete:
              supplyScope == null &&
              supply!.omittedNonEvmChains.length === 0 &&
              supply!.omittedReadFailureChains.length === 0,
            ...(supplyScope != null
              ? { supplyScopeIncomplete: { chain: supplyScope.chain, reason: supplyScope.reason } }
              : {}),
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
