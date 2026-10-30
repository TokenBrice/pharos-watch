import { CHAIN_META } from "@shared/types/chain-identity";
import {
  deploymentSupplyCensusRejectionCode,
  type V9DeploymentSupplyCensusPin,
  type V9DeploymentSupplyCensusRejection,
  type V9DeploymentSupplyCensusRejectionReason,
  type V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { compareCodeUnits } from "@shared/lib/compare";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import type { ChainRpcConfig } from "../chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  type EvmMulticall3Call,
  type EvmRpcOptions,
} from "../evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../evm-selectors";
import { sha256Hex } from "../hash";
import { decodeEvmUint256 } from "./supply-observation-primitives";

/**
 * v10.38 deployment supply census, EVM half (`deployment-supply-census-v1`, WS6 / 4a).
 *
 * Tier 1 reads `totalSupply()` + `decimals()` for every reviewed deployment on
 * ONE pinned header per chain (Multicall3 `aggregate3`, at most
 * `evmMulticallMaxBatchSize` calls per request), then hashes that deployment's
 * runtime code at the same pin. A row is an upper bound on the deployment's
 * supply, never an exact share: `evidenceKind: "upper-bound"` travels with it.
 *
 * Admission gates enforced here, all fail-closed (R3/R4/R8):
 * - pin age `observationMaxAgeSec` and cross-chain skew `observationMaxSkewSec`
 *   from `semantic.supplyAttribution.deploymentSupplyCensus` (single authority);
 * - `requireRuntimeCodeHash`: no code hash, no row (`missing-code-hash`);
 * - per-asset `maxDeploymentsPerAsset`, rejected whole-asset, never truncated;
 * - tier 0: the measured USD partition of one chain may not exceed that
 *   chain's supplied circulating bound (`conservation-breach`), the usdcx class;
 * - every rejection is `census-rejected:<reason>`, never a zero or a clamp.
 *
 * Connection budget: this module never opens more than `chainConcurrency` (3)
 * simultaneous outbound requests, each chain is read serially, and every
 * physical attempt passes the caller's `beforeRequest` gate. Callers own the
 * slot-level reserve (`docs/worker-and-api-limits.md#connection-budget-operating-assumption`).
 */
export const DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET = Object.freeze({
  /** In-flight chains; each chain read is internally serial (3 of 6 connections). */
  chainConcurrency: 3,
  chainTimeoutMs: 15_000,
  wallTimeoutMs: 180_000,
  publicationReserveMs: 15_000,
  maxEvmRequests: 768,
  maxResponseBytes: 128 * 1024,
  /**
   * Headers are full block bodies, not state results: `eth_getBlockByNumber`
   * carries every transaction hash. Base (200 ms blocks) routinely exceeds the
   * state cap — 90 of 1,500 blocks at the 2026-10-29 census bracket were over
   * 128 KiB, peaking at 543 KB — which made every Base pin read fail and
   * rejected the chain `missing-block-pin`. Header reads get their own bound.
   */
  headerResponseBytes: 1_024 * 1_024,
  /** One retry per header probe: a 429/transport blip must not reject a chain. */
  pinRetries: 1,
  maxQuantityDigits: 78,
});

const CENSUS_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.deploymentSupplyCensus;
const SUPPLY_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
const MAX_CENSUS_QUANTITY = 10n ** BigInt(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxQuantityDigits);
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const MAX_DECIMALS = 36;

/** One deployment to measure. Shared with the non-EVM reader so there is one target shape. */
export interface DeploymentSupplyCensusReadTarget {
  readonly assetId: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly routeId: string;
  /** Reviewed route decimals; `null` admits whatever the contract reports. */
  readonly expectedDecimals: number | null;
  /** Solana mint owner (non-EVM reader only). */
  readonly programOwner?: string;
  /** Move package address (non-EVM reader only). */
  readonly packageAddress?: string;
}

