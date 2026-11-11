import { toErrorMessage } from "@shared/lib/error-utils";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import type { ContractDeployment } from "@shared/types/stablecoin-meta-primitives";
import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import { resolveChainId } from "@shared/types/chain-identity";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { AdapterContext } from "./types";
import { decimalNumberFromBigInt, fetchJsonPostWithRetry, fetchOnchainMulticall3, type MultichainSupplyAggregate } from "./helpers";
import { decodeUint256Word } from "./abi-decode";
import { pinnedBlockPlan } from "./evm-observation-plan";

export type ChainlinkPorIssuerCirculationProbe = NonNullable<LiveReserveAdapterParamsByKey["chainlink-por"]["issuerCirculationProbe"]>;

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

export async function fetchIssuerCirculation(
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
export const BACKED_INVENTORY_OWNERS = [
  "0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad",
  "0x43624c744a4af40754ab19b00b6f681ca56f1e5b",
] as const;
const BACKED_CHAINS = ["ethereum", "polygon", "gnosis", "bsc", "avalanche", "fantom", "base", "arbitrum"];
export const BACKED_POLICIES: Record<string, { address: string; symbol: string; reserveSymbol: string; feed: string }> = {
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

export async function fetchVerifiedBackedCirculation(
  coin: ReserveAdapterCoin,
  params: LiveReserveAdapterParamsByKey["chainlink-por"],
  feedChain: string,
  probe: ChainlinkPorIssuerCirculationProbe,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ supply: MultichainSupplyAggregate; circulation: ChainlinkPorCirculationOutcome }> {
  const policy = BACKED_POLICIES[coin.id];
  const contracts = coin.contracts ?? [];
  let supply: MultichainSupplyAggregate = {
    contributions: [], omittedNonEvmChains: [], omittedNoRpcChains: [], omittedReadFailureChains: BACKED_CHAINS,
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
    const reads = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    supply = { contributions: reads.map((read) => ({ chain: read.contract.chain, tokenAddress: read.contract.address,
      raw: read.gross, decimals: 18 })), omittedNonEvmChains: [], omittedNoRpcChains: [],
      omittedReadFailureChains: contracts.filter((_, index) => settled[index].status === "rejected")
        .map((contract) => contract.chain) };
    // Keep successful observations diagnostic, but verify circulation only
    // after every reviewed deployment has been read.
    const failedRead = settled.find((result) => result.status === "rejected");
    if (failedRead?.status === "rejected") throw failedRead.reason;
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
