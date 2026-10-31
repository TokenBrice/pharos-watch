import { fetchEearnSuiSupply } from "./sui-vault-supply";
import { fetchUsdySuiSupply } from "./usdy-sui-supply";
import { fetchUsdyAptosSupply } from "./usdy-aptos-supply";
import { fetchStellarSupply } from "./stellar-supply";
import { fetchNobleSupply } from "./noble-supply";
import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { PinnedNativeShareObservationSchema, type PinnedNativeShareObservation } from "@shared/types/reserve-nav-supply";
import type { SfraxStockPerimeterObservation } from "@shared/types/sfrax-supply";
import { fetchSfraxStockSupply } from "./sfrax-supply";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmUint256AtBlock, type EvmBlockHeader, type EvmRpcOptions } from "../../../lib/evm-rpc";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserves/store-shared";
import { CHAIN_META } from "@shared/types/chain-identity";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_AGGREGATE_ESCROW_RESIDUALS,
  SFRAX_STOCK_PERIMETER,
  USDY_SUI_COIN_TYPE,
  onchainSupplyProbeFamily,
  getOnchainSupplyHoldReason,
  isOnchainSupplyPartitionExcluded,
  selectCuratedAggregateOnchainSupplyProbeContracts,
  selectSupplementalOnchainSupplyProbeContract,
  type OnchainSupplyProbeFamily,
} from "@shared/lib/onchain-supply-probe";
import {
  hasRegistryRpc,
  primaryRpcUrl,
  registryRpcEndpoints,
  registryRpcUrls,
  type ChainRpcConfig,
} from "../../../lib/chain-registry";
import { throwIfAborted } from "../../../lib/abort";
import type { DwellirNativeCapability } from "../../../lib/dwellir-native";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import { logWorkerEvent } from "../../../lib/structured-log";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  CURATED_ONCHAIN_SUPPLY_EXCLUSIONS,
  type SupplementalOnChainSupplySource,
} from "../../../lib/onchain-supply-exclusions";
import {
  fetchErc20TotalSupply,
  fetchIcrcLedgerTotalSupply,
  fetchMoveFungibleAssetSupply,
  fetchOnchainUint256,
  fetchSolanaTokenSupply,
  fetchStarknetTotalSupply,
  probeTrackedTokenSupply,
} from "../../reserve-adapters/helpers";
import { mapWithConcurrency } from "../../../lib/concurrency";
import type { PeggedAsset } from "../enrich-prices";
import { isSupplyObservationWithinRestoreCeiling, rescaleChainPartition } from "../shared";

export { computeExcludedBalanceAdjustedSupplyRaw };
export { prefersOnChainSupplyMcap } from "@shared/lib/onchain-supply-probe";

const EXCLUDED_BALANCE_READ_CONCURRENCY = 1;
const MOVEMENT_USDCX_ID = "usdcx-movement";
const MOVEMENT_XRESERVE = "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce";
const MOVEMENT_XRESERVE_CALL = "0xc47cf5ef000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000002715";
const MOVEMENT_XRESERVE_TOLERANCE_BPS = 1n;
const JOINED_SUPPLY_OBSERVATION_MAX_AGE_SEC = 5 * 60;
// Calibrated 2026-10-25: 45 candidates in band across three passes ($8.74B); frozen for this rollout.
export const ONCHAIN_PARTITION_POLICY = {
  entry: { minRatio: 0.90, maxRatio: 1.10 },
  retain: { minRatio: 0.85, maxRatio: 1.15 },
} as const;
// Two legs per candidate; fiat-cg keeps token concurrency two, so the partition
// stage stays within the sync-stablecoins four-connection slot declaration.
export const ONCHAIN_PARTITION_LEG_CONCURRENCY = 2;

type PartitionReadFailure = "legs-unreadable" | "partition-invalid";
class OnchainSupplyValidationError extends Error {}

function joinedSupplyRpcOptions(input: {
  chainRpcs?: Map<string, ChainRpcConfig>; signal?: AbortSignal;
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string };
}): EvmRpcOptions {
  return {
    signal: input.signal, timeoutMs: 10_000,
    chainRpcs: input.curated?.rpcUrl ? undefined : input.chainRpcs,
    extraRpcUrls: [input.curated?.rpcUrl, input.curated?.fallbackRpcUrl].filter((url): url is string => !!url),
  };
}