/** One measured deployment: exact integer supply plus the pin that produced it. */
export interface DeploymentSupplyCensusMeasuredRow {
  readonly decimals: number;
  readonly totalSupplyRaw: string;
  readonly pin: V9DeploymentSupplyCensusPin;
}

/**
 * Per-chain read result. `rows` are measurements, not yet USD rows; the shared
 * type lets the census assembly switch on `kind` regardless of chain family.
 */
export type DeploymentSupplyCensusChainRead =
  | {
      readonly kind: "measured";
      readonly rows: ReadonlyMap<string, DeploymentSupplyCensusMeasuredRow>;
      readonly rejected: ReadonlyMap<string, V9DeploymentSupplyCensusRejectionReason>;
    }
  | { readonly kind: "rejected"; readonly reason: V9DeploymentSupplyCensusRejectionReason };

/** One pinned EVM header, shared by every deployment of every asset on that chain. */
export interface DeploymentSupplyCensusEvmChainAnchor {
  readonly blockNumber: number;
  readonly blockHash: `0x${string}`;
  readonly blockTimeSec: number;
}

export type DeploymentSupplyCensusEvmPinResolution =
  | { readonly kind: "pinned"; readonly anchor: DeploymentSupplyCensusEvmChainAnchor }
  | { readonly kind: "rejected"; readonly reason: V9DeploymentSupplyCensusRejectionReason };

/** Reference price for the deployment's unit, as the assembler resolved it. */
export interface DeploymentSupplyCensusReferencePrice {
  readonly priceUsd: number;
  readonly observedAtSec: number;
}

/** One asset's EVM census contribution: wire rows plus machine rejections. */
export interface DeploymentSupplyCensusEvmCensus {
  readonly rows: readonly V9DeploymentSupplyCensusRow[];
  readonly rejected: readonly V9DeploymentSupplyCensusRejection[];
}

export interface DeploymentSupplyCensusEvmDependencies {
  readonly fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  readonly fetchEvmCodeStatusAtBlock: typeof fetchEvmCodeStatusAtBlock;
  readonly fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock;
  readonly resolveClosestBlockAtOrBeforeTimestamp: typeof resolveClosestBlockAtOrBeforeTimestamp;
  readonly sha256Hex: typeof sha256Hex;
}

const DEFAULT_DEPENDENCIES: DeploymentSupplyCensusEvmDependencies = {
  fetchEvmBlockHeader,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  sha256Hex,
};

function rejection(
  routeId: string | null,
  reason: V9DeploymentSupplyCensusRejectionReason,
): V9DeploymentSupplyCensusRejection {
  return { routeId, code: deploymentSupplyCensusRejectionCode(reason) };
}

function evmChainType(chainId: string): boolean {
  // TRON's numbered selector only checks existence and executes latest state;
  // its historical contract is a read kind this census does not have.
  return chainId !== "tron" && CHAIN_META[chainId]?.type === "evm";
}

function normalizeEvmTokenAddress(value: string): string | null {
  const normalized = value.toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? normalized : null;
}

function chainConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainConcurrency;
  return Math.min(DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainConcurrency, Math.max(1, Math.floor(value)));
}

function censusOptions(input: {
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  deadlineMs?: number;
  beforeRequest?: EvmRpcOptions["beforeRequest"];
  stateBlockHash?: `0x${string}`;
  maxResponseBytes?: number;
  maxRetries?: number;
}): EvmRpcOptions {
  return {
    chainRpcs: input.chainRpcs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.beforeRequest === undefined ? {} : { beforeRequest: input.beforeRequest }),
    ...(input.stateBlockHash === undefined ? {} : { stateBlockHash: input.stateBlockHash }),
    maxRetries: input.maxRetries ?? 0,
    multicallBatchSize: CENSUS_POLICY.evmMulticallMaxBatchSize,
    maxResponseBytes: input.maxResponseBytes ?? DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxResponseBytes,
  };
}

