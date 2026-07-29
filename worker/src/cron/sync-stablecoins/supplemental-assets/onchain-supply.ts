import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_ONCHAIN_SUPPLY_CONTRACTS,
  selectCuratedAggregateOnchainSupplyProbeContracts,
  selectSingleOnchainSupplyProbeContract,
  selectSupplementalOnchainSupplyProbeContract,
} from "@shared/lib/onchain-supply-probe";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { throwIfAborted } from "../../../lib/abort";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  CURATED_ONCHAIN_SUPPLY_EXCLUSIONS,
  type SupplementalOnChainSupplySource,
} from "../../../lib/onchain-supply-exclusions";
import {
  fetchErc20TotalSupply,
  fetchOnchainUint256,
  probeTrackedTokenSupply,
} from "../../reserve-adapters/helpers";
import { runBoundedQueue } from "../../shared/bounded-queue";

export { computeExcludedBalanceAdjustedSupplyRaw };

const PREFER_ONCHAIN_SUPPLY_MCAP_IDS = new Set([
  // CoinGecko's ember-earn market row resolves the Sui token, while Pharos
  // tracks the Ethereum eEARN vault token used by Royco Dawn.
  "eearn-ember",
]);
const EXCLUDED_BALANCE_READ_CONCURRENCY = 1;

export interface OnChainMcapResult {
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  chainCirculating?: Record<string, number>;
}

export const selectSingleOnChainSupplyContract = selectSingleOnchainSupplyProbeContract;
export const selectSupplementalOnChainSupplyContract = selectSupplementalOnchainSupplyProbeContract;

export function prefersOnChainSupplyMcap(meta: StablecoinMeta): boolean {
  return PREFER_ONCHAIN_SUPPLY_MCAP_IDS.has(meta.id);
}

function buildProbeInput(chain: string): LiveReserveInput {
  return chain === "solana" ? { kind: "onchain-solana" } : { kind: "onchain-evm", chain, rpcMode: "public-rpc" };
}

function contractDecimals(contract: NonNullable<StablecoinMeta["contracts"]>[number]): number {
  return contract.decimals ?? (contract.chain === "solana" ? 6 : 18);
}

function contractChainLabel(contract: NonNullable<StablecoinMeta["contracts"]>[number]): string {
  return CHAIN_META[contract.chain]?.name ?? contract.chain;
}

async function adjustOnChainSupplyForExcludedBalances(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  totalSupplyRaw: bigint;
  signal: AbortSignal;
  chainRpc?: ChainRpcConfig;
  curatedRpc?: { rpcUrl?: string; fallbackRpcUrl?: string };
}): Promise<{ raw: bigint; supplySource: SupplementalOnChainSupplySource } | null> {
  const exclusionConfig = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[input.meta.id];
  if (!exclusionConfig) return null;

  if (input.supplyContract.chain === "solana" || input.supplyContract.chain !== exclusionConfig.chain) {
    throw new Error(
      `configured supply exclusions require ${exclusionConfig.chain}, selected ${input.supplyContract.chain}`,
    );
  }

  const balances = await runBoundedQueue({
    items: exclusionConfig.holderAddresses,
    concurrency: EXCLUDED_BALANCE_READ_CONCURRENCY,
    signal: input.signal,
    worker: (holderAddress) =>
      fetchOnchainUint256({
        contract: input.supplyContract.address,
        data: encodeBalanceOfCallData(holderAddress),
        signal: input.signal,
        rpcUrl: input.curatedRpc?.rpcUrl ?? input.chainRpc?.rpcUrl,
        fallbackRpcUrl: input.curatedRpc?.fallbackRpcUrl ?? input.chainRpc?.fallbackRpcUrl,
        rpcMode: "public-rpc",
        chain: input.supplyContract.chain,
      }),
  });

  if (balances.some((balance): balance is null => balance == null)) {
    throw new Error("configured excluded-balance read returned null");
  }

  const adjustedRaw = computeExcludedBalanceAdjustedSupplyRaw(input.totalSupplyRaw, balances as bigint[]);
  if (adjustedRaw == null) {
    throw new Error("configured excluded balances are greater than or equal to total supply");
  }

  return {
    raw: adjustedRaw,
    supplySource: exclusionConfig.supplySource,
  };
}

