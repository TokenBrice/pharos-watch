import {
  CG_CHAIN_MAP,
  resolveChainId,
} from "@shared/lib/chains";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getCirculatingRaw } from "@shared/lib/supply";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import type { PricingProviderDiagnosticSource } from "../pricing-provider-diagnostics";
import { createPricingAssetAttempt } from "../pricing-provider-diagnostics";
import {
  buildBlockedProviderDiagnostic,
  buildNoCandidatesDiagnostic,
} from "../pricing-provider-lifecycle";
import { runCoingeckoOnchainAddressProvider } from "./coingecko-onchain";
import {
  ADDRESS_PROVIDER_RUN_BUDGET_MS,
  hasValue,
  normalizeAddressForKey,
} from "./shared";
import { applyReviewedAddressPriceTargetOverride } from "./reviewed-target-overrides";
import type {
  AddressPriceAssetLike,
  AddressPriceProviderCollectionResult,
  AddressPriceProviderKey,
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceQuote,
  AddressPriceTarget,
} from "./types";
import { ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS } from "../stablecoin-publication-coverage";

export type {
  AddressPriceAssetLike,
  AddressPriceProviderCollectionResult,
  AddressPriceProviderKey,
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceQuote,
  AddressPriceTarget,
} from "./types";

const COINGECKO_ONCHAIN_PROVIDER = "coingecko-onchain-address" as const;

const NEXT_PRICE_GENERATION_SEC = 15 * 60;

/**
 * `corroboration` is the hourly cohort: every asset missing a price or short of
 * three consensus sources, so thin coverage is discovered.
 *
 * `coverage-refresh` is the 15-minute cohort: only rows this lane already
 * prices plus rows with no price at all. An exact-address quote lives for one
 * publication window (`maxTrustedAgeSec` of `coingecko-onchain-address`) and is
 * never replayable from `price_cache`, so a row it prices must be re-observed
 * every generation or it drops to no price. Rows with a fresh price from any
 * other lane are left to the hourly pass instead of spending the request cap.
 */
export type AddressPriceTargetCohort = "corroboration" | "coverage-refresh";

export function resolveEnabledAddressPriceProviders(
  config?: AddressPriceProviderRuntimeConfig,
): AddressPriceProviderKey[] {
  if (!config) return [];

  const configured = config.enabledProviders?.trim();
  if (configured && ["none", "off", "false", "0"].includes(configured.toLowerCase())) {
    return [];
  }

  if (!configured || !hasValue(config.cgApiKey)) return [];
  return configured.split(",").some((part) => part.trim() === COINGECKO_ONCHAIN_PROVIDER)
    ? [COINGECKO_ONCHAIN_PROVIDER]
    : [];
}

function readStringHint(asset: AddressPriceAssetLike | undefined, key: "priceConfidence" | "priceSource"): string | null {
  const value = asset?.[key];
  return typeof value === "string" ? value : null;
}

function expiresBeforeNextGeneration(asset: AddressPriceAssetLike | undefined, nowSec: number): boolean {
  if (!asset?.priceSource) return false;
  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) return false;
  const entries = normalizePricingSourceKeys(asset.priceSource)
    .map((source) => getPricingSourceRegistryEntry(source));
  if (entries.length === 0 || entries.some((entry) => entry == null)) return false;
  const maxAges = entries
    .map((entry) => entry?.maxTrustedAgeSec)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (maxAges.length !== entries.length) return false;
  const expiresAt = Math.floor(observedAt) + Math.min(...maxAges);
  return expiresAt > nowSec && expiresAt <= nowSec + NEXT_PRICE_GENERATION_SEC;
}

