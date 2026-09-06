import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_AGGREGATE_ESCROW_RESIDUALS,
  onchainSupplyProbeFamily,
  selectCuratedAggregateOnchainSupplyProbeContracts,
  selectSupplementalOnchainSupplyProbeContract,
  type OnchainSupplyProbeFamily,
} from "@shared/lib/onchain-supply-probe";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { throwIfAborted } from "../../../lib/abort";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import { logWorkerEvent } from "../../../lib/structured-log";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  CURATED_ONCHAIN_SUPPLY_EXCLUSIONS,
  type SupplementalOnChainSupplySource,
} from "../../../lib/onchain-supply-exclusions";
import {
  fetchErc20TotalSupply,
  fetchIcrcLedgerTotalSupply,
  fetchMovementFungibleAssetSupply,
  fetchOnchainUint256,
  fetchSolanaTokenSupply,
  fetchStarknetTotalSupply,
  probeTrackedTokenSupply,
} from "../../reserve-adapters/helpers";
import { mapWithConcurrency } from "../../../lib/concurrency";

export { computeExcludedBalanceAdjustedSupplyRaw };

const PREFER_ONCHAIN_SUPPLY_MCAP_IDS = new Set([
  // CoinGecko's ember-earn market row resolves the Sui token, while Pharos
  // tracks the Ethereum eEARN vault token used by Royco Dawn.
  "eearn-ember",
]);
const EXCLUDED_BALANCE_READ_CONCURRENCY = 1;
const MOVEMENT_USDCX_ID = "usdcx-movement";
const MOVEMENT_XRESERVE = "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce";
const MOVEMENT_XRESERVE_CALL = "0xc47cf5ef000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000002715";
const MOVEMENT_XRESERVE_TOLERANCE_BPS = 1n;

export interface OnChainMcapChainRow {
  current: number;
  /** Canonical CHAIN_META id; absent for intentionally unattributed residuals. */
  chainId?: string;
}

export interface OnChainMcapResult {
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  /** Display-label keys are retained for public compatibility. */
  chainCirculating?: Record<string, OnChainMcapChainRow>;
}

export interface SingleContractOnChainMcapResult extends OnChainMcapResult {
  chain: string;
  chainLabel: string;
}

export function prefersOnChainSupplyMcap(meta: StablecoinMeta): boolean {
  return PREFER_ONCHAIN_SUPPLY_MCAP_IDS.has(meta.id);
}

function buildEvmProbeInput(chain: string): Extract<LiveReserveInput, { kind: "onchain-evm" }> {
  return { kind: "onchain-evm", chain, rpcMode: "public-rpc" };
}

function buildProbeInput(chain: string): LiveReserveInput {
  return chain === "solana" ? { kind: "onchain-solana" } : buildEvmProbeInput(chain);
}

/**
 * Read one deployment's raw supply through the reader its chain family needs.
 *
 * Starknet and ICP have no `LiveReserveInput` kind and no shared RPC registry
 * entry, so they dispatch to their own readers instead of the EVM/Solana probe.
 * `allowZeroSupply` legs bypass `probeTrackedTokenSupply()` on both EVM and
 * Solana because that probe treats a zero read as an adapter failure.
 */
async function readContractSupplyRaw(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  family: OnchainSupplyProbeFamily;
  allowZeroSupply: boolean;
  signal: AbortSignal;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}): Promise<bigint | null> {
  const { supplyContract } = input;

  if (input.family === "starknet") {
    return fetchStarknetTotalSupply({
      contract: supplyContract.address,
      signal: input.signal,
      rpcUrl: input.rpcUrl,
      fallbackRpcUrl: input.fallbackRpcUrl,
    });
  }

  if (input.family === "icp") {
    return fetchIcrcLedgerTotalSupply({
      canisterId: supplyContract.address,
      signal: input.signal,
      apiBaseUrl: input.rpcUrl,
      fallbackApiBaseUrl: input.fallbackRpcUrl,
    });
  }

  if (input.family === "movement") {
    if (input.meta.id !== MOVEMENT_USDCX_ID || !input.rpcUrl) {
      throw new Error("Movement supply probe is not configured for this asset");
    }
    const observation = await fetchMovementFungibleAssetSupply(
      supplyContract.address,
      input.signal,
      input.rpcUrl,
    );
    if (!observation) throw new Error("Movement supply probe returned no pinned-ledger observation");
    if (observation.decimals !== supplyContract.decimals) {
      throw new Error("Movement coin-resource decimals do not match tracked metadata");
    }
    return observation.rawSupply;
  }

  if (input.allowZeroSupply) {
    return input.family === "solana"
      ? fetchSolanaTokenSupply(
        supplyContract.address,
        input.signal,
        undefined,
        input.rpcUrl,
        input.fallbackRpcUrl,
      )
      : fetchErc20TotalSupply(
        buildEvmProbeInput(supplyContract.chain),
        supplyContract.address,
        input.signal,
        undefined,
        input.rpcUrl,
        input.fallbackRpcUrl,
      );
  }

  return probeTrackedTokenSupply(
    input.meta,
    buildProbeInput(supplyContract.chain),
    input.signal,
    "fiat-cg",
    undefined,
    input.rpcUrl,
    input.fallbackRpcUrl,
  );
}

