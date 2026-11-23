import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserve-policy";
import { fetchEearnSuiSupply } from "./sui-vault-supply";
import { fetchUsdySuiSupply } from "./usdy-sui-supply";
import { fetchAptosSupply } from "./usdy-aptos-supply";
import { fetchStellarSupply, observeStellarSupply } from "./stellar-supply";
import { fetchNobleSupply } from "./noble-supply";
import { fetchXrplSupply, XrplSupplyValidationError } from "./xrpl-supply";
import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { PinnedNativeShareObservationSchema, type PinnedNativeShareObservation } from "@shared/types/reserve-nav-supply";
import type { SfraxStockPerimeterObservation } from "@shared/types/sfrax-supply";
import { fetchSfraxStockSupply } from "./sfrax-supply";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmUint256AtBlock, type EvmBlockHeader, type EvmRpcOptions } from "../../../lib/evm-rpc";
import { CHAIN_META } from "@shared/types/chain-identity";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_AGGREGATE_ESCROW_RESIDUALS,
  NAV_SUPPLY_LEDGER_FRESHNESS,
  SFRAX_STOCK_PERIMETER,
  reviewedOnchainSupplyReader,
  onchainSupplyProbeFamily,
  getOnchainSupplyHoldReason,
  isKinesisWrapperSupplyId,
  isOnchainSupplyPartitionExcluded,
  selectCuratedAggregateOnchainSupplyProbeContracts,
  selectSupplementalOnchainSupplyProbeContract,
  type OnchainSupplyProbeFamily,
  type SupplementalOnChainSupplySource,
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
} from "../../../lib/onchain-supply-exclusions";
import {
  fetchErc20TotalSupply,
  fetchIcrcLedgerTotalSupply,
  fetchOnchainUint256,
  fetchStarknetTotalSupply,
  probeTrackedTokenSupply,
} from "../../reserve-adapters/helpers";
import {
  fetchMoveFungibleAssetSupply,
  fetchSolanaAccounts,
  fetchSolanaTokenSupply,
  readSolanaMint,
  readSolanaTokenAccount,
} from "../../../lib/chain-observation";
import { observeSolanaTokenSupply } from "../../../lib/native-token-supply";
import { jsonRequestExecutor } from "../../../lib/json-request";
import { mapWithConcurrency } from "../../../lib/concurrency";
import type { PeggedAsset } from "../enrich-prices";
import { isSupplyObservationWithinRestoreCeiling, rescaleChainPartition } from "../shared";

export { computeExcludedBalanceAdjustedSupplyRaw };
export { prefersOnChainSupplyMcap } from "@shared/lib/onchain-supply-probe";