function anchorRejection(
  anchor: DeploymentSupplyCensusEvmChainAnchor,
  scoringClockSec: number,
): V9DeploymentSupplyCensusRejectionReason | null {
  if (anchor.blockTimeSec > scoringClockSec) return "future-dated-pin";
  if (scoringClockSec - anchor.blockTimeSec > SUPPLY_POLICY.observationMaxAgeSec) return "observation-stale";
  return null;
}

/**
 * Resolve one header per chain at or before the census clock, with bounded
 * concurrency. Every requested chain gets a resolution: an unattempted or
 * failed chain is `missing-block-pin`, never a zero or the chain tip.
 */
export async function resolveDeploymentSupplyCensusEvmPins(
  input: {
    chainIds: readonly string[];
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    deadlineMs?: number;
    beforeRequest?: EvmRpcOptions["beforeRequest"];
  },
  dependencyOverrides: Partial<DeploymentSupplyCensusEvmDependencies> = {},
): Promise<Map<string, DeploymentSupplyCensusEvmPinResolution>> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const chainIds = [...new Set(input.chainIds)].sort();
  const resolutions = new Map<string, DeploymentSupplyCensusEvmPinResolution>(
    chainIds.map(chainId => [chainId, { kind: "rejected", reason: "missing-block-pin" }]),
  );
  const deadlineMs = Math.min(
    Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.wallTimeoutMs,
    input.deadlineMs ?? Infinity,
  );
  for (let offset = 0; offset < chainIds.length; offset += DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainConcurrency) {
    throwIfAborted(input.signal);
    if (Date.now() >= deadlineMs) break;
    const batch = chainIds.slice(offset, offset + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainConcurrency);
    await Promise.all(batch.map(async (chainId) => {
      if (!evmChainType(chainId)) {
        resolutions.set(chainId, { kind: "rejected", reason: "read-unavailable" });
        return;
      }
      const chainDeadlineMs = Math.min(Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainTimeoutMs, deadlineMs);
      const timeout = createTimeoutSignal({
        timeoutMs: Math.max(0, chainDeadlineMs - Date.now()),
        timeoutReason: "Deployment supply census pin deadline exceeded",
        parentSignal: input.signal,
      });
      try {
        const options = censusOptions({
          chainRpcs: input.chainRpcs, signal: timeout.signal, deadlineMs: chainDeadlineMs,
          beforeRequest: input.beforeRequest,
          maxResponseBytes: DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.headerResponseBytes,
          maxRetries: DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.pinRetries,
        });
        const blockNumber = await dependencies.resolveClosestBlockAtOrBeforeTimestamp(
          chainId, input.scoringClockSec, { blockTimestampByNumber: new Map() }, options,
        );
        // A bracketing search can fail for reasons that are not the clock's: a
        // non-archive endpoint prunes the exponential walk-back, a probe is
        // rate-limited, or the probe budget runs out (fraxtal at the 2026-10-30
        // first cycle). The chain's own `finalized` header is a real, hashed,
        // timestamped block the chain guarantees is behind the tip, so use it
        // when the search cannot bracket. `anchorRejection` still refuses a
        // future-dated or aged header. Never fall back to `latest`.
        let header = blockNumber === null
          ? await dependencies.fetchEvmBlockHeader(chainId, "finalized", options)
          : await dependencies.fetchEvmBlockHeader(chainId, blockNumber, options);
        if (header === null && blockNumber !== null) {
          header = await dependencies.fetchEvmBlockHeader(chainId, "finalized", options);
        }
        if (timeout.isTimedOut() || header === null) return;
        const anchor: DeploymentSupplyCensusEvmChainAnchor = {
          blockNumber: header.number, blockHash: header.hash, blockTimeSec: header.timestamp,
        };
        const reason = anchorRejection(anchor, input.scoringClockSec);
        resolutions.set(chainId, reason === null
          ? { kind: "pinned", anchor }
          : { kind: "rejected", reason });
      } catch (error) {
        rethrowIfAborted(error, input.signal);
      } finally {
        timeout.dispose();
      }
    }));
  }
  return resolutions;
}