function shouldTargetAsset(
  asset: AddressPriceAssetLike,
  previousAssetsById: Map<string, AddressPriceAssetLike> | undefined,
  previousMissingGenerationsById: ReadonlyMap<string, number> | undefined,
  nowSec: number,
  cohort: AddressPriceTargetCohort,
): {
  previousSourceDepth: number;
  previousMissingGenerations: number;
  alertEligibleMissingPrice: boolean;
  recentlyMissingPrice: boolean;
  expiresBeforeNextGeneration: boolean;
  lowConfidencePrice: boolean;
  missingPrice: boolean;
  addressLaneOwned: boolean;
  include: boolean;
} {
  const previous = previousAssetsById?.get(asset.id);
  const previousSourceDepth = previous?.consensusSources?.length ?? asset.consensusSources?.length ?? 0;
  const missingPrice = !hasPublishableCurrentPrice(asset);
  const previousMissingGenerations = previousMissingGenerationsById?.get(asset.id) ?? 0;
  const projectedMissingGenerations = missingPrice ? previousMissingGenerations + 1 : previousMissingGenerations;
  const alertEligibleMissingPrice =
    projectedMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS &&
    (missingPrice || previousMissingGenerations > 0);
  const recentlyMissingPrice = previousMissingGenerations > 0;
  const priceConfidence = readStringHint(asset, "priceConfidence") ?? readStringHint(previous, "priceConfidence");
  const priceSource = readStringHint(asset, "priceSource") ?? readStringHint(previous, "priceSource");
  const lowConfidencePrice =
    priceConfidence === "fallback" ||
    priceConfidence === "low" ||
    priceSource === "cached" ||
    priceSource === "coingecko-low-volume";
  const expiring = expiresBeforeNextGeneration(previous ?? asset, nowSec);
  const addressLaneOwned = normalizePricingSourceKeys(priceSource ?? "").includes(COINGECKO_ONCHAIN_PROVIDER);
  return {
    previousSourceDepth,
    previousMissingGenerations,
    alertEligibleMissingPrice,
    recentlyMissingPrice,
    expiresBeforeNextGeneration: expiring,
    lowConfidencePrice,
    missingPrice,
    addressLaneOwned,
    // `expiring` is deliberately not an inclusion reason on its own: thin
    // coverage is already captured by `previousSourceDepth < 3`, so an
    // expiring-only rule would re-target deep high-confidence majors every run
    // (their labels carry short-window oracle members), wasting the request cap
    // and appending a non-replay-safe lane to their consensus provenance.
    // `expiring` still orders cohorts among assets included for other reasons.
    include: cohort === "coverage-refresh"
      // Rows this lane already prices cannot survive a generation without a
      // re-read, and rows with no price at all need a first quote before they
      // can ever be corroborated. Everything else stays on the hourly cohort.
      ? missingPrice || addressLaneOwned
      : !previousAssetsById ||
        previousSourceDepth < 3 ||
        missingPrice ||
        recentlyMissingPrice ||
        lowConfidencePrice,
  };
}

/**
 * Last-resort chain guess for an asset whose `address` carries no `chain:` prefix
 * AND whose `chains` array is empty. Reachable only for assets with neither a
 * structured deployment nor an ACTIVE_META contracts entry. Bare `0x` addresses
 * are undecidable because they could be Ethereum or any EVM chain, so they are
 * skipped unless metadata supplies a chain. Non-`0x` addresses are treated as
 * Solana base58 addresses for the legacy fallback path.
 */
export function resolveFallbackChain(rawAddress: string): "solana" | null {
  return rawAddress.startsWith("0x") ? null : "solana";
}

function addAssetAddressDeployments(asset: AddressPriceAssetLike): Array<{
  chain: string;
  address: string;
  origin: AddressPriceTarget["origin"];
  decimals?: number;
}> {
  const deployments: Array<{
    chain: string;
    address: string;
    origin: AddressPriceTarget["origin"];
    decimals?: number;
  }> = [];
  const rawAddress = asset.address?.trim();
  if (!rawAddress) return deployments;

  if (rawAddress.includes(":")) {
    const [rawChain, ...rest] = rawAddress.split(":");
    deployments.push({
      chain: rawChain,
      address: rest.join(":").trim(),
      origin: "asset.address",
    });
    return deployments;
  }

  for (const chain of asset.chains ?? []) {
    deployments.push({ chain, address: rawAddress, origin: "asset.address" });
  }
  if (deployments.length === 0) {
    const fallbackChain = resolveFallbackChain(rawAddress);
    if (fallbackChain) {
      deployments.push({
        chain: fallbackChain,
        address: rawAddress,
        origin: "asset.address",
      });
    }
  }
  return deployments;
}

function buildAssetDeployments(asset: AddressPriceAssetLike): Array<{
  chain: string;
  address: string;
  origin: AddressPriceTarget["origin"];
  decimals?: number;
}> {
  const meta = ACTIVE_META_BY_ID.get(asset.id);
  return [
    ...addAssetAddressDeployments(asset),
    ...(meta?.contracts ?? []).map((deployment) => ({ ...deployment, origin: "contracts" as const })),
    ...(meta?.tradedContracts ?? []).map((deployment) => ({ ...deployment, origin: "tradedContracts" as const })),
  ];
}

