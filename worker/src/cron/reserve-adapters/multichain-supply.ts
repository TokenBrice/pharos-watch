import type { ContractDeployment, ReserveAdapterCoin } from "@shared/types/core";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { CHAIN_META } from "@shared/types/chain-identity";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  DEFAULT_MAX_RESERVE_SUPPLY_SKEW_SEC,
  type IssuerNativeLiabilityScope,
  type NotComparableLiabilityScope,
} from "@shared/types/live-reserve-adapter-declarations";
import type {
  LiabilityRatioUnavailableReason,
  LiveReserveInput,
  LiveReserveLiabilityScopeMetadata,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import { hasRegistryRpc, registryRpcUrls } from "../../lib/chain-registry";
import { rethrowIfAborted } from "../../lib/abort";
import { DECIMALS_SELECTOR } from "../../lib/evm-selectors";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { pinnedBlockPlan } from "./evm-observation-plan";
import { fetchErc20TotalSupply, fetchOnchainUint256, fetchTronErc20TotalSupply } from "./onchain";
import { APTOS_PUBLIC_REST_URL, fetchMoveFungibleAssetSupply, fetchSolanaMintSupply } from "./token-supply";
import type { AdapterContext } from "./types";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

export interface MultichainSupplyContribution {
  chain: string;
  tokenAddress: string;
  raw: bigint;
  decimals: number;
  /** Unix seconds the read observed: pinned block or ledger time, else the
   *  run clock for latest-state reads. Set by scoped liability reads. */
  observedAt?: number;
}

export interface MultichainSupplyAggregate {
  contributions: MultichainSupplyContribution[];
  omittedNonEvmChains: string[];
  omittedNoRpcChains: string[];
  omittedReadFailureChains: string[];
}

/** Supply read against a reviewed issuer-native liability perimeter. Scoped
 *  aggregates never omit by chain type: every catalog chain is included,
 *  excluded by review, or reported as unclassified. */
export interface ScopedLiabilitySupply extends MultichainSupplyAggregate {
  scope: IssuerNativeLiabilityScope;
  unclassifiedChains: string[];
  failedChains: Array<{ chain: string; reason: string }>;
}

export function isEvmContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "evm";
}

export function isTronContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "tron";
}

/**
 * True when an EVM chain has a registry RPC entry in the context's chainRpc map.
 * Tron resolves through TronGrid rather than chainRpcs, so callers should
 * only consult this for EVM contracts. A missing chainRpc map (smoke/test
 * contexts) means the caller did not supply RPC resolution, so the chain is
 * treated as readable and left to fail through its normal read path.
 *
 * Supplemental endpoints do not count: a config whose only endpoints are
 * supplemental (a pin-only chain reached through the Dwellir trial) is not a
 * registry read path, so supply aggregates keep omitting exactly the chains
 * they omit without the trial key.
 */