/**
 * Tier 1 read of every target on one chain at one pinned header. The anchor is
 * required: a caller that cannot pin the chain must reject, not read `latest`.
 */
export async function observeDeploymentSupplyCensusEvmChain(
  input: {
    chainId: string;
    targets: readonly DeploymentSupplyCensusReadTarget[];
    anchor: DeploymentSupplyCensusEvmChainAnchor;
    scoringClockSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    deadlineMs?: number;
    beforeRequest?: EvmRpcOptions["beforeRequest"];
  },
  dependencyOverrides: Partial<DeploymentSupplyCensusEvmDependencies> = {},
): Promise<DeploymentSupplyCensusChainRead> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const { chainId, anchor, scoringClockSec } = input;
  if (!evmChainType(chainId)) return { kind: "rejected", reason: "read-unavailable" };
  if (input.targets.length === 0) return { kind: "measured", rows: new Map(), rejected: new Map() };
  const anchorReason = anchorRejection(anchor, scoringClockSec);
  if (anchorReason !== null) return { kind: "rejected", reason: anchorReason };
  const deadlineMs = Math.min(
    Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainTimeoutMs,
    input.deadlineMs ?? Infinity,
  );
  const options = censusOptions({
    chainRpcs: input.chainRpcs, signal: input.signal, deadlineMs,
    beforeRequest: input.beforeRequest, stateBlockHash: anchor.blockHash,
  });
  const rejected = new Map<string, V9DeploymentSupplyCensusRejectionReason>();
  try {
    // Runtime code is per deployment: one hash per token at the shared header.
    const codeSha256ByKey = new Map<string, string>();
    const readTargets: { target: DeploymentSupplyCensusReadTarget; tokenAddress: string }[] = [];
    for (const target of input.targets) {
      throwIfAborted(input.signal);
      const tokenAddress = normalizeEvmTokenAddress(target.tokenAddress);
      if (tokenAddress === null) {
        rejected.set(target.routeId, "route-unreviewed");
        continue;
      }
      const code = await dependencies.fetchEvmCodeStatusAtBlock(
        chainId, tokenAddress, anchor.blockNumber, options,
      );
      if (code.status === "unavailable") {
        rejected.set(target.routeId, "read-unavailable");
        continue;
      }
      if (code.status === "absent") {
        // No runtime, nothing to hash: an EOA cannot carry a supply partition.
        rejected.set(target.routeId, "missing-code-hash");
        continue;
      }
      codeSha256ByKey.set(target.routeId, await dependencies.sha256Hex(code.code.toLowerCase()));
      readTargets.push({ target, tokenAddress });
    }
    if (readTargets.length === 0) return { kind: "measured", rows: new Map(), rejected };

    const calls: EvmMulticall3Call[] = readTargets.flatMap(({ target, tokenAddress }) => [
      { label: `${target.routeId}:total-supply`, target: tokenAddress, callData: TOTAL_SUPPLY_SELECTOR, allowFailure: true },
      { label: `${target.routeId}:decimals`, target: tokenAddress, callData: DECIMALS_SELECTOR, allowFailure: true },
    ]);
    let results = await dependencies.fetchEvmMulticall3Aggregate3AtBlock(
      chainId, calls, anchor.blockNumber, options,
    );
    if (results === null) {
      // A failed aggregate is not zero. The fallback reads directly only after
      // proving Multicall3 absent, and authenticates the pinned header hash.
      results = await dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, anchor.blockNumber, {
        ...options, multicallFallbackBlockHash: anchor.blockHash,
      });
    }
    if (results === null || results.length !== calls.length) {
      for (const { target } of readTargets) rejected.set(target.routeId, "read-unavailable");
      return { kind: "measured", rows: new Map(), rejected };
    }

    const rows = new Map<string, DeploymentSupplyCensusMeasuredRow>();
    for (const [index, { target }] of readTargets.entries()) {
      const rawSupply = decodeEvmUint256(results[index * 2]);
      const decimals = decodeEvmUint256(results[index * 2 + 1]);
      if (rawSupply === null || decimals === null || decimals > BigInt(MAX_DECIMALS)) {
        rejected.set(target.routeId, "read-unavailable");
        continue;
      }
      const onChainDecimals = Number(decimals);
      if (target.expectedDecimals !== null && target.expectedDecimals !== onChainDecimals) {
        // The reviewed route identity does not describe this contract.
        rejected.set(target.routeId, "route-unreviewed");
        continue;
      }
      if (rawSupply < 0n || rawSupply >= MAX_CENSUS_QUANTITY) {
        rejected.set(target.routeId, "read-unavailable");
        continue;
      }
      rows.set(target.routeId, {
        decimals: onChainDecimals,
        totalSupplyRaw: rawSupply.toString(),
        pin: {
          kind: "evm-header",
          blockNumber: anchor.blockNumber,
          blockHash: anchor.blockHash,
          blockTimeSec: anchor.blockTimeSec,
          runtimeCodeSha256: codeSha256ByKey.get(target.routeId)!,
        },
      });
    }
    return { kind: "measured", rows, rejected };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { kind: "rejected", reason: "read-unavailable" };
  }
}