function compareAddressPriceTargets(
  left: AddressPriceTarget,
  right: AddressPriceTarget,
  laneOwnedIds: ReadonlySet<string>,
): number {
  // In the coverage-refresh cohort, a row this lane prices has a quote that
  // lapses at the next publication while a merely-missing row has none to
  // lose. Rank the lane's own rows first so the bounded request cap refreshes
  // what is about to disappear before it re-discovers anything.
  const leftOwned = laneOwnedIds.has(left.stablecoinId);
  const rightOwned = laneOwnedIds.has(right.stablecoinId);
  if (leftOwned !== rightOwned) return leftOwned ? -1 : 1;
  if (left.alertEligibleMissingPrice !== right.alertEligibleMissingPrice) {
    return left.alertEligibleMissingPrice ? -1 : 1;
  }
  if (left.missingPrice !== right.missingPrice) return left.missingPrice ? -1 : 1;
  if (left.recentlyMissingPrice !== right.recentlyMissingPrice) {
    return left.recentlyMissingPrice ? -1 : 1;
  }
  if (left.expiresBeforeNextGeneration !== right.expiresBeforeNextGeneration) {
    return left.expiresBeforeNextGeneration ? -1 : 1;
  }
  const leftLowDepth = left.previousSourceDepth <= 2;
  const rightLowDepth = right.previousSourceDepth <= 2;
  if (leftLowDepth !== rightLowDepth) return leftLowDepth ? -1 : 1;
  if (left.previousMissingGenerations !== right.previousMissingGenerations) {
    return right.previousMissingGenerations - left.previousMissingGenerations;
  }
  if (left.circulatingUsd !== right.circulatingUsd) return right.circulatingUsd - left.circulatingUsd;
  if (left.previousSourceDepth !== right.previousSourceDepth) {
    return left.previousSourceDepth - right.previousSourceDepth;
  }
  return `${left.stablecoinId}:${left.chain}:${left.address}`.localeCompare(`${right.stablecoinId}:${right.chain}:${right.address}`);
}