export function chainHasRpc(chain: string, ctx?: AdapterContext): boolean {
  const chainRpcs = ctx?.chainRpcs;
  return chainRpcs == null || hasRegistryRpc(chainRpcs.get(chain));
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
  coin: ReserveAdapterCoin;
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
    (entry): entry is { contract: ContractDeployment & { decimals: number }; raw: bigint; noRpc: boolean } =>
      entry.raw != null && entry.raw > 0n && isFixedDecimalDeployment(entry.contract),
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

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

/** One included-chain EVM read: raw totalSupply() and decimals() at one block. */
export interface ScopedEvmTokenRead {
  raw: bigint | null;
  decimals: bigint | null;
  observedAt?: number;
}

interface PinnedPlan {
  observedBlock: NonNullable<AdapterContext["observedBlock"]>;
  ctx: AdapterContext;
}

/**
 * Reads `totalSupply()` and `decimals()` for an included EVM deployment at one
 * pinned block per chain, so every contribution carries the block time it
 * observed. Primary-chain RPC overrides apply only to the input chain; the
 * caller may seed the input chain with the plan its own feed reads used.
 */
export function pinnedEvmTokenReader(options: {
  input: EvmInput;
  signal: AbortSignal;
  ctx?: AdapterContext;
  primaryPlan?: Promise<PinnedPlan>;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}): (contract: ContractDeployment) => Promise<ScopedEvmTokenRead> {
  const { input, signal, ctx, rpcUrl, fallbackRpcUrl } = options;
  const plans = new Map<string, Promise<PinnedPlan>>();
  if (options.primaryPlan) plans.set(input.chain, options.primaryPlan);
  return async (contract) => {
    const primary = contract.chain === input.chain;
    const chainRpcUrl = primary ? rpcUrl : undefined;
    const chainFallbackRpcUrl = primary ? fallbackRpcUrl : undefined;
    let plan = plans.get(contract.chain);
    if (!plan) {
      plan = pinnedBlockPlan({
        chain: contract.chain,
        signal,
        ctx: { ...ctx, observedBlock: undefined },
        rpcUrl: chainRpcUrl,
        fallbackRpcUrl: chainFallbackRpcUrl,
      });
      plans.set(contract.chain, plan);
    }
    const pinned = await plan;
    const chainInput = { ...input, chain: contract.chain };
    const [raw, decimals] = await Promise.all([
      fetchErc20TotalSupply(chainInput, contract.address, signal, pinned.ctx, chainRpcUrl, chainFallbackRpcUrl),
      fetchOnchainUint256({
        contract: contract.address,
        data: DECIMALS_SELECTOR,
        signal,
        ctx: pinned.ctx,
        rpcUrl: chainRpcUrl,
        fallbackRpcUrl: chainFallbackRpcUrl,
        rpcMode: chainInput.rpcMode,
        chain: contract.chain,
      }),
    ]);
    return { raw, decimals, observedAt: pinned.observedBlock.timestamp };
  };
}

type IncludedRead =
  | { ok: true; contribution: MultichainSupplyContribution }
  | { ok: false; chain: string; reason: string };

async function readIncludedSupply(
  entry: IssuerNativeLiabilityScope["included"][number],
  contract: ContractDeployment & { decimals: number },
  options: {
    signal: AbortSignal;
    nowSec: number;
    ctx?: AdapterContext;
    tronCtx?: AdapterContext;
    readEvmToken: (contract: ContractDeployment) => Promise<ScopedEvmTokenRead>;
  },
): Promise<IncludedRead> {
  const { signal, nowSec, ctx, tronCtx, readEvmToken } = options;
  const fail = (reason: string): IncludedRead => ({ ok: false, chain: entry.chain, reason });
  // Supply is scaled by the decimals the chain itself reports; a catalog
  // disagreement fails closed instead of mis-scaling the denominator.
  const admit = (raw: bigint, onchainDecimals: number | null, observedAt: number): IncludedRead => {
    if (onchainDecimals != null && onchainDecimals !== contract.decimals) {
      return fail(`on-chain decimals ${onchainDecimals} differ from catalog decimals ${contract.decimals}`);
    }
    return {
      ok: true,
      contribution: { chain: entry.chain, tokenAddress: contract.address, raw, decimals: contract.decimals, observedAt },
    };
  };
  const chainType = CHAIN_META[entry.chain]?.type;

  switch (entry.reader) {
    case "evm-erc20": {
      if (chainType !== "evm") return fail(`reader evm-erc20 does not match chain type ${chainType ?? "unknown"}`);
      if (!chainHasRpc(entry.chain, ctx)) return fail("no RPC configured");
      const read = await readEvmToken(contract);
      if (read.raw == null) return fail("totalSupply() read failed");
      if (read.decimals == null || read.decimals > 255n) return fail("decimals() read failed");
      return admit(read.raw, Number(read.decimals), read.observedAt ?? nowSec);
    }
    case "tron-trc20": {
      if (chainType !== "tron") return fail(`reader tron-trc20 does not match chain type ${chainType ?? "unknown"}`);
      const raw = await fetchTronErc20TotalSupply(contract.address, signal, tronCtx ?? ctx);
      if (raw == null) return fail("totalSupply() read failed");
      // The completion clock is the actual latest-state observation, not the
      // caller's earlier reserve/run clock. Skew admission remains unchanged.
      return admit(raw, null, Math.floor(Date.now() / 1000));
    }
    case "solana-spl-mint": {
      if (entry.chain !== "solana") return fail(`reader solana-spl-mint does not serve chain ${entry.chain}`);
      const mint = await fetchSolanaMintSupply(contract.address, signal, ctx);
      if (!mint) return fail("SPL mint account read failed");
      return admit(mint.rawSupply, mint.decimals, nowSec);
    }
    case "aptos-fungible-asset": {
      if (entry.chain !== "aptos") return fail(`reader aptos-fungible-asset does not serve chain ${entry.chain}`);
      // A registry `aptos` endpoint takes precedence over the public REST base.
      const restUrl = registryRpcUrls(ctx?.chainRpcs?.get("aptos"))[0] ?? APTOS_PUBLIC_REST_URL;
      const asset = await fetchMoveFungibleAssetSupply(contract.address, signal, restUrl, ctx);
      if (!asset) return fail("fungible-asset ledger read failed");
      return admit(asset.rawSupply, asset.decimals, asset.ledgerTimestampSec ?? nowSec);
    }
  }
}

/**
 * Reads liabilities over a reviewed issuer-native perimeter. Only `included`
 * chains are read, each with its declared reader; `excluded` chains are never
 * read or added. A catalog chain the scope does not classify is reported in
 * `unclassifiedChains`, and a failed or mis-scaled included read lands in
 * `failedChains` rather than counting as zero. A zero read is a valid empty
 * deployment. Throws only when no included read succeeds.
 */
export async function aggregateScopedLiabilitySupply(options: {
  coin: ReserveAdapterCoin;
  scope: IssuerNativeLiabilityScope;
  adapterKey: string;
  signal: AbortSignal;
  nowSec: number;
  ctx?: AdapterContext;
  tronCtx?: AdapterContext;
  readEvmToken: (contract: ContractDeployment) => Promise<ScopedEvmTokenRead>;
}): Promise<ScopedLiabilitySupply> {
  const { coin, scope, adapterKey, signal } = options;
  const contracts = coin.contracts ?? [];
  const catalogChains = new Set(contracts.map((contract) => contract.chain));
  const classified = new Set<string>();
  const invalidScopeChains = new Set<string>();
  const includedChains = new Set(scope.included.map((entry) => entry.chain));
  for (const entry of [...scope.included, ...scope.excluded]) {
    if (classified.has(entry.chain) || !catalogChains.has(entry.chain)) invalidScopeChains.add(entry.chain);
    classified.add(entry.chain);
  }
  for (const entry of scope.excluded) {
    if (contracts.filter((contract) => contract.chain === entry.chain).length !== 1
      || (entry.relation === "lock-mint-representation"
        && (!entry.backedBy || !includedChains.has(entry.backedBy)))) {
      invalidScopeChains.add(entry.chain);
    }
  }
  const unclassifiedChains = [...new Set([
    ...contracts.map((contract) => contract.chain).filter((chain) => !classified.has(chain)),
    ...invalidScopeChains,
  ])];

  const seenIncluded = new Set<string>();
  const uniqueIncluded = scope.included.filter((entry) => {
    if (seenIncluded.has(entry.chain)) return false;
    seenIncluded.add(entry.chain);
    return true;
  });
  const reads = await Promise.all(uniqueIncluded.map(async (entry): Promise<IncludedRead> => {
    const deployments = contracts.filter((contract) => contract.chain === entry.chain);
    if (deployments.length !== 1) {
      return {
        ok: false,
        chain: entry.chain,
        reason: deployments.length === 0 ? "no catalog deployment" : "multiple catalog deployments",
      };
    }
    const contract = deployments[0];
    if (contract.decimals == null) {
      return { ok: false, chain: entry.chain, reason: "catalog decimals are missing" };
    }
    try {
      return await readIncludedSupply(entry, { ...contract, decimals: contract.decimals }, options);
    } catch (error) {
      rethrowIfAborted(error, signal);
      return { ok: false, chain: entry.chain, reason: redactProviderUrls(toErrorMessage(error)) };
    }
  }));

  const contributions = reads.flatMap((read) => (read.ok ? [read.contribution] : []));
  const failedChains = reads.flatMap((read) => (read.ok ? [] : [{ chain: read.chain, reason: read.reason }]));
  if (contributions.length === 0) {
    throw new Error(`${adapterKey}: every included liability supply read failed for ${coin.id}`);
  }

  return {
    scope,
    unclassifiedChains,
    failedChains,
    contributions,
    omittedNonEvmChains: [],
    omittedNoRpcChains: [],
    omittedReadFailureChains: failedChains.map((failure) => failure.chain),
  };
}

export interface LiabilityCoverage {
  /** Every attempted supply read succeeded. */
  supplyReadComplete: boolean;
  /** Every chain is classified (or read) and every included read succeeded. */
  supplyCoverageComplete: boolean;
  /** Set when the reserve/liability ratio must be withheld. */
  ratioUnavailableReason?: LiabilityRatioUnavailableReason;
  /** Scope, coverage and time-identity metadata to spread into the snapshot. */
  metadata: Record<string, unknown>;
  warnings: LiveReserveWarning[];
}

function isScopedLiabilitySupply(
  supply: MultichainSupplyAggregate | ScopedLiabilitySupply,
): supply is ScopedLiabilitySupply {
  return "scope" in supply;
}

function unscopedOmissionWarnings(supply: MultichainSupplyAggregate): LiveReserveWarning[] {
  const warnings: LiveReserveWarning[] = [];
  if (supply.omittedNonEvmChains.length > 0) {
    warnings.push(reserveInfoWarning(
      "por-supply-chain-omitted",
      `Supply aggregation omits non-EVM chains: ${supply.omittedNonEvmChains.join(", ")}`,
    ));
  }
  if (supply.omittedNoRpcChains.length > 0) {
    warnings.push(reserveInfoWarning(
      "por-supply-chain-omitted",
      `Supply aggregation omits chains with no RPC configured: ${supply.omittedNoRpcChains.join(", ")}`,
    ));
  }
  if (supply.omittedReadFailureChains.length > 0) {
    warnings.push(reserveDegradedWarning(
      "partial-supply-read-failure",
      `Supply aggregation omits chains whose totalSupply() read failed: ${supply.omittedReadFailureChains.join(", ")}`,
    ));
  }
  return warnings;
}

/**
 * The single admission rule for a supply-comparing reserve ratio. Scoped
 * supply must classify every catalog chain, read every included chain, and
 * sit within the scope's reserve/supply skew bound. Unscoped supply must omit
 * no chain and fail no read. A declared not-comparable basis always withholds.
 */
export function evaluateLiabilityCoverage(input: {
  supply: MultichainSupplyAggregate | ScopedLiabilitySupply;
  notComparable?: NotComparableLiabilityScope;
  reserveObservedAt: number;
}): LiabilityCoverage {
  const { supply, notComparable, reserveObservedAt } = input;
  const supplyReadComplete = supply.omittedReadFailureChains.length === 0;

  if (notComparable) {
    return {
      supplyReadComplete,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "not-comparable",
      metadata: {
        supplyReadComplete,
        supplyCoverageComplete: false,
        liabilityScope: {
          basis: "not-comparable",
          canonicalChain: notComparable.canonicalChain,
          reason: notComparable.reason,
        } satisfies LiveReserveLiabilityScopeMetadata,
        ratioUnavailableReason: "not-comparable",
      },
      warnings: [
        ...unscopedOmissionWarnings(supply),
        reserveInfoWarning(
          "por-supply-scope-incomplete",
          `On-chain supply covers only registry deployments, while the canonical ${notComparable.canonicalChain} supply is not readable by this adapter; no coverage ratio is published (${notComparable.reason})`,
        ),
      ],
    };
  }

  if (!isScopedLiabilitySupply(supply)) {
    const supplyCoverageComplete = supplyReadComplete
      && supply.omittedNonEvmChains.length === 0
      && supply.omittedNoRpcChains.length === 0;
    const ratioUnavailableReason: LiabilityRatioUnavailableReason | undefined =
      supply.omittedNonEvmChains.length > 0 || supply.omittedNoRpcChains.length > 0
        ? "liability-scope-unclassified-chain"
        : !supplyReadComplete ? "included-supply-read-failed"
        : supply.contributions.every((row) => row.raw === 0n) ? "zero-liability-denominator" : undefined;
    return {
      supplyReadComplete,
      supplyCoverageComplete,
      ...(ratioUnavailableReason ? { ratioUnavailableReason } : {}),
      metadata: {
        supplyReadComplete,
        supplyCoverageComplete,
        ...(ratioUnavailableReason ? { ratioUnavailableReason } : {}),
      },
      warnings: unscopedOmissionWarnings(supply),
    };
  }

  const { scope, unclassifiedChains, failedChains } = supply;
  const warnings: LiveReserveWarning[] = [];
  if (unclassifiedChains.length > 0) {
    warnings.push(reserveDegradedWarning(
      "por-liability-scope-unclassified",
      `Reviewed liability scope does not classify catalog chains: ${unclassifiedChains.join(", ")}; no ratio is published until they are reviewed`,
    ));
  }
  if (failedChains.length > 0) {
    warnings.push(reserveDegradedWarning(
      "partial-supply-read-failure",
      `Included liability supply reads failed: ${failedChains.map((failure) => `${failure.chain} (${failure.reason})`).join(", ")}`,
    ));
  }
  const supplyCoverageComplete = unclassifiedChains.length === 0 && failedChains.length === 0;

  const observedTimes = supply.contributions
    .map((contribution) => contribution.observedAt)
    .filter((observedAt): observedAt is number => observedAt != null);
  const supplyObservedAt = observedTimes.length > 0
    ? { min: Math.min(...observedTimes), max: Math.max(...observedTimes) }
    : undefined;
  const ratioSkewSec = supplyObservedAt
    ? Math.max(Math.abs(supplyObservedAt.min - reserveObservedAt), Math.abs(supplyObservedAt.max - reserveObservedAt))
    : undefined;
  const maxReserveSupplySkewSec = scope.maxReserveSupplySkewSec ?? DEFAULT_MAX_RESERVE_SUPPLY_SKEW_SEC;

  let ratioUnavailableReason: LiabilityRatioUnavailableReason | undefined;
  if (unclassifiedChains.length > 0) {
    ratioUnavailableReason = "liability-scope-unclassified-chain";
  } else if (failedChains.length > 0) {
    ratioUnavailableReason = "included-supply-read-failed";
  } else if (ratioSkewSec == null || ratioSkewSec > maxReserveSupplySkewSec) {
    ratioUnavailableReason = "reserve-supply-time-skew";
    warnings.push(reserveInfoWarning(
      "reserve-supply-time-skew",
      `Reserve observation and liability supply reads are ${ratioSkewSec ?? "an unknown number of"}s apart (bound ${maxReserveSupplySkewSec}s); ratio withheld`,
    ));
  } else if (supply.contributions.every((row) => row.raw === 0n)) {
    ratioUnavailableReason = "zero-liability-denominator";
  }

  const liabilityScope: LiveReserveLiabilityScopeMetadata = {
    basis: "issuer-native-supply",
    reviewedAt: scope.reviewedAt,
    evidenceRef: scope.evidenceRef,
    includedChains: scope.included.map((entry) => entry.chain),
    excludedChains: scope.excluded.map((entry) => ({
      chain: entry.chain,
      relation: entry.relation,
      ...(entry.backedBy ? { backedBy: entry.backedBy } : {}),
      reason: entry.reason,
    })),
    unclassifiedChains,
    failedChains,
    maxReserveSupplySkewSec,
  };

  return {
    supplyReadComplete,
    supplyCoverageComplete,
    ...(ratioUnavailableReason ? { ratioUnavailableReason } : {}),
    metadata: {
      supplyReadComplete,
      supplyCoverageComplete,
      liabilityScope,
      reserveObservedAt,
      ...(supplyObservedAt ? { supplyObservedAt } : {}),
      ...(ratioSkewSec != null ? { ratioSkewSec } : {}),
      ...(ratioUnavailableReason ? { ratioUnavailableReason } : {}),
    },
    warnings,
  };
}