function contractDecimals(contract: NonNullable<StablecoinMeta["contracts"]>[number]): number | null {
  return contract.decimals ?? null;
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

  if (
    onchainSupplyProbeFamily(input.supplyContract) !== "evm" ||
    input.supplyContract.chain !== exclusionConfig.chain
  ) {
    throw new Error(
      `configured supply exclusions require ${exclusionConfig.chain}, selected ${input.supplyContract.chain}`,
    );
  }

  const balances = await mapWithConcurrency(
    exclusionConfig.holderAddresses,
    EXCLUDED_BALANCE_READ_CONCURRENCY,
    (holderAddress) =>
      fetchOnchainUint256({
        contract: input.supplyContract.address,
        data: encodeBalanceOfCallData(holderAddress),
        signal: input.signal,
        rpcUrl: input.curatedRpc?.rpcUrl ?? input.chainRpc?.rpcUrl,
        fallbackRpcUrl: input.curatedRpc?.fallbackRpcUrl ?? input.chainRpc?.fallbackRpcUrl,
        rpcMode: "public-rpc",
        chain: input.supplyContract.chain,
      }),
    { signal: input.signal },
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
  const family = onchainSupplyProbeFamily(input.supplyContract);
  if (family === null) return null;
  const decimals = contractDecimals(input.supplyContract);
  if (decimals == null) {
    logWorkerEventArgs("handler", "warn",
      `[fiat-cg] ${contractChainLabel(input.supplyContract)} supply probe skipped for ${input.meta.symbol}: contract decimals are missing`,
    );
    return null;
  }
  const supplySignal = input.signal ?? AbortSignal.timeout(10_000);
  const chainRpc = input.chainRpcs?.get(input.supplyContract.chain);
  const allowZeroSupply = input.curated?.allowZeroSupply === true;

  try {
    const rpcUrl = input.curated?.rpcUrl ?? chainRpc?.rpcUrl;
    const fallbackRpcUrl = input.curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl;
    const raw = await readContractSupplyRaw({
      meta: input.meta,
      supplyContract: input.supplyContract,
      family,
      allowZeroSupply,
      signal: supplySignal,
      rpcUrl,
      fallbackRpcUrl,
    });
    if (raw == null || (raw <= 0n && !allowZeroSupply)) return null;

    if (family === "movement") {
      const ethereumRpc = input.chainRpcs?.get("ethereum");
      if (!ethereumRpc) throw new Error("Ethereum xReserve RPC is unavailable");
      const backingRaw = await fetchOnchainUint256({
        contract: MOVEMENT_XRESERVE,
        data: MOVEMENT_XRESERVE_CALL,
        signal: supplySignal,
        rpcUrl: ethereumRpc.rpcUrl,
        fallbackRpcUrl: ethereumRpc.fallbackRpcUrl,
        rpcMode: "public-rpc",
        chain: "ethereum",
      });
      if (backingRaw == null) throw new Error("Movement xReserve backing read is unavailable");
      if (backingRaw < raw) throw new Error("Movement supply exceeds xReserve backing");
      if ((backingRaw - raw) * 10_000n > raw * MOVEMENT_XRESERVE_TOLERANCE_BPS) {
        throw new Error("Movement supply does not reconcile to xReserve within one basis point");
      }
    }

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
    const supply = Number(supplyRaw) / 10 ** decimals;
    const mcap = supply * input.priceUsd;
    if (Number.isFinite(mcap) && (mcap > 0 || allowZeroSupply)) {
      const chainLabel = contractChainLabel(input.supplyContract);
      if (mcap > 0) {
        logWorkerEventArgs("handler", "info",
          `[fiat-cg] ${chainLabel} supply fallback for ${input.meta.symbol}: ${supply.toFixed(2)} units -> $${mcap.toFixed(2)} mcap`,
        );
      }
      return { mcap, supplySource, chain: input.supplyContract.chain, chainLabel };
    }
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      `[fiat-cg] ${contractChainLabel(input.supplyContract)} supply probe failed for ${input.meta.symbol}: ${String(err).slice(0, 200)}`,
    );
  }

  return null;
}

