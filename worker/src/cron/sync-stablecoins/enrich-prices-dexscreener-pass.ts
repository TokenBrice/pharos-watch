import { DS_CHAIN_MAP, resolveChainId } from "@shared/lib/chains";
import { median } from "@shared/lib/stats";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { CIRCUIT_SOURCE, DEXSCREENER_MIN_LIQUIDITY_USD } from "../../lib/constants";
import {
  isProviderCircuitAllowed,
  recoverProviderOnNoCandidates,
  recordProviderOutcomeSafe,
} from "../../lib/pricing-provider-lifecycle";
import { fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd, dsRateLimit } from "../../lib/dexscreener";
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

const DEXSCREENER_MAX_REQUESTS = 10;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;
const DEXSCREENER_ROTATION_INTERVAL_MS = 15 * 60 * 1_000;

interface DexScreenerTarget {
  chain: string;
  address: string;
  expectedSymbol?: string;
}

function rotateValues<T>(values: readonly T[], offset: number): T[] {
  if (values.length <= 1) return [...values];
  const normalizedOffset = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(normalizedOffset), ...values.slice(0, normalizedOffset)];
}

function stableStringHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
): Promise<EnrichPassResult> {
  let resolved = 0;
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];

  const stillMissing = collectMissingPriceCandidates(assets);
  if (stillMissing.length === 0) {
    return { resolved, failures: [] };
  }

  if (stillMissing.length > DEXSCREENER_MAX_REQUESTS) {
    console.warn(
      `[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_REQUESTS} requests`,
    );
  }

  const rotationCycle = Math.floor(Date.now() / DEXSCREENER_ROTATION_INTERVAL_MS);
  const rankedDexCandidates = [...stillMissing]
    .map((entry) => {
      const exactTargets = rotateValues(
        buildDexScreenerTargets(entry.asset),
        stableStringHash(entry.asset.id) + rotationCycle,
      );
      return {
        ...entry,
        exactTargets,
      };
    })
    .sort((left, right) => {
      const leftCirculating = sumCirculatingValue(left.asset);
      const rightCirculating = sumCirculatingValue(right.asset);
      if (rightCirculating !== leftCirculating) {
        return rightCirculating - leftCirculating;
      }

      return left.asset.id.localeCompare(right.asset.id);
    });
  const candidateRotation =
    rankedDexCandidates.length > DEXSCREENER_MAX_REQUESTS
      ? (rotationCycle * DEXSCREENER_MAX_REQUESTS) % rankedDexCandidates.length
      : 0;
  const dexCandidates = rotateValues(rankedDexCandidates, candidateRotation);

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
    const dexBudgetDeadlineMs = Date.now() + DEXSCREENER_PASS_BUDGET_MS;
    const resolvedAssetIds = new Set<string>();
    const maxTargetCount = Math.max(...dexCandidates.map((entry) => entry.exactTargets.length));

    requestRounds: for (let targetIndex = 0; targetIndex < maxTargetCount; targetIndex += 1) {
      for (const entry of dexCandidates) {
        if (resolvedAssetIds.has(entry.asset.id)) continue;
        const target = entry.exactTargets[targetIndex];
        if (!target) continue;
        if (dexExactAttempts >= DEXSCREENER_MAX_REQUESTS) break requestRounds;

        const exactRemainingBudgetMs = dexBudgetDeadlineMs - Date.now();
        if (exactRemainingBudgetMs <= 0) {
          console.warn(
            `[enrich] DexScreener pass budget exhausted after ${dexExactAttempts}/${DEXSCREENER_MAX_REQUESTS} requests`,
          );
          break requestRounds;
        }

        if (dexExactAttempts > 0) {
          await dsRateLimit(signal);
        }

        dexExactAttempts += 1;
        const pushExactFailure = (errorClass: string, errorMessage: string, status: number | null = null) => {
          diagnostics.push({
            source: "dexscreener-exact",
            stage: "fallback",
            endpoint: endpointLabel(`https://api.dexscreener.com/tokens/v1/${target.chain}/${target.address}`),
            status,
            ok: false,
            success: false,
            candidateCount: 1,
            errorClass,
            errorMessage,
          });
        };

        let lookupResult: Awaited<ReturnType<typeof fetchDsTokenPoolsWithStatus>>;
        try {
          lookupResult = await fetchDsTokenPoolsWithStatus(
            target.chain,
            target.address,
            signal,
            Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, exactRemainingBudgetMs),
            DEXSCREENER_MAX_RETRIES,
          );
        } catch (error) {
          if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
          console.warn(
            `[enrich] DexScreener exact lookup threw for ${entry.asset.symbol} (${target.chain}:${target.address}):`,
            error,
          );
          pushExactFailure(errorClassFor(error), errorMessageFor(error));
          continue;
        }

        const { ok, pairs } = lookupResult;
        if (ok) {
          dexExactSuccessfulCalls += 1;
        } else {
          console.warn(
            `[enrich] DexScreener exact lookup failed for ${entry.asset.symbol} (${target.chain}:${target.address})`,
          );
          pushExactFailure(
            "upstream-error",
            lookupResult.error
              ? `DexScreener exact lookup returned no usable response: ${lookupResult.error}`
              : "DexScreener exact lookup returned no usable response",
            lookupResult.status ?? null,
          );
        }

        const exactPrice = resolveDexScreenerAddressPrice(entry.asset, target, pairs, fxRates);
        if (exactPrice == null) continue;

        applyResolvedPrice(assets[entry.index], exactPrice, "dexscreener-exact", "fallback");
        resolved += 1;
        resolvedAssetIds.add(entry.asset.id);
      }
    }

    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      attempted: dexExactAttempts,
      successful: dexExactSuccessfulCalls,
    });
    console.log(`[enrich] DexScreener pass: exact=${dexExactSuccessfulCalls}/${dexExactAttempts} resolved=${resolved}`);
  } else {
    console.warn("[enrich] DexScreener exact circuit open — skipping pass 4");
  }

  return { resolved, failures: [], diagnostics };
}
