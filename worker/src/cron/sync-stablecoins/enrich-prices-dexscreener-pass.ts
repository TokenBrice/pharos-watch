import { DS_CHAIN_MAP, resolveChainId } from "@shared/lib/chains";
import { median } from "@shared/lib/stats";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { abortError, throwIfAborted } from "../../lib/abort";
import { CIRCUIT_SOURCE, DEXSCREENER_MIN_LIQUIDITY_USD } from "../../lib/constants";
import {
  isProviderCircuitAllowed,
  recoverProviderOnNoCandidates,
  recordProviderOutcomeSafe,
} from "../../lib/pricing-provider-lifecycle";
import { fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd } from "../../lib/dexscreener";
import { applyResolvedPrice, type PeggedAsset } from "./enrich-prices-shared";
import {
  collectMissingPriceCandidates,
  type EnrichPassResult,
  isUsableFallbackPrice,
  sumCirculatingValue,
} from "./enrich-prices-pass-common";
import {
  endpointLabel,
  errorClassFor,
  errorMessageFor,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import { logWorkerEvent } from "../../lib/structured-log";

const DEXSCREENER_BATCH_SIZE = 30;
const DEXSCREENER_MAX_REQUESTS = 1;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;
const DEXSCREENER_ROTATION_INTERVAL_MS = 15 * 60 * 1_000;
const DEXSCREENER_PASS_TIMEOUT_ERROR = new DOMException(
  `DexScreener pass timed out after ${DEXSCREENER_PASS_BUDGET_MS}ms`,
  "TimeoutError",
);

interface DexScreenerTarget {
  chain: string;
  address: string;
  expectedSymbol?: string;
}

interface RankedDexScreenerCandidate {
  asset: PeggedAsset;
  index: number;
  exactTargets: DexScreenerTarget[];
  missingGenerations: number;
}

interface DexScreenerBatchTarget {
  entry: RankedDexScreenerCandidate;
  target: DexScreenerTarget;
}

function rotateValues<T>(values: readonly T[], offset: number): T[] {
  if (values.length <= 1) return [...values];
  const normalizedOffset = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(normalizedOffset), ...values.slice(0, normalizedOffset)];
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const ADDRESS_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
};

function resolveDexTargetChain(rawChain: string): string | null {
  const normalized = rawChain.trim().toLowerCase();
  return resolveChainId(ADDRESS_CHAIN_ALIASES[normalized] ?? normalized);
}