/**
 * Value the canonical-chain lockbox balance so a reallocating aggregate can
 * publish free float separately from escrow it cannot attribute to a configured
 * representation leg.
 */
async function fetchEscrowHeldMcap(input: {
  meta: StablecoinMeta;
  escrowAddress: string;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  priceUsd: number;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string };
}): Promise<number | null> {
  const chainRpc = input.chainRpcs?.get(input.supplyContract.chain);
  const decimals = contractDecimals(input.supplyContract);
  if (decimals == null) {
    logWorkerEventArgs("handler", "warn",
      `[fiat-cg] ${contractChainLabel(input.supplyContract)} escrow balance probe skipped for ${input.meta.symbol}: contract decimals are missing`,
    );
    return null;
  }

  try {
    const balance = await fetchOnchainUint256({
      contract: input.supplyContract.address,
      data: encodeBalanceOfCallData(input.escrowAddress),
      signal: input.signal ?? AbortSignal.timeout(10_000),
      rpcUrl: input.curated?.rpcUrl ?? chainRpc?.rpcUrl,
      fallbackRpcUrl: input.curated?.fallbackRpcUrl ?? chainRpc?.fallbackRpcUrl,
      rpcMode: "public-rpc",
      chain: input.supplyContract.chain,
    });
    if (balance == null || balance <= 0n) return null;

    const mcap = (Number(balance) / 10 ** decimals) * input.priceUsd;
    return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "onchain_supply.escrow_balance_probe_failed",
      job: "sync-stablecoins",
      source: "fiat-cg",
      message: "Escrow balance probe failed",
      error: err,
      metadata: { symbol: input.meta.symbol },
    });
    return null;
  }
}

/** Fetch supply from one unambiguous on-chain contract and return mcap = supply × price. */
export async function fetchOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<SingleContractOnChainMcapResult | null> {
  const supplyContract = selectSupplementalOnchainSupplyProbeContract(meta);
  if (!supplyContract) {
    if ((meta.contracts?.length ?? 0) > 1) {
      logWorkerEventArgs("handler", "warn",
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
  });
  return result
    ? { mcap: result.mcap, supplySource: result.supplySource, chain: result.chain, chainLabel: result.chainLabel }
    : null;
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
  const chainCirculating: Record<string, OnChainMcapChainRow> = {};
  const canonicalSupplyChain = CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id];
  let canonicalResult: { mcap: number; chain: string; chainLabel: string } | null = null;
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

    const existing = chainCirculating[result.chainLabel];
    chainCirculating[result.chainLabel] = {
      current: (existing?.current ?? 0) + result.mcap,
      chainId: existing?.chainId ?? result.chain,
    };
  }

  if (canonicalSupplyChain) {
    if (!canonicalResult || representationMcap >= canonicalResult.mcap) return null;
    totalMcap = canonicalResult.mcap;

    const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id];
    if (residual) {
      const canonicalLeg = selectedContracts.find(({ config }) => config.chain === canonicalSupplyChain);
      if (!canonicalLeg) return null;

      const escrowMcap = await fetchEscrowHeldMcap({
        meta,
        escrowAddress: residual.escrowAddress,
        supplyContract: canonicalLeg.contract,
        priceUsd,
        chainRpcs,
        signal,
        curated: canonicalLeg.config,
      });
      // Fail closed: the escrow read is the whole point of the refinement, so an
      // unreadable or nonsensical balance must not quietly republish the
      // unattributed remainder as canonical-chain float.
      if (escrowMcap == null || escrowMcap < representationMcap || escrowMcap >= canonicalResult.mcap) {
        return null;
      }

      chainCirculating[canonicalResult.chainLabel] = {
        current: canonicalResult.mcap - escrowMcap,
        chainId: canonicalResult.chain,
      };
      const unattributedMcap = escrowMcap - representationMcap;
      if (unattributedMcap > 0) {
        chainCirculating[residual.unattributedChainLabel] = { current: unattributedMcap };
      }
    } else {
      chainCirculating[canonicalResult.chainLabel] = {
        current: canonicalResult.mcap - representationMcap,
        chainId: canonicalResult.chain,
      };
    }
  }

  if (!Number.isFinite(totalMcap) || totalMcap <= 0) return null;
  return {
    mcap: totalMcap,
    supplySource: "onchain-total-supply",
    chainCirculating,
  };
}
