import type { ContractDeployment, StablecoinMeta } from "@shared/types/core";
import { CHAIN_META } from "@shared/lib/chains";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { fetchTronErc20TotalSupply } from "./onchain";
import type { AdapterContext } from "./types";

export interface MultichainSupplyContribution {
  chain: string;
  tokenAddress: string;
  raw: bigint;
  decimals: number;
}

export interface MultichainSupplyAggregate {
  contributions: MultichainSupplyContribution[];
  omittedNonEvmChains: string[];
  omittedNoRpcChains: string[];
  omittedReadFailureChains: string[];
}

export function isEvmContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "evm";
}

export function isTronContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "tron";
}

/**
 * True when an EVM chain has an RPC entry in the context's chainRpc map.
 * Tron resolves through TronGrid rather than chainRpcs, so callers should
 * only consult this for EVM contracts. A missing chainRpc map (smoke/test
 * contexts) means the caller did not supply RPC resolution, so the chain is
 * treated as readable and left to fail through its normal read path.
 */
export function chainHasRpc(chain: string, ctx?: AdapterContext): boolean {
  const chainRpcs = ctx?.chainRpcs;
  return chainRpcs == null || chainRpcs.has(chain);
}

interface SupplyRead {
  contract: ContractDeployment;
  raw: bigint | null;
  noRpc: boolean;
}

/**
 * Aggregate totalSupply across every registry-typed EVM + Tron chain in
 * coin.contracts. Non-EVM chains are omitted from the gross-supply
 * denominator and surfaced via `omittedNonEvmChains`; a chain without a
 * configured RPC is omitted via `omittedNoRpcChains`; a failed per-chain read
 * lands in `omittedReadFailureChains`. A zero read is a valid empty
 * deployment rather than a failure. The EVM read is caller-supplied so each
 * adapter keeps its own RPC override and block-pinning strategy.
 */
export async function aggregateMultichainErc20Supply(options: {
  coin: StablecoinMeta;
  adapterKey: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  tronCtx?: AdapterContext;
  readEvmSupply: (contract: ContractDeployment) => Promise<bigint | null>;
}): Promise<MultichainSupplyAggregate> {
  const { coin, adapterKey, signal, ctx, tronCtx, readEvmSupply } = options;

  const allContracts = coin.contracts ?? [];
  const evmContracts = allContracts.filter(isEvmContract);
  const tronContracts = allContracts.filter(isTronContract);
  const omittedNonEvmChains = allContracts
    .filter((contract) => !isEvmContract(contract) && !isTronContract(contract))
    .map((contract) => contract.chain);
  const readableContracts = [...evmContracts, ...tronContracts];

  if (readableContracts.length === 0) {
    throw new Error(`${adapterKey}: no EVM or Tron contracts available for ${coin.id}`);
  }

  const supplyReads = await Promise.all(
    readableContracts.map(async (contract): Promise<SupplyRead> => {
      if (contract.decimals == null) {
        logWorkerEventArgs(
          "handler",
          "warn",
          `[${adapterKey}] ${contract.chain} supply probe skipped for ${coin.symbol}: contract decimals are missing`,
        );
        return { contract, raw: null, noRpc: false };
      }
      if (!isTronContract(contract) && !chainHasRpc(contract.chain, ctx)) {
        return { contract, raw: null, noRpc: true };
      }
      let raw: bigint | null;
      if (isTronContract(contract)) {
        raw = await fetchTronErc20TotalSupply(contract.address, signal, tronCtx ?? ctx);
      } else {
        try {
          raw = await readEvmSupply(contract);
        } catch (error) {
          rethrowIfAborted(error, signal);
          raw = null;
        }
      }
      return { contract, raw, noRpc: false };
    }),
  );

  const successful = supplyReads.filter(
    (entry): entry is { contract: ContractDeployment; raw: bigint; noRpc: boolean } =>
      entry.raw != null && entry.raw > 0n,
  );
  const failed = supplyReads.filter((entry) => entry.raw == null && !entry.noRpc);
  const omittedNoRpcChains = supplyReads
    .filter((entry) => entry.noRpc)
    .map((entry) => entry.contract.chain);

  if (successful.length === 0) {
    throw new Error(`${adapterKey}: totalSupply() calls failed on all EVM/Tron chains for ${coin.id}`);
  }

  return {
    contributions: successful.map((entry) => ({
      chain: entry.contract.chain,
      tokenAddress: entry.contract.address,
      raw: entry.raw,
      decimals: entry.contract.decimals,
    })),
    omittedNonEvmChains,
    omittedNoRpcChains,
    omittedReadFailureChains: failed.map((entry) => entry.contract.chain),
  };
}