function buildDexScreenerTargets(asset: PeggedAsset): DexScreenerTarget[] {
  const rawAddress = asset.address?.trim();

  const targets: DexScreenerTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (chain: string | null, address: string, expectedSymbol?: string) => {
    if (!chain || !DS_CHAIN_MAP[chain]) return;
    const trimmedAddress = address.trim();
    const normalizedAddress = trimmedAddress.startsWith("0x") ? trimmedAddress.toLowerCase() : trimmedAddress;
    if (!normalizedAddress) return;
    const normalizedExpectedSymbol = expectedSymbol?.trim();
    const key = `${chain}:${normalizedAddress}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({
      chain,
      address: normalizedAddress,
      ...(normalizedExpectedSymbol ? { expectedSymbol: normalizedExpectedSymbol } : {}),
    });
  };

  if (rawAddress?.includes(":")) {
    const [rawChain, ...rest] = rawAddress.split(":");
    pushTarget(resolveDexTargetChain(rawChain), rest.join(":").trim());
    return targets;
  }

  if (rawAddress) {
    for (const rawChain of asset.chains ?? []) {
      pushTarget(resolveChainId(rawChain), rawAddress);
    }

    if (targets.length === 0) {
      pushTarget(rawAddress.startsWith("0x") ? "ethereum" : "solana", rawAddress);
    }
    return targets;
  }

  const meta = ACTIVE_META_BY_ID.get(String(asset.id));
  const deployments = [...(meta?.contracts ?? []), ...(meta?.tradedContracts ?? [])];
  for (const deployment of deployments) {
    const address = deployment.address?.trim();
    if (!address) continue;
    pushTarget(resolveChainId(deployment.chain), address, asset.symbol);
  }

  return targets;
}

function selectDexScreenerBatch(
  candidates: RankedDexScreenerCandidate[],
  rotationCycle: number,
): DexScreenerBatchTarget[] {
  const targetsByChain = new Map<string, DexScreenerBatchTarget[]>();
  const maxTargetCount = Math.max(...candidates.map((entry) => entry.exactTargets.length));

  // Preserve the existing deployment-round ordering inside each chain: every
  // asset's first deployment is considered before any second deployment.
  for (let targetIndex = 0; targetIndex < maxTargetCount; targetIndex += 1) {
    for (const entry of candidates) {
      const target = entry.exactTargets[targetIndex];
      if (!target) continue;
      const chainTargets = targetsByChain.get(target.chain) ?? [];
      chainTargets.push({ entry, target });
      targetsByChain.set(target.chain, chainTargets);
    }
  }

  const chainGroups = [...targetsByChain.entries()]
    .sort(([leftChain], [rightChain]) => leftChain.localeCompare(rightChain))
    .map(([, targets]) => targets);
  if (chainGroups.length === 0) return [];

  // DexScreener batches cannot cross chains. Rotate the selected chain each
  // quarter-hour, then rotate within that chain on later visits so a persistent
  // gap on one network cannot starve candidates on another.
  const chainIndex = ((rotationCycle % chainGroups.length) + chainGroups.length) % chainGroups.length;
  const chainTargets = chainGroups[chainIndex];
  const chainVisit = Math.floor(rotationCycle / chainGroups.length);
  const targetOffset =
    chainTargets.length > DEXSCREENER_BATCH_SIZE
      ? (chainVisit * DEXSCREENER_BATCH_SIZE) % chainTargets.length
      : 0;
  return rotateValues(chainTargets, targetOffset).slice(0, DEXSCREENER_BATCH_SIZE);
}

function getDexPairTrackedTokenSymbol(
  pair: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>["pairs"][number],
  trackedAddress: string,
): string | null {
  const tracked = trackedAddress.toLowerCase();
  if (pair.baseToken.address.toLowerCase() === tracked) return pair.baseToken.symbol;
  if (pair.quoteToken.address.toLowerCase() === tracked) return pair.quoteToken.symbol;
  return null;
}

function resolveDexScreenerAddressPrice(
  asset: PeggedAsset,
  target: DexScreenerTarget,
  pairs: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>["pairs"],
  fxRates: Record<string, number> | undefined,
): number | null {
  const prices = pairs
    .map((pair) => {
      const tvl = pair.liquidity?.usd ?? 0;
      if (tvl < DEXSCREENER_MIN_LIQUIDITY_USD) return null;
      if (
        target.expectedSymbol &&
        getDexPairTrackedTokenSymbol(pair, target.address)?.toUpperCase() !== target.expectedSymbol.toUpperCase()
      ) {
        return null;
      }
      return getDsTrackedTokenPriceUsd(pair, target.address).priceUsd;
    })
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0);

  const price = median(prices);
  if (price == null) return null;

  return isUsableFallbackPrice(asset, price, fxRates) ? price : null;
}

export async function runDexScreenerPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
  previousMissingGenerationsById?: ReadonlyMap<string, number>,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];

  const stillMissing = collectMissingPriceCandidates(assets);
  if (stillMissing.length === 0) {
    return { resolved, failures: [] };
  }

  if (stillMissing.length > DEXSCREENER_BATCH_SIZE) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "dexscreener-targets-capped",
      message: "Assets still missing prices; capping DexScreener to one address batch",
      provider: "dexscreener",
      metadata: { missingAssetCount: stillMissing.length, batchSize: DEXSCREENER_BATCH_SIZE },
    });
  }

  // Priority order: assets that have gone unpriced across the most prior
  // generations first (so a persistent gap never starves under the request
  // cap), then the existing circulating-desc + id tiebreak.
  const rankedDexCandidates: RankedDexScreenerCandidate[] = [...stillMissing]
    .map((entry) => ({
      ...entry,
      exactTargets: buildDexScreenerTargets(entry.asset),
      missingGenerations: previousMissingGenerationsById?.get(entry.asset.id) ?? 0,
    }))
    .sort((left, right) => {
      if (right.missingGenerations !== left.missingGenerations) {
        return right.missingGenerations - left.missingGenerations;
      }

      const leftCirculating = sumCirculatingValue(left.asset);
      const rightCirculating = sumCirculatingValue(right.asset);
      if (rightCirculating !== leftCirculating) {
        return rightCirculating - leftCirculating;
      }

      return left.asset.id.localeCompare(right.asset.id);
    });

  const rotationCycle = Math.floor(Date.now() / DEXSCREENER_ROTATION_INTERVAL_MS);
  const dexCandidates = rankedDexCandidates;

  const exactCandidateCount = dexCandidates.filter((entry) => entry.exactTargets.length > 0).length;

  if (exactCandidateCount === 0) {
    await recoverProviderOnNoCandidates({
      db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      diagnostic: {
        source: "dexscreener-exact",
        stage: "no-candidates",
        endpoint: "api.dexscreener.com/tokens/v1",
      },
      diagnostics,
    });
    return diagnostics.length > 0 ? { resolved, failures: [], diagnostics } : { resolved, failures: [] };
  }

  const dexscreenerAllowed = await isProviderCircuitAllowed({
    db,
    circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
    diagnostic: {
      source: "dexscreener-exact",
      stage: "fallback",
      endpoint: "api.dexscreener.com/tokens/v1",
      candidateCount: exactCandidateCount,
    },
    diagnostics,
    errorMessage: "DexScreener exact circuit open",
  });
  let dexExactAttempts = 0;
  let dexExactSuccessfulCalls = 0;

  if (dexscreenerAllowed) {
    const passTimeout = createTimeoutSignal({
      timeoutMs: DEXSCREENER_PASS_BUDGET_MS,
      timeoutReason: DEXSCREENER_PASS_TIMEOUT_ERROR,
      parentSignal: signal,
    });
    const dexBudgetDeadlineMs = Date.now() + DEXSCREENER_PASS_BUDGET_MS;
    const batch = selectDexScreenerBatch(dexCandidates, rotationCycle);

    try {
      throwIfAborted(passTimeout.signal);
      const exactRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
      if (batch.length > 0 && exactRemainingBudgetMs > 0) {
        const batchChain = batch[0].target.chain;
        const batchAddressPath = batch.map(({ target }) => target.address).join(",");
        dexExactAttempts = 1;
        let lookupFailureRecorded = false;
        const pushExactFailure = (errorClass: string, errorMessage: string, status: number | null = null) => {
          lookupFailureRecorded = true;
          diagnostics.push({
            source: "dexscreener-exact",
            stage: "fallback",
            endpoint: endpointLabel(`https://api.dexscreener.com/tokens/v1/${batchChain}/${batchAddressPath}`),
            status,
            ok: false,
            success: false,
            candidateCount: batch.length,
            errorClass,
            errorMessage,
          });
        };

        let lookupResult: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>;
        try {
          const requestTimeout = createTimeoutSignal({
            timeoutMs: Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs),
            timeoutReason: new DOMException(
              `DexScreener exact lookup timed out after ${Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs)}ms`,
              "TimeoutError",
            ),
            parentSignal: passTimeout.signal,
          });
          try {
            lookupResult = await abortable(
              fetchDsTokenPoolsWithStatus(
                batchChain,
                batchAddressPath,
                requestTimeout.signal,
                Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs),
                DEXSCREENER_MAX_RETRIES,
              ),
              requestTimeout.signal,
            );
          } finally {
            requestTimeout.dispose();
          }
        } catch (error) {
          if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
          logWorkerEvent({
            scope: "lib",
            job: "sync-stablecoins",
            level: "warn",
            event: "dexscreener-exact-batch-threw",
            message: "DexScreener exact batch lookup threw",
            provider: "dexscreener",
            metadata: { chain: batchChain, targetCount: batch.length },
            error,
          });
          pushExactFailure(errorClassFor(error), errorMessageFor(error));
          lookupResult = {
            ok: false,
            pairs: [],
            error: errorMessageFor(error),
          };
        }

        const { ok, pairs } = lookupResult;
        if (ok) {
          dexExactSuccessfulCalls = 1;
        } else if (!lookupFailureRecorded) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-stablecoins",
            level: "warn",
            event: "dexscreener-exact-batch-failed",
            message: "DexScreener exact batch lookup failed",
            provider: "dexscreener",
            metadata: { chain: batchChain, targetCount: batch.length },
          });
          pushExactFailure(
            "upstream-error",
            lookupResult.error
              ? `DexScreener exact lookup returned no usable response: ${lookupResult.error}`
              : "DexScreener exact lookup returned no usable response",
            lookupResult.status ?? null,
          );
        }

        if (ok) {
          const resolvedAssetIds = new Set<string>();
          for (const { entry, target } of batch) {
            if (resolvedAssetIds.has(entry.asset.id)) continue;
            const exactPrice = resolveDexScreenerAddressPrice(entry.asset, target, pairs, fxRates);
            if (exactPrice == null) continue;

            applyResolvedPrice(assets[entry.index], exactPrice, "dexscreener-exact", "fallback");
            resolved += 1;
            resolvedAssetIds.add(entry.asset.id);
          }
        }
      } else if (batch.length > 0) {
        logWorkerEvent({
          scope: "lib",
          job: "sync-stablecoins",
          level: "warn",
          event: "dexscreener-pass-budget-exhausted",
          message: "DexScreener pass budget exhausted",
          provider: "dexscreener",
          metadata: { attemptedRequests: dexExactAttempts, maxRequests: DEXSCREENER_MAX_REQUESTS },
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      if (!passTimeout.isTimedOut()) throw error instanceof Error ? error : new Error(String(error));
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoins",
        level: "warn",
        event: "dexscreener-pass-timed-out",
        message: "DexScreener pass timed out",
        provider: "dexscreener",
        metadata: { attemptedRequests: dexExactAttempts, maxRequests: DEXSCREENER_MAX_REQUESTS },
      });
    } finally {
      passTimeout.dispose();
    }

    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      attempted: dexExactAttempts,
      successful: dexExactSuccessfulCalls,
    });
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "info",
      event: "dexscreener-pass-complete",
      message: "DexScreener pass complete",
      provider: "dexscreener",
      metadata: {
        successfulExactCalls: dexExactSuccessfulCalls,
        attemptedExactCalls: dexExactAttempts,
        resolvedAssetCount: resolved,
      },
    });
  } else {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "dexscreener-exact-circuit-open",
      message: "DexScreener exact circuit open; skipping pass 4",
      provider: "dexscreener",
    });
  }

  return { resolved, failures: [], diagnostics };
}