/**
 * Exact token units to USD, nudged up by a few ULPs so an upper bound never
 * under-states the deployment. `null` means the amount is not a usable number
 * for a USD bound, never zero.
 */
function totalSupplyUsdUpper(rawSupply: bigint, decimals: number, priceUsd: number): number | null {
  const usd = (Number(rawSupply) / 10 ** decimals) * priceUsd;
  if (!Number.isFinite(usd) || usd < 0) return null;
  return usd * (1 + Number.EPSILON * 8);
}

/**
 * Asset-level EVM census: one pinned header per chain, one `totalSupply` read
 * per deployment, tier-0 conservation against the supplied chain bound, and
 * C4 wire rows the census assembly merges with the non-EVM half.
 *
 * The caller may resolve pins once per run (`pins`); otherwise they are
 * resolved here. Rows are deterministic: sorted by deployment route key.
 */
export async function observeDeploymentSupplyCensusEvm(
  input: {
    targets: readonly DeploymentSupplyCensusReadTarget[];
    scoringClockSec: number;
    /** Asset aggregate circulating supply in USD: the share denominator. */
    aggregateSupplyUsd: number;
    /** Tier-0 chain bound: the provider's circulating supply in USD per chain. */
    chainSupplyUsdByChainId: ReadonlyMap<string, number>;
    referencePrices: ReadonlyMap<string, DeploymentSupplyCensusReferencePrice | null>;
    pins?: ReadonlyMap<string, DeploymentSupplyCensusEvmPinResolution>;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    deadlineMs?: number;
    beforeRequest?: EvmRpcOptions["beforeRequest"];
    chainConcurrency?: number;
  },
  dependencyOverrides: Partial<DeploymentSupplyCensusEvmDependencies> = {},
): Promise<DeploymentSupplyCensusEvmCensus> {
  const { scoringClockSec } = input;
  const rejected: V9DeploymentSupplyCensusRejection[] = [];
  const routeKeys = new Set<string>();
  if (input.targets.length > CENSUS_POLICY.maxDeploymentsPerAsset) {
    // An oversized roster cannot fill a partial packet; never truncate to 64.
    return { rows: [], rejected: [rejection(null, "deployment-over-cap")] };
  }
  for (const target of input.targets) {
    if (routeKeys.has(target.routeId)) {
      // A duplicated route is an inconsistent roster, not a second deployment.
      return { rows: [], rejected: [rejection(null, "roster-incomplete")] };
    }
    routeKeys.add(target.routeId);
  }
  if (!Number.isFinite(input.aggregateSupplyUsd) || input.aggregateSupplyUsd <= 0) {
    // Without the audited aggregate there is no share denominator; a row
    // without a share is not census evidence.
    return { rows: [], rejected: [rejection(null, "roster-incomplete")] };
  }
  if (input.targets.length === 0) return { rows: [], rejected: [] };

  const targetsByChainId = new Map<string, DeploymentSupplyCensusReadTarget[]>();
  for (const target of input.targets) {
    if (!evmChainType(target.chainId)) {
      rejected.push(rejection(target.routeId, "read-unavailable"));
      continue;
    }
    let targets = targetsByChainId.get(target.chainId);
    if (!targets) targetsByChainId.set(target.chainId, targets = []);
    targets.push(target);
  }
  const chainIds = [...targetsByChainId.keys()].sort();
  let evmRequests = 0;
  const beforeRequest = (url: string): boolean => {
    if (input.beforeRequest !== undefined && !input.beforeRequest(url)) return false;
    if (evmRequests >= DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.maxEvmRequests) return false;
    evmRequests += 1;
    return true;
  };
  const deadlineMs = Math.min(
    Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.wallTimeoutMs,
    input.deadlineMs === undefined
      ? Infinity
      : input.deadlineMs - DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.publicationReserveMs,
  );
  const pins = input.pins ?? await resolveDeploymentSupplyCensusEvmPins({
    chainIds,
    scoringClockSec,
    chainRpcs: input.chainRpcs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    deadlineMs,
    beforeRequest,
  }, dependencyOverrides);
  throwIfAborted(input.signal);

  interface Measurement {
    target: DeploymentSupplyCensusReadTarget;
    tokenAddress: string;
    measurement: DeploymentSupplyCensusMeasuredRow;
  }
  const measurements: Measurement[] = [];
  const concurrency = chainConcurrency(input.chainConcurrency);
  for (let offset = 0; offset < chainIds.length; offset += concurrency) {
    throwIfAborted(input.signal);
    if (Date.now() >= deadlineMs) break;
    const batch = chainIds.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (chainId) => {
      const targets = targetsByChainId.get(chainId)!;
      const resolution = pins.get(chainId) ?? { kind: "rejected" as const, reason: "missing-block-pin" as const };
      if (resolution.kind === "rejected") {
        return { chainId, targets, read: { kind: "rejected" as const, reason: resolution.reason } };
      }
      const chainDeadlineMs = Math.min(Date.now() + DEPLOYMENT_SUPPLY_CENSUS_EVM_BUDGET.chainTimeoutMs, deadlineMs);
      const timeout = createTimeoutSignal({
        timeoutMs: Math.max(0, chainDeadlineMs - Date.now()),
        timeoutReason: "Deployment supply census chain deadline exceeded",
        parentSignal: input.signal,
      });
      try {
        const read = await observeDeploymentSupplyCensusEvmChain({
          chainId,
          targets,
          anchor: resolution.anchor,
          scoringClockSec,
          chainRpcs: input.chainRpcs,
          signal: timeout.signal,
          deadlineMs: chainDeadlineMs,
          beforeRequest,
        }, dependencyOverrides);
        return { chainId, targets, read: timeout.isTimedOut() ? { kind: "rejected" as const, reason: "read-unavailable" as const } : read };
      } catch (error) {
        rethrowIfAborted(error, input.signal);
        return { chainId, targets, read: { kind: "rejected" as const, reason: "read-unavailable" as const } };
      } finally {
        timeout.dispose();
      }
    }));
    for (const { targets, read } of results) {
      for (const target of targets) {
        if (read.kind === "rejected") {
          rejected.push(rejection(target.routeId, read.reason));
          continue;
        }
        const reason = read.rejected.get(target.routeId);
        if (reason !== undefined) {
          rejected.push(rejection(target.routeId, reason));
          continue;
        }
        const measurement = read.rows.get(target.routeId);
        if (measurement === undefined) continue;
        measurements.push({ target, tokenAddress: normalizeEvmTokenAddress(target.tokenAddress)!, measurement });
      }
    }
  }

  // Cross-chain skew: pins beyond the allowance cannot form one partition.
  const pinTimes = measurements.map(row => row.measurement.pin.blockTimeSec);
  if (pinTimes.length > 1 && Math.max(...pinTimes) - Math.min(...pinTimes) > SUPPLY_POLICY.observationMaxSkewSec) {
    for (const row of measurements) rejected.push(rejection(row.target.routeId, "cross-chain-skew"));
    return {
      rows: [],
      rejected: [...rejected].sort((left, right) =>
        compareCodeUnits(left.routeId ?? "", right.routeId ?? "") ||
        compareCodeUnits(left.code, right.code)),
    };
  }

  interface PricedRow {
    target: DeploymentSupplyCensusReadTarget;
    tokenAddress: string;
    row: V9DeploymentSupplyCensusRow;
  }
  const priced: PricedRow[] = [];
  for (const { target, tokenAddress, measurement } of measurements) {
    const price = input.referencePrices.get(target.routeId) ?? null;
    if (price === null || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) {
      rejected.push(rejection(target.routeId, "reference-price-unavailable"));
      continue;
    }
    const priceAgeSec = scoringClockSec - price.observedAtSec;
    if (priceAgeSec < 0) {
      rejected.push(rejection(target.routeId, "future-dated-pin"));
      continue;
    }
    if (priceAgeSec > SUPPLY_POLICY.observationMaxAgeSec) {
      rejected.push(rejection(target.routeId, "reference-price-unavailable"));
      continue;
    }
    const supplyUsdUpper = totalSupplyUsdUpper(
      BigInt(measurement.totalSupplyRaw), measurement.decimals, price.priceUsd,
    );
    if (supplyUsdUpper === null) {
      rejected.push(rejection(target.routeId, "read-unavailable"));
      continue;
    }
    priced.push({
      target,
      tokenAddress,
      row: {
        routeId: target.routeId,
        chainId: target.chainId,
        tokenAddress,
        readKind: "evm-total-supply",
        pin: measurement.pin,
        decimals: measurement.decimals,
        totalSupplyRaw: measurement.totalSupplyRaw,
        referencePriceUsd: price.priceUsd,
        referencePriceObservedAtSec: price.observedAtSec,
        supplyUsdUpper,
        shareUpper: supplyUsdUpper / input.aggregateSupplyUsd,
        evidenceKind: "upper-bound",
      },
    });
  }

  // Tier 0: a chain's measured partition cannot exceed its supplied bound.
  const measuredUsdByChainId = new Map<string, number>();
  for (const { row } of priced) {
    measuredUsdByChainId.set(row.chainId, (measuredUsdByChainId.get(row.chainId) ?? 0) + row.supplyUsdUpper);
  }
  const breachedChainIds = new Set<string>();
  for (const [chainId, measuredUsd] of measuredUsdByChainId) {
    const chainBoundUsd = input.chainSupplyUsdByChainId.get(chainId);
    if (chainBoundUsd === undefined || !Number.isFinite(chainBoundUsd) || chainBoundUsd < 0) continue;
    const ceilingUsd = chainBoundUsd * (1 + SUPPLY_POLICY.conservationRelativeTolerance) +
      SUPPLY_POLICY.conservationAbsoluteToleranceUsd;
    if (measuredUsd > ceilingUsd) breachedChainIds.add(chainId);
  }

  const rows: V9DeploymentSupplyCensusRow[] = [];
  for (const { target, row } of priced) {
    if (breachedChainIds.has(row.chainId)) {
      // The contradiction is chain-wide: no deployment on it can be admitted.
      rejected.push(rejection(target.routeId, "conservation-breach"));
      continue;
    }
    rows.push(row);
  }
  return {
    rows: rows.sort((left, right) => compareCodeUnits(left.routeId, right.routeId)),
    rejected: rejected.sort((left, right) =>
      compareCodeUnits(left.routeId ?? "", right.routeId ?? "") ||
      compareCodeUnits(left.code, right.code)),
  };
}