const EXCLUDED_BALANCE_READ_CONCURRENCY = 1;
const MOVEMENT_USDCX_ID = "usdcx-movement";
const MOVEMENT_XRESERVE = "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce";
const MOVEMENT_XRESERVE_CALL = "0xc47cf5ef000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000002715";
const MOVEMENT_XRESERVE_EXCESS_TOLERANCE_BPS = 500n;
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
  nativeSupply?: number;
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
  stellarAssetCode?: string;
}): Promise<bigint | null> {
  const { supplyContract } = input;
  const evmContext = input.family === "evm" && input.chainRpcs
    ? { chainRpcs: input.chainRpcs }
    : undefined;
  const reader = reviewedOnchainSupplyReader(input.meta, supplyContract);

  if (input.family === "sui") {
    if (reader === "usdy-sui") {
      return fetchUsdySuiSupply(supplyContract.address, supplyContract.decimals, input.signal);
    }
    return fetchEearnSuiSupply(supplyContract.address, supplyContract.decimals, input.signal);
  }

  if (input.family === "stellar") {
    const stellarAddress = input.stellarAssetCode ? `${input.stellarAssetCode}-${supplyContract.address}` : supplyContract.address;
    return fetchStellarSupply(stellarAddress, supplyContract.decimals, input.signal);
  }
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

async function readClockedSolanaExcludedSupply(input: {
  mintAddress: string;
  decimals: number;
  excludedTokenAccounts: readonly string[];
  signal: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): Promise<{ rawSupply: bigint; observedAt: number; supplySource: "onchain-circulating-supply" }> {
  const census = await fetchSolanaAccounts(
    [input.mintAddress, ...input.excludedTokenAccounts],
    input.signal,
    { chainRpcs: input.chainRpcs },
  );
  const observedAt = census.observedBlock.timestamp;
  const mintAccount = census.accounts.get(input.mintAddress);
  let mint: ReturnType<typeof readSolanaMint>;
  let excludedBalances: bigint[];
  try {
    mint = readSolanaMint(mintAccount, observedAt);
    if (mint.decimals !== input.decimals || mint.scaledUi) {
      throw new Error("Solana mint decimals or scaled-UI accounting mismatch");
    }
    excludedBalances = input.excludedTokenAccounts.map((accountAddress) =>
      readSolanaTokenAccount(census.accounts.get(accountAddress), input.mintAddress, mintAccount!.owner).amount,
    );
  } catch (error) {
    throw new OnchainSupplyValidationError(error instanceof Error ? error.message : String(error));
  }
  const adjustedRaw = computeExcludedBalanceAdjustedSupplyRaw(mint.rawSupply, excludedBalances);
  if (adjustedRaw == null) {
    throw new OnchainSupplyValidationError("configured Solana excluded balances are greater than or equal to total supply");
  }
  return { rawSupply: adjustedRaw, observedAt, supplySource: "onchain-circulating-supply" };
}

interface ContractOnChainMcapResult {
  mcap: number;
  nativeSupply?: number;
  rawSupply?: bigint;
  decimals?: number;
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
  curated?: {
    rpcUrl?: string;
    fallbackRpcUrl?: string;
    allowZeroSupply?: boolean;
    hotwallet?: readonly string[];
    stellarAssetCode?: string;
    excludedTokenAccounts?: readonly string[];
  };
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
  const family = onchainSupplyProbeFamily(supplyContract, input.curated?.stellarAssetCode);
  if (family === null) return reject("unsupported-chain-family");
  const supplySignal = input.signal ?? AbortSignal.timeout(10_000);
  const chainRpc = input.chainRpcs?.get(input.supplyContract.chain);
  const allowZeroSupply = input.curated?.allowZeroSupply === true;
  let observedAt = Math.floor(Date.now() / 1000);

  try {
    const incumbentUrls = registryRpcEndpoints(chainRpc).filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
    const rpcUrl = input.curated?.rpcUrl ?? incumbentUrls[0];
    const fallbackRpcUrl = input.curated?.fallbackRpcUrl ?? incumbentUrls[1];
    if (family === "xrpl") {
      const observation = await fetchXrplSupply(supplyContract.address, supplySignal, rpcUrl, fallbackRpcUrl, input.curated?.hotwallet);
      throwIfAborted(supplySignal);
      const mcap = observation.supply * input.priceUsd;
      if (!Number.isFinite(mcap) || mcap < 0 || (mcap === 0 && !allowZeroSupply)) return reject("supply-valuation-invalid");
      return { mcap, nativeSupply: observation.supply, supplySource: "onchain-total-supply", observedAt: observation.observedAt,
        chain: supplyContract.chain, chainLabel: contractChainLabel(supplyContract) };
    }
    if (!isFixedDecimalDeployment(supplyContract)) return reject("amount-encoding-unavailable");
    const decimals = supplyContract.decimals;
    const rpcOptions = joinedSupplyRpcOptions({ ...input, signal: supplySignal });
    const stateClockRequired = input.meta.id === "buidl-blackrock" || isKinesisWrapperSupplyId(input.meta.id)
      || input.meta.id === "susds-sky" || input.meta.id === "paxg-paxos"
      || input.meta.id === "eurc-circle" || input.meta.id === "eurcv-societe-generale-forge"
      || input.meta.id === "brla-brla-digital";
    const needsJoinedBlock = family === "evm" && (
      stateClockRequired || !!CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[input.meta.id] ||
      (!!CURATED_AGGREGATE_ESCROW_RESIDUALS[input.meta.id] &&
        CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[input.meta.id] === supplyContract.chain)
    );
    let observedBlock = input.observedBlocks?.get(supplyContract.chain);
    if (needsJoinedBlock && !observedBlock) {
      const number = await fetchEvmBlockNumber(supplyContract.chain, rpcOptions);
      observedBlock = number == null ? undefined : await fetchEvmBlockHeader(supplyContract.chain, number, rpcOptions) ?? undefined;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!observedBlock) throw new Error("joined supply observation block unavailable");
      // Fast PoS validators (e.g. Polygon) occasionally stamp head blocks 1-2s ahead of wall clock;
      // step back one canonical block instead of relaxing the non-future invariant.
      if (observedBlock.timestamp > nowSec && observedBlock.timestamp <= nowSec + 5 && observedBlock.number > 0) {
        const parent = await fetchEvmBlockHeader(supplyContract.chain, observedBlock.number - 1, rpcOptions);
        if (parent && parent.number === observedBlock.number - 1) observedBlock = parent;
      }
      if (observedBlock.timestamp > nowSec || nowSec - observedBlock.timestamp > JOINED_SUPPLY_OBSERVATION_MAX_AGE_SEC)
        throw new OnchainSupplyValidationError("joined supply observation block stale or future");
      input.observedBlocks?.set(supplyContract.chain, observedBlock);
    }
    if (observedBlock) observedAt = observedBlock.timestamp;
    const reader = reviewedOnchainSupplyReader(input.meta, supplyContract);
    const stellarAddress = input.curated?.stellarAssetCode
      ? `${input.curated.stellarAssetCode}-${supplyContract.address}`
      : supplyContract.address;
    const hasSolanaExcludedAccounts = family === "solana" && Boolean(input.curated?.excludedTokenAccounts?.length);
    const clockedSupply: { rawSupply: bigint; observedAt: number; supplySource?: SupplementalOnChainSupplySource } | null | undefined =
      hasSolanaExcludedAccounts
        ? await readClockedSolanaExcludedSupply({
          mintAddress: supplyContract.address,
          decimals,
          excludedTokenAccounts: input.curated!.excludedTokenAccounts!,
          signal: supplySignal,
          chainRpcs: input.curated?.rpcUrl ? undefined : input.chainRpcs,
        })
        : family === "solana" && stateClockRequired
          ? await observeSolanaTokenSupply(supplyContract.address, supplySignal, { jsonRequestExecutor }, rpcUrl, fallbackRpcUrl)
          : family === "stellar" && stateClockRequired
            ? await observeStellarSupply(stellarAddress, decimals, supplySignal)
            : reader === "buidl-aptos" || reader === "usdy-aptos"
              ? await fetchAptosSupply(supplyContract.address, decimals, supplySignal, reader === "buidl-aptos" ? "BUIDL" : "USDY")
              : undefined;
    if (clockedSupply === null) return reject("state-clock-unavailable", undefined, "legs-unreadable");
    if (clockedSupply) {
      observedAt = clockedSupply.observedAt;
      const stateAge = Math.floor(Date.now() / 1000) - observedAt;
      const maxFutureSkew = family === "solana" || family === "stellar" ? NAV_SUPPLY_LEDGER_FRESHNESS.maxFutureSkewSec : 0;
      if ((stateClockRequired || hasSolanaExcludedAccounts) && (stateAge < -maxFutureSkew || stateAge > JOINED_SUPPLY_OBSERVATION_MAX_AGE_SEC)) {
        return reject("supply-state-stale-or-future");
      }
    }
    const raw = clockedSupply ? clockedSupply.rawSupply : observedBlock
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
      stellarAssetCode: input.curated?.stellarAssetCode,
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
        ctx: { chainRpcs: input.chainRpcs },
        rpcUrl: primaryRpcUrl(ethereumRpc),
        fallbackRpcUrl: registryRpcUrls(ethereumRpc)[1],
        rpcMode: "public-rpc",
        chain: "ethereum",
      });
      if (backingRaw == null) throw new Error("Movement xReserve backing read is unavailable");
      // Under-collateralization (0 bps tolerance) fails closed; bounded excess backing
      // tolerates asynchronous xReserve deposit and burn-release settlement lag.
      if (backingRaw < raw) throw new OnchainSupplyValidationError("Movement supply exceeds xReserve backing");
      if ((backingRaw - raw) * 10_000n > raw * MOVEMENT_XRESERVE_EXCESS_TOLERANCE_BPS) {
        throw new OnchainSupplyValidationError("Movement xReserve excess backing exceeds 500 basis points");
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
    const supplySource = adjustment?.supplySource ?? clockedSupply?.supplySource ?? "onchain-total-supply";
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
      return { mcap, nativeSupply: supply, rawSupply: supplyRaw, decimals, supplySource, observedAt, observedBlock, chain: input.supplyContract.chain, chainLabel };
    }
  } catch (err) {
    throwIfAborted(supplySignal);
    return reject("supply-probe-failed", err,
      err instanceof OnchainSupplyValidationError || err instanceof XrplSupplyValidationError ? "partition-invalid" : "legs-unreadable");
  }

  return reject("supply-valuation-invalid");
}