async function confirmJoinedSupplyBlock(chain: string, block: EvmBlockHeader, options: EvmRpcOptions): Promise<void> {
  const closing = await fetchEvmBlockHeader(chain, block.number, options);
  if (!closing) throw new Error("joined supply canonical header unavailable");
  if (closing.hash !== block.hash || closing.timestamp !== block.timestamp || closing.number !== block.number) {
    throw new OnchainSupplyValidationError("joined supply canonical header changed");
  }
}

export interface OnChainMcapChainRow {
  current: number;
  /** Canonical CHAIN_META id; absent for intentionally unattributed residuals. */
  chainId?: string;
}

export interface OnChainMcapResult {
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  observedAt?: number | null;
  /** Display-label keys are retained for public compatibility. */
  chainCirculating?: Record<string, OnChainMcapChainRow>;
  supplyPerimeter?: SfraxStockPerimeterObservation;
}

export interface SingleContractOnChainMcapResult extends OnChainMcapResult {
  chain: string;
  chainLabel: string;
}

/** JLTXX native shares are read at a hash-bound finalized block, never recovered from market cap. */
export async function fetchPinnedNativeShares(
  meta: Pick<StablecoinMeta, "id" | "symbol" | "contracts">,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<PinnedNativeShareObservation | null> {
  if (meta.id !== "jltxx-jpmorgan" || meta.symbol !== "JLTXX" || meta.contracts?.length !== 1) return null;
  const contract = meta.contracts[0];
  if (contract.chain !== "ethereum" || contract.address.toLowerCase() !== "0x09864f52b035ae22ee739dfa5c748fa080d07bd8" || contract.decimals !== 2) return null;
  const options = { chainRpcs, signal: signal ?? AbortSignal.timeout(10_000), timeoutMs: 10_000 };
  try {
    const block = await fetchEvmBlockHeader("ethereum", "finalized", options);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!block || block.timestamp <= 0 || block.timestamp > nowSec || nowSec - block.timestamp > LIVE_RESERVE_FRESHNESS_SEC) return null;
    const pinnedOptions = { ...options, stateBlockHash: block.hash };
    const raw = await fetchEvmUint256AtBlock("ethereum", contract.address, TOTAL_SUPPLY_SELECTOR, block.number, pinnedOptions);
    const decimals = await fetchEvmUint256AtBlock("ethereum", contract.address, DECIMALS_SELECTOR, block.number, pinnedOptions);
    throwIfAborted(options.signal);
    if (raw == null || raw <= 0n || decimals !== 2n) return null;
    const closing = await fetchEvmBlockHeader("ethereum", block.number, options);
    if (!closing || closing.hash !== block.hash || closing.timestamp !== block.timestamp || closing.number !== block.number) return null;
    const parsed = PinnedNativeShareObservationSchema.safeParse({
      chain: contract.chain, contractAddress: contract.address.toLowerCase(),
      rawShares: raw.toString(), decimals: Number(decimals),
      blockNumber: block.number, blockHash: block.hash, observedAt: block.timestamp,
    });
    return parsed.success ? parsed.data : null;
  } catch (error) {
    throwIfAborted(options.signal);
    logWorkerEventArgs("handler", "warn", `[fiat-cg] JLTXX pinned native shares unavailable: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Convert an internal on-chain result into the stable public chain row shape. */
export function toPublicChainCirculating(
  record: OnChainMcapResult["chainCirculating"],
): NonNullable<PeggedAsset["chainCirculating"]> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([chainLabel, row]) => [
      chainLabel,
      {
        ...(row.chainId ? { chainId: row.chainId } : {}),
        current: row.current,
      },
    ]),
  );
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
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number] & { decimals: number };
  family: OnchainSupplyProbeFamily;
  allowZeroSupply: boolean;
  preserveObservedZero?: boolean;
  signal: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}): Promise<bigint | null> {
  const { supplyContract } = input;
  const evmContext = input.family === "evm" && input.chainRpcs
    ? { chainRpcs: input.chainRpcs }
    : undefined;

  if (input.family === "sui") {
    if (supplyContract.address === USDY_SUI_COIN_TYPE) {
      return fetchUsdySuiSupply(supplyContract.address, supplyContract.decimals, input.signal);
    }
    return fetchEearnSuiSupply(supplyContract.address, supplyContract.decimals, input.signal);
  }

  if (input.family === "stellar") return fetchStellarSupply(supplyContract.address, supplyContract.decimals, input.signal);
  if (input.family === "noble") return fetchNobleSupply(supplyContract.address, supplyContract.decimals, input.signal);

  if (input.family === "starknet") {
    return fetchStarknetTotalSupply({
      contract: supplyContract.address,
      signal: input.signal,
      rpcUrl: input.rpcUrl,
      fallbackRpcUrl: input.fallbackRpcUrl,
      ...(input.dwellirNative ? { ctx: { dwellirNative: input.dwellirNative } } : {}),
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

  if (input.family === "aptos") {
    if (input.meta.id === "usdy-ondo-finance") {
      return fetchUsdyAptosSupply(supplyContract.address, supplyContract.decimals, input.signal);
    }
    if (!input.rpcUrl) throw new Error("Aptos supply probe REST endpoint is unavailable");
    const observation = await fetchMoveFungibleAssetSupply(
      supplyContract.address,
      input.signal,
      input.rpcUrl,
      input.dwellirNative ? { dwellirNative: input.dwellirNative } : undefined,
      undefined,
      "aptos",
    );
    if (!observation) throw new Error("Aptos supply probe returned no pinned-ledger observation");
    if (observation.decimals !== supplyContract.decimals) {
      throw new OnchainSupplyValidationError("Aptos fungible-asset decimals do not match tracked metadata");
    }
    return observation.rawSupply;
  }

  if (input.family === "movement") {
    if (input.meta.id !== MOVEMENT_USDCX_ID || !input.rpcUrl) {
      throw new Error("Movement supply probe is not configured for this asset");
    }
    const observation = await fetchMoveFungibleAssetSupply(
      supplyContract.address,
      input.signal,
      input.rpcUrl,
      input.dwellirNative ? { dwellirNative: input.dwellirNative } : undefined,
      undefined,
      "movement",
    );
    if (!observation) throw new Error("Movement supply probe returned no pinned-ledger observation");
    if (observation.decimals !== supplyContract.decimals) {
      throw new OnchainSupplyValidationError("Movement coin-resource decimals do not match tracked metadata");
    }
    return observation.rawSupply;
  }

  if (input.allowZeroSupply || input.preserveObservedZero) {
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
        evmContext,
        input.rpcUrl,
        input.fallbackRpcUrl,
      );
  }

  return probeTrackedTokenSupply(
    { id: input.meta.id, name: input.meta.name, symbol: input.meta.symbol, flags: input.meta.flags, contracts: [supplyContract] },
    buildProbeInput(supplyContract.chain),
    input.signal,
    "fiat-cg",
    evmContext,
    input.rpcUrl,
    input.fallbackRpcUrl,
  );
}

function contractChainLabel(contract: NonNullable<StablecoinMeta["contracts"]>[number]): string {
  return CHAIN_META[contract.chain]?.name ?? contract.chain;
}

async function adjustOnChainSupplyForExcludedBalances(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  totalSupplyRaw: bigint;
  signal: AbortSignal;
  observedBlock?: EvmBlockHeader;
  rpcOptions?: EvmRpcOptions;
}): Promise<{ raw: bigint; supplySource: SupplementalOnChainSupplySource } | null> {
  const exclusionConfig = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[input.meta.id];
  if (!exclusionConfig) return null;

  if (
    onchainSupplyProbeFamily(input.supplyContract) !== "evm" ||
    input.supplyContract.chain !== exclusionConfig.chain
  ) {
    throw new OnchainSupplyValidationError(
      `configured supply exclusions require ${exclusionConfig.chain}, selected ${input.supplyContract.chain}`,
    );
  }

  const balances = await mapWithConcurrency(
    exclusionConfig.holderAddresses,
    EXCLUDED_BALANCE_READ_CONCURRENCY,
    (holderAddress) => {
      if (!input.observedBlock) throw new Error("excluded balances require a canonical supply block");
      return fetchEvmUint256AtBlock(input.supplyContract.chain, input.supplyContract.address,
        encodeBalanceOfCallData(holderAddress), input.observedBlock.number,
        { ...input.rpcOptions, signal: input.signal, stateBlockHash: input.observedBlock.hash });
    },
    { signal: input.signal },
  );

  if (balances.some((balance): balance is null => balance == null)) {
    throw new Error("configured excluded-balance read returned null");
  }

  const adjustedRaw = computeExcludedBalanceAdjustedSupplyRaw(input.totalSupplyRaw, balances as bigint[]);
  if (adjustedRaw == null) {
    throw new OnchainSupplyValidationError("configured excluded balances are greater than or equal to total supply");
  }

  return {
    raw: adjustedRaw,
    supplySource: exclusionConfig.supplySource,
  };
}

interface ContractOnChainMcapResult {
  mcap: number;
  supplySource: SupplementalOnChainSupplySource;
  observedAt: number;
  chain: string;
  chainLabel: string;
  observedBlock?: EvmBlockHeader;
}

async function fetchOnChainSupplyForContract(input: {
  meta: StablecoinMeta;
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  priceUsd: number;
  chainRpcs?: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  signal?: AbortSignal;
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string; allowZeroSupply?: boolean };
  observedBlocks?: Map<string, EvmBlockHeader>;
  onFailure?: (reason: PartitionReadFailure) => void;
}): Promise<ContractOnChainMcapResult | null> {
  const supplyContract = input.supplyContract;
  const reject = (reason: string, error?: unknown, failure: PartitionReadFailure = "partition-invalid"): null => {
    input.onFailure?.(failure);
    logWorkerEvent({
      scope: "handler", level: "warn", job: "sync-stablecoins",
      event: "onchain-supply-contract-withheld",
      message: `[fiat-cg] ${input.meta.symbol} supply deployment unavailable`,
      metadata: { stablecoinId: input.meta.id, chain: supplyContract.chain, contract: supplyContract.address, reason, rule: "R4" },
      ...(error ? { error } : {}),
    });
    return null;
  };
  if (!isFixedDecimalDeployment(supplyContract)) {
    return reject("amount-encoding-unavailable");
  }
  const family = onchainSupplyProbeFamily(supplyContract);
  if (family === null) return reject("unsupported-chain-family");
  const decimals = supplyContract.decimals;
  const supplySignal = input.signal ?? AbortSignal.timeout(10_000);
  const chainRpc = input.chainRpcs?.get(input.supplyContract.chain);
  const allowZeroSupply = input.curated?.allowZeroSupply === true;
  let observedAt = Math.floor(Date.now() / 1000);

  try {
    const incumbentUrls = registryRpcEndpoints(chainRpc).filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
    const rpcUrl = input.curated?.rpcUrl ?? incumbentUrls[0];
    const fallbackRpcUrl = input.curated?.fallbackRpcUrl ?? incumbentUrls[1];
    const rpcOptions = joinedSupplyRpcOptions({ ...input, signal: supplySignal });
    const needsJoinedBlock = family === "evm" && (
      !!CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[input.meta.id] ||
      (!!CURATED_AGGREGATE_ESCROW_RESIDUALS[input.meta.id] &&
        CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[input.meta.id] === supplyContract.chain)
    );
    let observedBlock = input.observedBlocks?.get(supplyContract.chain);
    if (needsJoinedBlock && !observedBlock) {
      const number = await fetchEvmBlockNumber(supplyContract.chain, rpcOptions);
      observedBlock = number == null ? undefined : await fetchEvmBlockHeader(supplyContract.chain, number, rpcOptions) ?? undefined;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!observedBlock) throw new Error("joined supply observation block unavailable");
      if (observedBlock.timestamp > nowSec || nowSec - observedBlock.timestamp > JOINED_SUPPLY_OBSERVATION_MAX_AGE_SEC)
        throw new OnchainSupplyValidationError("joined supply observation block stale or future");
      input.observedBlocks?.set(supplyContract.chain, observedBlock);
    }
    if (observedBlock) observedAt = observedBlock.timestamp;
    const raw = observedBlock
      ? await fetchEvmUint256AtBlock(supplyContract.chain, supplyContract.address, TOTAL_SUPPLY_SELECTOR,
        observedBlock.number, { ...rpcOptions, stateBlockHash: observedBlock.hash })
      : await readContractSupplyRaw({
      meta: input.meta,
      supplyContract,
      family,
      allowZeroSupply,
      // The positive-only probe collapses observed zero into a read failure, which must never trigger share carry.
      preserveObservedZero: input.onFailure != null,
      signal: supplySignal,
      // A reviewed supply pin retains its original route; the full map would
      // otherwise prepend registry endpoints ahead of that pin.
      chainRpcs: input.curated?.rpcUrl ? undefined : input.chainRpcs,
      dwellirNative: input.dwellirNative,
      rpcUrl,
      fallbackRpcUrl,
    });
    throwIfAborted(supplySignal);
    if (raw == null) return reject("total-supply-read-unavailable", undefined, "legs-unreadable");
    if (raw < 0n || (raw === 0n && !allowZeroSupply)) return reject("total-supply-nonpositive");

    if (family === "movement") {
      const ethereumRpc = input.chainRpcs?.get("ethereum");
      if (!hasRegistryRpc(ethereumRpc)) throw new Error("Ethereum xReserve RPC is unavailable");
      const backingRaw = await fetchOnchainUint256({
        contract: MOVEMENT_XRESERVE,
        data: MOVEMENT_XRESERVE_CALL,
        signal: supplySignal,
        rpcUrl: primaryRpcUrl(ethereumRpc),
        fallbackRpcUrl: registryRpcUrls(ethereumRpc)[1],
        rpcMode: "public-rpc",
        chain: "ethereum",
      });
      if (backingRaw == null) throw new Error("Movement xReserve backing read is unavailable");
      if (backingRaw < raw) throw new OnchainSupplyValidationError("Movement supply exceeds xReserve backing");
      if ((backingRaw - raw) * 10_000n > raw * MOVEMENT_XRESERVE_TOLERANCE_BPS) {
        throw new OnchainSupplyValidationError("Movement supply does not reconcile to xReserve within one basis point");
      }
    }

    const adjustment = raw > 0n
      ? await adjustOnChainSupplyForExcludedBalances({
        meta: input.meta,
        supplyContract: input.supplyContract,
        totalSupplyRaw: raw,
        signal: supplySignal,
        observedBlock,
        rpcOptions,
      })
      : null;
    const supplyRaw = adjustment?.raw ?? raw;
    const supplySource = adjustment?.supplySource ?? "onchain-total-supply";
    const supply = Number(supplyRaw) / 10 ** decimals;
    const mcap = supply * input.priceUsd;
    if (observedBlock) await confirmJoinedSupplyBlock(supplyContract.chain, observedBlock, rpcOptions);
    if (Number.isFinite(mcap) && (mcap > 0 || allowZeroSupply)) {
      const chainLabel = contractChainLabel(input.supplyContract);
      if (mcap > 0) {
        logWorkerEventArgs("handler", "info",
          `[fiat-cg] ${chainLabel} supply fallback for ${input.meta.symbol}: ${supply.toFixed(2)} units -> $${mcap.toFixed(2)} mcap`,
        );
      }
      return { mcap, supplySource, observedAt, observedBlock, chain: input.supplyContract.chain, chainLabel };
    }
  } catch (err) {
    throwIfAborted(supplySignal);
    return reject("supply-probe-failed", err, err instanceof OnchainSupplyValidationError ? "partition-invalid" : "legs-unreadable");
  }

  return reject("supply-valuation-invalid");
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
  observedBlock: EvmBlockHeader;
  onFailure?: (reason: PartitionReadFailure) => void;
}): Promise<number | null> {
  if (!isFixedDecimalDeployment(input.supplyContract)) {
    logWorkerEventArgs("handler", "warn",
      `[fiat-cg] ${contractChainLabel(input.supplyContract)} escrow balance probe skipped for ${input.meta.symbol}: contract has no fixed-decimal amount encoding`,
    );
    return null;
  }
  const decimals = input.supplyContract.decimals;

  try {
    const rpcOptions = joinedSupplyRpcOptions(input);
    const balance = await fetchEvmUint256AtBlock(input.supplyContract.chain, input.supplyContract.address,
      encodeBalanceOfCallData(input.escrowAddress), input.observedBlock.number,
      { ...rpcOptions, stateBlockHash: input.observedBlock.hash });
    await confirmJoinedSupplyBlock(input.supplyContract.chain, input.observedBlock, rpcOptions);
    if (balance == null || balance <= 0n) {
      input.onFailure?.(balance == null ? "legs-unreadable" : "partition-invalid");
      return null;
    }

    const mcap = (Number(balance) / 10 ** decimals) * input.priceUsd;
    return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
  } catch (err) {
    throwIfAborted(input.signal);
    input.onFailure?.(err instanceof OnchainSupplyValidationError ? "partition-invalid" : "legs-unreadable");
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
  dwellirNative?: DwellirNativeCapability,
  onFailure?: (reason: PartitionReadFailure) => void,
): Promise<SingleContractOnChainMcapResult | null> {
  const supplyContract = selectSupplementalOnchainSupplyProbeContract(meta);
  if (!supplyContract) {
    const holdReason = getOnchainSupplyHoldReason(meta.id);
    if (holdReason) {
      logWorkerEvent({
        scope: "lib", job: "sync-stablecoins", level: "warn", event: "onchain-supply-contract-withheld",
        message: "Reviewed on-chain supply fallback is unavailable until its economic float perimeter is reconciled",
        metadata: { stablecoinId: meta.id, reason: holdReason, rule: "R4" },
      });
    } else if ((meta.contracts?.length ?? 0) > 1) {
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
    dwellirNative,
    onFailure,
  });
  return result
    ? {
        mcap: result.mcap,
        supplySource: result.supplySource,
        observedAt: result.observedAt,
        chain: result.chain,
        chainLabel: result.chainLabel,
        chainCirculating: { [result.chainLabel]: { current: result.mcap, chainId: result.chain } },
      }
    : null;
}

export async function fetchCuratedAggregateOnChainMcap(
  meta: StablecoinMeta,
  priceUsd: number,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  dwellirNative?: DwellirNativeCapability,
  onFailure?: (reason: PartitionReadFailure) => void,
  legConcurrency = 1,
): Promise<OnChainMcapResult | null> {
  throwIfAborted(signal);
  if (!Number.isInteger(legConcurrency) || legConcurrency < 1) {
    throw new RangeError("legConcurrency requires a positive integer");
  }
  if (meta.id === SFRAX_STOCK_PERIMETER.assetId) return fetchSfraxStockSupply(meta, priceUsd, chainRpcs, signal);
  const holdReason = getOnchainSupplyHoldReason(meta.id);
  if (holdReason) {
    logWorkerEvent({
      scope: "lib", job: "sync-stablecoins", level: "warn", event: "onchain-supply-aggregate-withheld",
      message: "Reviewed aggregate is unavailable until its economic float perimeter is reconciled",
      metadata: { stablecoinId: meta.id, reason: holdReason, rule: "R4" },
    });
    return null;
  }
  const selectedContracts = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
  if (!selectedContracts) {
    return null;
  }
  let observedAt = Math.floor(Date.now() / 1000);
  const observedBlocks = new Map<string, EvmBlockHeader>();

  let totalMcap = 0;
  const chainCirculating: Record<string, OnChainMcapChainRow> = {};
  const canonicalSupplyChain = CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id];
  let canonicalResult: ContractOnChainMcapResult | null = null;
  let representationMcap = 0;
  // Read a bounded batch of legs before opening the next one; bodies drain
  // inside each reader. The first leg stays alone so an unreadable roster
  // still fails before spending a second read; later legs overlap in pairs
  // within the slot's declared connection headroom.
  let batchStart = 0;
  while (batchStart < selectedContracts.length) {
    throwIfAborted(signal);
    const batch = selectedContracts.slice(batchStart, batchStart + (batchStart === 0 ? 1 : legConcurrency));
    batchStart += batch.length;
    const batchFailures: Array<PartitionReadFailure | undefined> = [];
    const batchResults = await Promise.all(batch.map(({ config: curated, contract: supplyContract }, index) =>
      fetchOnChainSupplyForContract({
        meta,
        supplyContract,
        priceUsd,
        chainRpcs,
        signal,
        dwellirNative,
        curated,
        observedBlocks,
        // Passing a wrapper unconditionally would switch the reader's
        // preserve-observed-zero path even for callers without diagnostics.
        onFailure: onFailure && ((reason) => { batchFailures[index] = reason; }),
      })));
    for (let index = 0; index < batchResults.length; index++) {
      const result = batchResults[index];
      if (!result || result.supplySource !== "onchain-total-supply") {
        // Keep the first in-roster failure when a batch reads more than one leg.
        if (!result) onFailure?.(batchFailures[index] ?? "partition-invalid");
        return null;
      }
      observedAt = Math.min(observedAt, result.observedAt);

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
  }

  if (canonicalSupplyChain) {
    if (!canonicalResult || representationMcap >= canonicalResult.mcap) {
      onFailure?.("partition-invalid");
      return null;
    }
    totalMcap = canonicalResult.mcap;

    const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id];
    if (residual) {
      const canonicalLeg = selectedContracts.find(({ config }) => config.chain === canonicalSupplyChain);
      if (!canonicalLeg || !canonicalResult.observedBlock) {
        onFailure?.("partition-invalid");
        return null;
      }

      const escrowMcap = await fetchEscrowHeldMcap({
        meta,
        escrowAddress: residual.escrowAddress,
        supplyContract: canonicalLeg.contract,
        priceUsd,
        chainRpcs,
        signal,
        curated: canonicalLeg.config,
        observedBlock: canonicalResult.observedBlock,
        onFailure,
      });
      throwIfAborted(signal);
      // Fail closed: the escrow read is the whole point of the refinement, so an
      // unreadable or nonsensical balance must not quietly republish the
      // unattributed remainder as canonical-chain float.
      if (escrowMcap == null || escrowMcap < representationMcap || escrowMcap >= canonicalResult.mcap) {
        if (escrowMcap != null) onFailure?.("partition-invalid");
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

  if (!Number.isFinite(totalMcap) || totalMcap <= 0) {
    onFailure?.("partition-invalid");
    return null;
  }
  return {
    mcap: totalMcap,
    supplySource: "onchain-total-supply",
    observedAt,
    chainCirculating,
  };
}

/** The existing readers value token units at one admitted price; only their shares attach to CG. */
export async function fetchOnChainSupplyPartition(
  meta: StablecoinMeta,
  total: number,
  priceUsd: number,
  previous: PeggedAsset | undefined,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  dwellirNative?: DwellirNativeCapability,
): Promise<Pick<PeggedAsset, "chainCirculating" | "chainPartition"> | { reason: PartitionReadFailure | "ratio-out-of-band"; ratio: number | null }> {
  throwIfAborted(signal);
  if (isOnchainSupplyPartitionExcluded(meta.id)) return { reason: "partition-invalid", ratio: null };
  let failure: PartitionReadFailure = "partition-invalid";
  const onFailure = (reason: PartitionReadFailure) => { failure = reason; };
  const observation = selectCuratedAggregateOnchainSupplyProbeContracts(meta)
    ? await fetchCuratedAggregateOnChainMcap(meta, priceUsd, chainRpcs, signal, dwellirNative, onFailure,
      ONCHAIN_PARTITION_LEG_CONCURRENCY)
    : await fetchOnChainMcap(meta, priceUsd, chainRpcs, signal, dwellirNative, onFailure);
  throwIfAborted(signal);
  if (!observation) return { reason: failure, ratio: null };
  const ratio = observation.mcap / total;
  const nowSec = Math.floor(Date.now() / 1000);
  const retained = previous?.chainPartition?.basis === "onchain-share"
    && (previous.chainPartition.admission === "entered" || previous.chainPartition.admission === "retained")
    && isSupplyObservationWithinRestoreCeiling(previous.chainPartition.observedAt, nowSec);
  const band = retained ? ONCHAIN_PARTITION_POLICY.retain : ONCHAIN_PARTITION_POLICY.entry;
  if (!Number.isFinite(ratio)) return { reason: "partition-invalid", ratio: null };
  if (ratio < band.minRatio || ratio > band.maxRatio) return { reason: "ratio-out-of-band", ratio };
  const chainCirculating = rescaleChainPartition(toPublicChainCirculating(observation.chainCirculating), observation.mcap, total);
  if (!chainCirculating || observation.observedAt == null) return { reason: "partition-invalid", ratio };
  return {
    chainCirculating,
    chainPartition: {
      basis: "onchain-share", observedAt: observation.observedAt, onchainUsd: observation.mcap, ratio,
      admission: retained ? "retained" : "entered",
    },
  };
}