async function fetchOnChainSupplyForContract(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  priceUsd: number;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string; allowZeroSupply?: boolean };
}): Promise<{
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  chain: string;
  chainLabel: string;
} | null> {
  const probeInput = buildProbeInput(input.supplyContract.chain);
  const supplySignal = input.signal ?? AbortSignal.timeout(10_000);
  const chainRpc =
    input.supplyContract.chain === "solana" ? undefined : input.chainRpcs?.get(input.supplyContract.chain);
  const allowZeroSupply = input.curated?.allowZeroSupply === true;

  try {
    const rpcUrl = input.curated?.rpcUrl ?? chainRpc?.rpcUrl;
    const fallbackRpcUrl = input.curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl;
    const raw =
      allowZeroSupply && probeInput.kind === "onchain-evm"
        ? await fetchErc20TotalSupply(
          probeInput,
          input.supplyContract.address,
          supplySignal,
          undefined,
          rpcUrl,
          fallbackRpcUrl,
        )
        : await probeTrackedTokenSupply(
          input.meta,
          probeInput,
          supplySignal,
          "fiat-cg",
          undefined,
          rpcUrl,
          fallbackRpcUrl,
        );
    if (raw == null || (raw <= 0n && !allowZeroSupply)) return null;

    const adjustment = raw > 0n
      ? await adjustOnChainSupplyForExcludedBalances({
        meta: input.meta,
        supplyContract: input.supplyContract,
        totalSupplyRaw: raw,
        signal: supplySignal,
        chainRpc,
        curatedRpc: input.curated,
      })
      : null;
    const supplyRaw = adjustment?.raw ?? raw;
    const supplySource = adjustment?.supplySource ?? "onchain-total-supply";
    const supply = Number(supplyRaw) / 10 ** contractDecimals(input.supplyContract);
    const mcap = supply * input.priceUsd;
    if (Number.isFinite(mcap) && (mcap > 0 || allowZeroSupply)) {
      const chainLabel = contractChainLabel(input.supplyContract);
      if (mcap > 0) {
        console.log(
          `[fiat-cg] ${chainLabel} supply fallback for ${input.meta.symbol}: ${supply.toFixed(2)} units -> $${mcap.toFixed(2)} mcap`,
        );
      }
      return { mcap, supplySource, chain: input.supplyContract.chain, chainLabel };
    }
  } catch (err) {
    const chainLabel = input.supplyContract.chain === "solana" ? "Solana" : "EVM";
    console.warn(`[fiat-cg] ${chainLabel} supply probe failed for ${input.meta.symbol}: ${String(err).slice(0, 200)}`);
  }

  return null;
}

/** Fetch supply from one unambiguous on-chain contract and return mcap = supply × price. */
export async function fetchOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<OnChainMcapResult | null> {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  const supplyContract = selectSupplementalOnChainSupplyContract(meta);
  if (!supplyContract) {
    if (!curated && (meta.contracts?.length ?? 0) > 1) {
      console.warn(
        `[fiat-cg] ${meta.symbol}: skipping on-chain supply fallback because multiple contracts could undercount global supply`,
      );
    }
    return null;
  }

  const result = await fetchOnChainSupplyForContract({
    meta,
    supplyContract,
    priceUsd,
    chainRpcs,
    signal,
    curated,
  });
  return result ? { mcap: result.mcap, supplySource: result.supplySource } : null;
}

export async function fetchCuratedAggregateOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<OnChainMcapResult | null> {
  const selectedContracts = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
  if (!selectedContracts) {
    return null;
  }

  let totalMcap = 0;
  const chainCirculating: Record<string, number> = {};
  const canonicalSupplyChain = CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id];
  let canonicalResult: { mcap: number; chainLabel: string } | null = null;
  let representationMcap = 0;
  for (const { config: curated, contract: supplyContract } of selectedContracts) {
    throwIfAborted(signal);

    const result = await fetchOnChainSupplyForContract({
      meta,
      supplyContract,
      priceUsd,
      chainRpcs,
      signal,
      curated,
    });
    if (!result || result.supplySource !== "onchain-total-supply") {
      return null;
    }

    if (canonicalSupplyChain) {
      if (result.chain === canonicalSupplyChain) {
        canonicalResult = result;
      } else {
        representationMcap += result.mcap;
      }
    } else {
      totalMcap += result.mcap;
    }
    chainCirculating[result.chainLabel] = (chainCirculating[result.chainLabel] ?? 0) + result.mcap;
  }

  if (canonicalSupplyChain) {
    if (!canonicalResult || representationMcap >= canonicalResult.mcap) return null;
    totalMcap = canonicalResult.mcap;
    chainCirculating[canonicalResult.chainLabel] = canonicalResult.mcap - representationMcap;
  }

  if (!Number.isFinite(totalMcap) || totalMcap <= 0) return null;
  return {
    mcap: totalMcap,
    supplySource: "onchain-total-supply",
    chainCirculating,
  };
}
