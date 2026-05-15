import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  CURATED_ONCHAIN_SUPPLY_EXCLUSIONS,
  type SupplementalOnChainSupplySource,
} from "../../../lib/onchain-supply-exclusions";
import { fetchOnchainUint256, probeTrackedTokenSupply } from "../../reserve-adapters/helpers";

export { computeExcludedBalanceAdjustedSupplyRaw };

export const CURATED_ONCHAIN_SUPPLY_CONTRACTS: Record<string, { chain: string; rpcUrl?: string; fallbackRpcUrl?: string }> = {
  // No upstream market row exists for Spark Savings USDC yet, but the Ethereum
  // vault supply plus the guarded protocol-redeem price keeps the asset visible.
  "susdc-spark": { chain: "ethereum" },
};

function isSupportedOnChainSupplyContract(contract: NonNullable<StablecoinMeta["contracts"]>[number]): boolean {
  return contract.chain === "solana" || (contract.chain !== "stellar" && contract.chain !== "tron");
}

export function selectSingleOnChainSupplyContract(meta: StablecoinMeta): NonNullable<StablecoinMeta["contracts"]>[number] | null {
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

  const balances = await Promise.all(
    exclusionConfig.holderAddresses.map((holderAddress) =>
      fetchOnchainUint256({
        contract: input.supplyContract.address,
        data: encodeBalanceOfCallData(holderAddress),
        signal: input.signal,
        rpcUrl: input.curatedRpc?.rpcUrl ?? input.chainRpc?.rpcUrl,
        fallbackRpcUrl: input.curatedRpc?.fallbackRpcUrl ?? input.chainRpc?.fallbackRpcUrl,
        rpcMode: "public-rpc",
        chain: input.supplyContract.chain,
      }),
    ),
  );

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

/** Fetch supply from one unambiguous on-chain contract and return mcap = supply × price. */
export async function fetchOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<{ mcap: number; supplySource: SupplementalOnChainSupplySource } | null> {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  const supplyContract = selectSupplementalOnChainSupplyContract(meta);
  if (!supplyContract) {
    if (!curated && (meta.contracts?.length ?? 0) > 1) {
      console.warn(`[fiat-cg] ${meta.symbol}: skipping on-chain supply fallback because multiple contracts could undercount global supply`);
    }
    return null;
  }

  const probeInput: LiveReserveInput = supplyContract.chain === "solana"
    ? { kind: "onchain-solana" }
    : { kind: "onchain-evm", chain: supplyContract.chain, rpcMode: "public-rpc" };
  const supplySignal = signal ?? AbortSignal.timeout(10_000);
  const chainRpc = supplyContract.chain === "solana"
    ? undefined
    : chainRpcs?.get(supplyContract.chain);

  try {
    const raw = await probeTrackedTokenSupply(
      meta,
      probeInput,
      supplySignal,
      "fiat-cg",
      undefined,
      curated?.rpcUrl ?? chainRpc?.rpcUrl,
      curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl,
    );
    if (raw <= 0n) return null;

    const adjustment = await adjustOnChainSupplyForExcludedBalances({
      meta,
      supplyContract,
      totalSupplyRaw: raw,
      signal: supplySignal,
      chainRpc,
      curatedRpc: curated,
    });
    const supplyRaw = adjustment?.raw ?? raw;
    const supplySource = adjustment?.supplySource ?? "onchain-total-supply";
    const decimals = supplyContract.decimals ?? (supplyContract.chain === "solana" ? 6 : 18);
    const supply = Number(supplyRaw) / 10 ** decimals;
    const mcap = supply * priceUsd;
    if (Number.isFinite(mcap) && mcap > 0) {
      const chainLabel = supplyContract.chain === "solana" ? "Solana" : "On-chain";
      console.log(`[fiat-cg] ${chainLabel} supply fallback for ${meta.symbol}: ${supply.toFixed(2)} units → $${mcap.toFixed(2)} mcap`);
      return { mcap, supplySource };
    }
  } catch (err) {
    const chainLabel = supplyContract.chain === "solana" ? "Solana" : "EVM";
    console.warn(`[fiat-cg] ${chainLabel} supply probe failed for ${meta.symbol}: ${String(err).slice(0, 200)}`);
  }

  return null;
}