/**
 * Read canonical-chain lockboxes against the same pinned state as total supply.
 */
async function fetchEscrowBalances(input: {
  meta: StablecoinMeta;
  escrowAddresses: readonly string[];
  supplyContract: NonNullable<StablecoinMeta["contracts"]>[number];
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  curated?: { rpcUrl?: string; fallbackRpcUrl?: string };
  observedBlock: EvmBlockHeader;
  onFailure?: (reason: PartitionReadFailure) => void;
}): Promise<bigint[] | null> {
  if (!isFixedDecimalDeployment(input.supplyContract)) {
    logWorkerEventArgs("handler", "warn",
      `[fiat-cg] ${contractChainLabel(input.supplyContract)} escrow balance probe skipped for ${input.meta.symbol}: contract has no fixed-decimal amount encoding`,
    );
    return null;
  }
  try {
    const rpcOptions = joinedSupplyRpcOptions(input);
    const balances: bigint[] = [];
    for (const escrowAddress of input.escrowAddresses) {
      const balance = await fetchEvmUint256AtBlock(input.supplyContract.chain, input.supplyContract.address,
        encodeBalanceOfCallData(escrowAddress), input.observedBlock.number,
        { ...rpcOptions, stateBlockHash: input.observedBlock.hash });
      if (balance == null || balance < 0n) {
        input.onFailure?.(balance == null ? "legs-unreadable" : "partition-invalid");
        return null;
      }
      balances.push(balance);
    }
    await confirmJoinedSupplyBlock(input.supplyContract.chain, input.observedBlock, rpcOptions);
    return balances;
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
  if (isKinesisWrapperSupplyId(meta.id) && !isKinesisWrapperSupplyCutoverActive(meta.id, Math.floor(Date.now() / 1000))) return null;
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
  if (result && result.observedAt > Math.floor(Date.now() / 1000)) {
    onFailure?.("partition-invalid");
    return null;
  }
  return result
    ? {
        mcap: result.mcap,
        nativeSupply: result.nativeSupply,
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
  if (isKinesisWrapperSupplyId(meta.id) && !isKinesisWrapperSupplyCutoverActive(meta.id, Math.floor(Date.now() / 1000))) return null;
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
  let observedAt: number | null = null;
  let supplySource: SupplementalOnChainSupplySource = "onchain-total-supply";
  const observedBlocks = new Map<string, EvmBlockHeader>();

  let totalMcap = 0;
  let totalNativeSupply = 0;
  const chainCirculating: Record<string, OnChainMcapChainRow> = {};
  const canonicalSupplyChain = CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id];
  const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id];
  const escrowRoutes = residual?.escrowByChain ? Object.entries(residual.escrowByChain) : null;
  const representations = new Map<string, ContractOnChainMcapResult>();
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
      if (!result || (result.supplySource !== "onchain-total-supply" && result.supplySource !== "onchain-circulating-supply")) {
        // Keep the first in-roster failure when a batch reads more than one leg.
        if (!result) onFailure?.(batchFailures[index] ?? "partition-invalid");
        return null;
      }
      if (result.supplySource === "onchain-circulating-supply") supplySource = "onchain-circulating-supply";
      observedAt = observedAt == null ? result.observedAt : Math.min(observedAt, result.observedAt);

      if (canonicalSupplyChain) {
        if (result.chain === canonicalSupplyChain) {
          canonicalResult = result;
        } else {
          representationMcap += result.mcap;
          if (escrowRoutes) {
            if (representations.has(result.chain)) {
              onFailure?.("partition-invalid");
              return null;
            }
            representations.set(result.chain, result);
          }
        }
      } else {
        totalMcap += result.mcap;
        totalNativeSupply += result.nativeSupply ?? Number.NaN;
      }

      const existing = chainCirculating[result.chainLabel];
      chainCirculating[result.chainLabel] = {
        current: (existing?.current ?? 0) + result.mcap,
        chainId: existing?.chainId ?? result.chain,
      };
    }
  }

  if (canonicalSupplyChain) {
    if (!canonicalResult || (!escrowRoutes && representationMcap >= canonicalResult.mcap)) {
      onFailure?.("partition-invalid");
      return null;
    }
    totalMcap = canonicalResult.mcap;
    totalNativeSupply = canonicalResult.nativeSupply ?? Number.NaN;

    if (residual) {
      const canonicalLeg = selectedContracts.find(({ config }) => config.chain === canonicalSupplyChain);
      const decimals = canonicalResult.decimals;
      if (!canonicalLeg || !canonicalResult.observedBlock || decimals == null) {
        onFailure?.("partition-invalid");
        return null;
      }

      const escrowBalances = await fetchEscrowBalances({
        meta,
        escrowAddresses: residual.escrowByChain ? Object.values(residual.escrowByChain) : [residual.escrowAddress],
        supplyContract: canonicalLeg.contract,
        chainRpcs,
        signal,
        curated: canonicalLeg.config,
        observedBlock: canonicalResult.observedBlock,
        onFailure,
      });
      throwIfAborted(signal);
      if (!escrowBalances) return null;
      const escrowRaw = escrowBalances.reduce((total, balance) => total + balance, 0n);
      const valueRaw = (raw: bigint) => (Number(raw) / 10 ** decimals) * priceUsd;
      let canonicalMcap: number;
      let unattributedMcap: number;
      // Fail closed: the escrow read is the whole point of the refinement, so an
      // unreadable or nonsensical balance must not quietly republish the
      // unattributed remainder as canonical-chain float.
      if (escrowRoutes) {
        const canonicalRaw = canonicalResult.rawSupply;
        if (canonicalRaw == null || escrowRaw > canonicalRaw || representations.size !== escrowRoutes.length) {
          onFailure?.("partition-invalid");
          return null;
        }
        let residualRaw = 0n;
        for (const [index, [chain]] of escrowRoutes.entries()) {
          const remote = representations.get(chain);
          const balance = escrowBalances[index]!;
          if (remote?.rawSupply == null || remote.decimals !== canonicalResult.decimals || balance < remote.rawSupply) {
            onFailure?.("partition-invalid");
            return null;
          }
          residualRaw += balance - remote.rawSupply;
        }
        canonicalMcap = valueRaw(canonicalRaw - escrowRaw);
        unattributedMcap = valueRaw(residualRaw);
      } else {
        const escrowMcap = valueRaw(escrowRaw);
        if (!Number.isFinite(escrowMcap) || escrowMcap < representationMcap || escrowMcap >= canonicalResult.mcap) {
          onFailure?.("partition-invalid");
          return null;
        }
        canonicalMcap = canonicalResult.mcap - escrowMcap;
        unattributedMcap = escrowMcap - representationMcap;
      }

      chainCirculating[canonicalResult.chainLabel] = {
        current: canonicalMcap,
        chainId: canonicalResult.chain,
      };
      if (unattributedMcap > 0 || escrowRoutes) {
        chainCirculating[residual.unattributedChainLabel] = { current: unattributedMcap };
      }
    } else {
      chainCirculating[canonicalResult.chainLabel] = {
        current: canonicalResult.mcap - representationMcap,
        chainId: canonicalResult.chain,
      };
    }
  }

  if (
    !Number.isFinite(totalMcap) || totalMcap < 0 || (totalMcap === 0 && !isKinesisWrapperSupplyId(meta.id)) ||
    observedAt == null || observedAt > Math.floor(Date.now() / 1000)
  ) {
    onFailure?.("partition-invalid");
    return null;
  }
  return {
    mcap: totalMcap,
    nativeSupply: Number.isFinite(totalNativeSupply) ? totalNativeSupply : undefined,
    supplySource,
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