export function buildAddressPriceTargetsByProvider(params: {
  assets: AddressPriceAssetLike[];
  previousAssetsById?: Map<string, AddressPriceAssetLike>;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  providers: readonly AddressPriceProviderKey[];
  nowSec?: number;
  cohort?: AddressPriceTargetCohort;
  /**
   * Deployment hints from the last successful read, keyed by stablecoin. A
   * hint only narrows a row to a deployment the canonical metadata still
   * lists; an unknown or stale hint falls back to the reviewed deployment set
   * so routing state can never invent a target.
   */
  deploymentHints?: ReadonlyMap<string, { chain: string; address: string }>;
}): Map<AddressPriceProviderKey, AddressPriceTarget[]> {
  const result = new Map<AddressPriceProviderKey, AddressPriceTarget[]>();
  if (!params.providers.includes(COINGECKO_ONCHAIN_PROVIDER)) return result;

  const provider = COINGECKO_ONCHAIN_PROVIDER;
  const chainMap = CG_CHAIN_MAP;
  const targets: AddressPriceTarget[] = [];
  const seen = new Set<string>();
  const laneOwnedIds = new Set<string>();

  for (const asset of params.assets) {
    const targeting = shouldTargetAsset(
      asset,
      params.previousAssetsById,
      params.previousMissingGenerationsById,
      params.nowSec ?? Math.floor(Date.now() / 1000),
      params.cohort ?? "corroboration",
    );
    if (!targeting.include) continue;

    const meta = ACTIVE_META_BY_ID.get(asset.id);
    const metadataDeployments = [
      ...(meta?.contracts ?? []),
      ...(meta?.tradedContracts ?? []),
    ];
    const deployments = applyReviewedAddressPriceTargetOverride({
      provider,
      stablecoinId: asset.id,
      deployments: buildAssetDeployments(asset),
      metadataDeployments,
      providerChainMap: chainMap,
    });
    if (params.cohort === "coverage-refresh" && targeting.addressLaneOwned) laneOwnedIds.add(asset.id);
    const hint = params.deploymentHints?.get(asset.id);
    const hintedDeployments = hint
      ? deployments.filter((deployment) =>
          resolveChainId(deployment.chain) === hint.chain &&
          normalizeAddressForKey(deployment.address) === hint.address)
      : [];
    const selectedDeployments = hintedDeployments.length > 0 ? hintedDeployments : deployments;

    for (const deployment of selectedDeployments) {
      const chain = resolveChainId(deployment.chain);
      if (!chain) continue;
      const providerChainId = chainMap[chain];
      if (!providerChainId) continue;
      const address = normalizeAddressForKey(deployment.address);
      if (!address) continue;
      const key = `${asset.id}:${chain}:${address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        stablecoinId: asset.id,
        symbol: asset.symbol,
        chain,
        providerChainId,
        address,
        decimals: deployment.decimals,
        origin: deployment.origin,
        previousSourceDepth: targeting.previousSourceDepth,
        previousMissingGenerations: targeting.previousMissingGenerations,
        alertEligibleMissingPrice: targeting.alertEligibleMissingPrice,
        recentlyMissingPrice: targeting.recentlyMissingPrice,
        missingPrice: targeting.missingPrice,
        expiresBeforeNextGeneration: targeting.expiresBeforeNextGeneration,
        circulatingUsd: getCirculatingRaw(asset),
      });
    }
  }

  targets.sort((left, right) => compareAddressPriceTargets(left, right, laneOwnedIds));
  result.set(provider, targets);
  return result;
}

async function runAddressProvider(params: {
  targets: AddressPriceTarget[];
  config: AddressPriceProviderRuntimeConfig;
  signal?: AbortSignal;
  nowSec: number;
  deadlineMs: number;
}): Promise<AddressPriceProviderRunResult> {
  return runCoingeckoOnchainAddressProvider(
    params.targets,
    params.config.cgApiKey ?? null,
    params.signal,
    params.nowSec,
    params.deadlineMs,
  );
}

export async function collectAddressPriceProviderQuotes(params: {
  targetsByProvider: Map<AddressPriceProviderKey, AddressPriceTarget[]>;
  providers: readonly AddressPriceProviderKey[];
  sourceAllowed: Record<AddressPriceProviderKey, boolean>;
  config: AddressPriceProviderRuntimeConfig;
  signal?: AbortSignal;
  nowSec: number;
  /** Lane budget for this call. Slot-scoped callers pass a bounded window so a
   * slow provider cannot consume the next publication's budget. */
  budgetMs?: number;
}): Promise<AddressPriceProviderCollectionResult> {
  const quotesByStablecoinId = new Map<string, AddressPriceQuote[]>();
  const diagnostics: AddressPriceProviderCollectionResult["diagnostics"] = [];
  const providerOutcomes: AddressPriceProviderCollectionResult["providerOutcomes"] = new Map();
  const deadlineMs = Date.now() + (params.budgetMs ?? ADDRESS_PROVIDER_RUN_BUDGET_MS);
  const provider = COINGECKO_ONCHAIN_PROVIDER;

  if (params.providers.includes(provider)) {
    throwIfAborted(params.signal);
    const targets = params.targetsByProvider.get(provider) ?? [];
    if (targets.length === 0) {
      providerOutcomes.set(provider, "success");
      diagnostics.push(buildNoCandidatesDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "no-candidates",
        endpoint: provider,
      }));
      return { quotesByStablecoinId, diagnostics, providerOutcomes, attemptedRequests: 0, successfulRequests: 0 };
    }

    if (!params.sourceAllowed[provider]) {
      providerOutcomes.set(provider, "neutral");
      const diagnostic = buildBlockedProviderDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "primary",
        endpoint: provider,
        candidateCount: targets.length,
      }, `${provider} circuit open`);
      diagnostic.assetAttempts = targets.slice(0, 100).map((target) => createPricingAssetAttempt({
        assetId: target.stablecoinId,
        adapter: provider,
        chain: target.chain,
        target: target.address,
        state: "skipped",
        skipReason: "circuit-open",
        rejectionClass: "blocked",
        candidateAt: params.nowSec,
      }));
      diagnostics.push(diagnostic);
      return { quotesByStablecoinId, diagnostics, providerOutcomes, attemptedRequests: 0, successfulRequests: 0 };
    }

    const result = await runAddressProvider({
      targets,
      config: params.config,
      signal: params.signal,
      nowSec: params.nowSec,
      deadlineMs,
    });
    diagnostics.push(...result.diagnostics);
    // A 404 is the provider's definitive "this deployment is not indexed"
    // answer, not an outage. Counting it as a failure would let a cohort made
    // mostly of unindexed deployments open the circuit on healthy traffic.
    const failedRequests = result.diagnostics
      .filter((diagnostic) => !diagnostic.success && diagnostic.status !== 404);
    providerOutcomes.set(
      provider,
      result.attemptedRequests === 0
        ? "neutral"
        : result.successfulRequests > 0 || failedRequests.length === 0
          ? "success"
          : "failure",
    );
    for (const quote of result.quotes) {
      const list = quotesByStablecoinId.get(quote.stablecoinId) ?? [];
      list.push(quote);
      quotesByStablecoinId.set(quote.stablecoinId, list);
    }
    return { quotesByStablecoinId, diagnostics, providerOutcomes,
      attemptedRequests: result.attemptedRequests, successfulRequests: result.successfulRequests };
  }

  return { quotesByStablecoinId, diagnostics, providerOutcomes, attemptedRequests: 0, successfulRequests: 0 };
}
