import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { throwIfAborted } from "../../../lib/abort";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  CURATED_ONCHAIN_SUPPLY_EXCLUSIONS,
  type SupplementalOnChainSupplySource,
} from "../../../lib/onchain-supply-exclusions";
import { fetchOnchainUint256, probeTrackedTokenSupply } from "../../reserve-adapters/helpers";
import { runBoundedQueue } from "../../shared/bounded-queue";

export { computeExcludedBalanceAdjustedSupplyRaw };

export const CURATED_ONCHAIN_SUPPLY_CONTRACTS: Record<
  string,
  { chain: string; rpcUrl?: string; fallbackRpcUrl?: string }
> = {
  // No upstream market row exists for Spark Savings USDC yet, but the Ethereum
  // vault supply plus the guarded protocol-redeem price keeps the asset visible.
  "susdc-spark": { chain: "ethereum" },
};
const PREFER_ONCHAIN_SUPPLY_MCAP_IDS = new Set([
  // CoinGecko's ember-earn market row resolves the Sui token, while Pharos
  // tracks the Ethereum eEARN vault token used by Royco Dawn.
  "eearn-ember",
]);
const CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS: Record<
  string,
  readonly { chain: string; rpcUrl?: string; fallbackRpcUrl?: string }[]
> = {
  // DefiLlama currently lists these active assets but intermittently reports a
  // zero supply row. Use only verified live deployments and fail closed if any
  // configured chain cannot be read, so this cannot silently undercount.
  "cadd-cad-digital": [{ chain: "ethereum" }, { chain: "base" }],
  // CoinGecko only exposes an Ethereum market-cap row for ftUSD and currently
  // leaves it stale; aggregate the verified native Ethereum + Sonic supplies.
  "ftusd-flying-tulip": [{ chain: "ethereum" }, { chain: "sonic" }],
  "jpym-mento": [{ chain: "celo" }],
  "zarm-mento": [{ chain: "celo" }],
  "xofm-mento": [{ chain: "celo" }],
};
const EXCLUDED_BALANCE_READ_CONCURRENCY = 1;

export interface OnChainMcapResult {
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  chainCirculating?: Record<string, number>;
}

function isSupportedOnChainSupplyContract(contract: NonNullable<StablecoinMeta["contracts"]>[number]): boolean {
  return contract.chain === "solana" || (contract.chain !== "stellar" && contract.chain !== "tron");
}

export function selectSingleOnChainSupplyContract(
  meta: StablecoinMeta,
): NonNullable<StablecoinMeta["contracts"]>[number] | null {
  const contracts = meta.contracts ?? [];
  if (contracts.length !== 1) return null;
  const [contract] = contracts;
  return contract && isSupportedOnChainSupplyContract(contract) ? contract : null;
}

export function selectSupplementalOnChainSupplyContract(
  meta: StablecoinMeta,
): NonNullable<StablecoinMeta["contracts"]>[number] | null {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (curated) {
    const contract = meta.contracts?.find((entry) => entry.chain === curated.chain);
    return contract && isSupportedOnChainSupplyContract(contract) ? contract : null;
  }

  return selectSingleOnChainSupplyContract(meta);
}

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
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string };
}): Promise<{
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  chainLabel: string;
} | null> {
  const probeInput = buildProbeInput(input.supplyContract.chain);
  const supplySignal = input.signal ?? AbortSignal.timeout(10_000);
  const chainRpc =
    input.supplyContract.chain === "solana" ? undefined : input.chainRpcs?.get(input.supplyContract.chain);

  try {
    const raw = await probeTrackedTokenSupply(
      input.meta,
      probeInput,
      supplySignal,
      "fiat-cg",
      undefined,
      input.curated?.rpcUrl ?? chainRpc?.rpcUrl,
      input.curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl,
    );
    if (raw <= 0n) return null;

    const adjustment = await adjustOnChainSupplyForExcludedBalances({
      meta: input.meta,
      supplyContract: input.supplyContract,
      totalSupplyRaw: raw,
      signal: supplySignal,
      chainRpc,
      curatedRpc: input.curated,
    });
    const supplyRaw = adjustment?.raw ?? raw;
    const supplySource = adjustment?.supplySource ?? "onchain-total-supply";
    const supply = Number(supplyRaw) / 10 ** contractDecimals(input.supplyContract);
    const mcap = supply * input.priceUsd;
    if (Number.isFinite(mcap) && mcap > 0) {
      const chainLabel = contractChainLabel(input.supplyContract);
      console.log(
        `[fiat-cg] ${chainLabel} supply fallback for ${input.meta.symbol}: ${supply.toFixed(2)} units -> $${mcap.toFixed(2)} mcap`,
      );
      return { mcap, supplySource, chainLabel };
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
  const curatedContracts = CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (!curatedContracts || curatedContracts.length === 0) return null;

  let totalMcap = 0;
  const chainCirculating: Record<string, number> = {};
  for (const curated of curatedContracts) {
    throwIfAborted(signal);
    const supplyContract = meta.contracts?.find((entry) => entry.chain === curated.chain);
    if (!supplyContract || !isSupportedOnChainSupplyContract(supplyContract)) {
      console.warn(
        `[fiat-cg] ${meta.symbol}: configured aggregate supply chain ${curated.chain} is missing or unsupported`,
      );
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
    if (!result || result.supplySource !== "onchain-total-supply") {
      return null;
    }

    totalMcap += result.mcap;
    chainCirculating[result.chainLabel] = (chainCirculating[result.chainLabel] ?? 0) + result.mcap;
  }

  if (!Number.isFinite(totalMcap) || totalMcap <= 0) return null;
  return {
    mcap: totalMcap,
    supplySource: "onchain-total-supply",
    chainCirculating,
  };
}
