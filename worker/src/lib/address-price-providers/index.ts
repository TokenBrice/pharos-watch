import {
  ALCHEMY_CHAIN_MAP,
  BIRDEYE_CHAIN_MAP,
  CG_CHAIN_MAP,
  DEXPAPRIKA_CHAIN_MAP,
  DS_CHAIN_MAP,
  MORALIS_CHAIN_MAP,
  resolveChainId,
} from "@shared/lib/chains";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CIRCUIT_SOURCE } from "../constants";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import type { PricingProviderDiagnosticSource } from "../pricing-provider-diagnostics";
import { createPricingAssetAttempt } from "../pricing-provider-diagnostics";
import {
  buildBlockedProviderDiagnostic,
  buildNoCandidatesDiagnostic,
  buildPricingProviderDiagnostic,
} from "../pricing-provider-lifecycle";
import { runAlchemyAddressProvider } from "./alchemy";
import { runBirdeyeAddressProvider } from "./birdeye";
import { runCoingeckoOnchainAddressProvider } from "./coingecko-onchain";
import { runDexPaprikaAddressProvider } from "./dexpaprika";
import { runDexScreenerAddressProvider } from "./dexscreener";
import { runMoralisAddressProvider } from "./moralis";
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
import {
  readProviderTargetCursor,
  rotateTargets,
  writeProviderTargetCursor,
} from "../pricing-provider-runtime-state";
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

const ALL_ADDRESS_PROVIDERS: readonly AddressPriceProviderKey[] = [
  "dexscreener-address",
  "dexpaprika-address",
  "coingecko-onchain-address",
  "alchemy-address",
  "moralis-address",
  "birdeye-address",
];

const NO_KEY_ADDRESS_PROVIDERS = new Set<AddressPriceProviderKey>([
  "dexpaprika-address",
]);

const NEXT_PRICE_GENERATION_SEC = 15 * 60;

export const ADDRESS_PROVIDER_CIRCUIT_SOURCE: Record<AddressPriceProviderKey, string> = {
  "alchemy-address": CIRCUIT_SOURCE.ALCHEMY_PRICES,
  "moralis-address": CIRCUIT_SOURCE.MORALIS_PRICES,
  "dexscreener-address": CIRCUIT_SOURCE.DEXSCREENER_ADDRESS_PRICES,
  "dexpaprika-address": CIRCUIT_SOURCE.DEXPAPRIKA_PRICES,
  "coingecko-onchain-address": CIRCUIT_SOURCE.CG_ONCHAIN,
  "birdeye-address": CIRCUIT_SOURCE.BIRDEYE_PRICES,
};

const PROVIDER_CHAIN_MAPS: Record<AddressPriceProviderKey, Record<string, string>> = {
  "alchemy-address": ALCHEMY_CHAIN_MAP,
  "moralis-address": MORALIS_CHAIN_MAP,
  "dexscreener-address": DS_CHAIN_MAP,
  "dexpaprika-address": DEXPAPRIKA_CHAIN_MAP,
  "coingecko-onchain-address": CG_CHAIN_MAP,
  "birdeye-address": BIRDEYE_CHAIN_MAP,
};

function hasProviderCredential(provider: AddressPriceProviderKey, config: AddressPriceProviderRuntimeConfig): boolean {
  switch (provider) {
    case "alchemy-address":
      return hasValue(config.alchemyApiKey);
    case "moralis-address":
      return hasValue(config.moralisApiKey);
    case "birdeye-address":
      return hasValue(config.birdeyeApiKey);
    case "coingecko-onchain-address":
      return hasValue(config.cgApiKey);
    default:
      return true;
  }
}

function isAddressProviderKey(value: string): value is AddressPriceProviderKey {
  return (ALL_ADDRESS_PROVIDERS as readonly string[]).includes(value);
}

export function resolveEnabledAddressPriceProviders(
  config?: AddressPriceProviderRuntimeConfig,
): AddressPriceProviderKey[] {
  if (!config) return [];

  const configured = config.enabledProviders?.trim();
  if (configured && ["none", "off", "false", "0"].includes(configured.toLowerCase())) {
    return [];
  }

  const requested = configured
    ? configured.split(",").map((part) => part.trim()).filter(Boolean)
    : [
        ...NO_KEY_ADDRESS_PROVIDERS,
        ...(hasValue(config.cgApiKey) ? ["coingecko-onchain-address" as const] : []),
        ...(hasValue(config.alchemyApiKey) ? ["alchemy-address" as const] : []),
        ...(hasValue(config.moralisApiKey) ? ["moralis-address" as const] : []),
        ...(hasValue(config.birdeyeApiKey) ? ["birdeye-address" as const] : []),
      ];

  const seen = new Set<AddressPriceProviderKey>();
  for (const value of requested) {
    if (!isAddressProviderKey(value)) continue;
    if (!hasProviderCredential(value, config)) continue;
    seen.add(value);
  }
  return [...seen];
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
): {
  previousSourceDepth: number;
  previousMissingGenerations: number;
  alertEligibleMissingPrice: boolean;
  recentlyMissingPrice: boolean;
  expiresBeforeNextGeneration: boolean;
  lowConfidencePrice: boolean;
  missingPrice: boolean;
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
  return {
    previousSourceDepth,
    previousMissingGenerations,
    alertEligibleMissingPrice,
    recentlyMissingPrice,
    expiresBeforeNextGeneration: expiring,
    lowConfidencePrice,
    missingPrice,
    // `expiring` is deliberately not an inclusion reason on its own: thin
    // coverage is already captured by `previousSourceDepth < 3`, so an
    // expiring-only rule would re-target deep high-confidence majors every run
    // (their labels carry short-window oracle members), wasting the request cap
    // and appending a non-replay-safe lane to their consensus provenance.
    // `expiring` still orders cohorts among assets included for other reasons.
    include:
      !previousAssetsById ||
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

function compareAddressPriceTargets(left: AddressPriceTarget, right: AddressPriceTarget): number {
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

function getAddressPriceTargetPriority(target: AddressPriceTarget): number {
  if (target.alertEligibleMissingPrice) return 0;
  if (target.missingPrice) return 1;
  if (target.recentlyMissingPrice) return 2;
  if (target.expiresBeforeNextGeneration) return 3;
  if (target.previousSourceDepth <= 2) return 4;
  return 5;
}

export function rotateAddressPriceTargets(
  targets: readonly AddressPriceTarget[],
  cursor: number,
): AddressPriceTarget[] {
  const cohorts = new Map<number, AddressPriceTarget[]>();
  for (const target of targets) {
    const priority = getAddressPriceTargetPriority(target);
    const cohort = cohorts.get(priority) ?? [];
    cohort.push(target);
    cohorts.set(priority, cohort);
  }

  return [...cohorts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, cohort]) => rotateTargets(cohort, cursor));
}

export function resolveAddressProviderCursorAdvance(
  targets: readonly AddressPriceTarget[],
  result: AddressPriceProviderRunResult,
): number {
  if (result.processedTargets) {
    const processedTargets = new Set(result.processedTargets);
    const firstUnprocessedIndex = targets.findIndex((target) => !processedTargets.has(target));
    return Math.max(1, firstUnprocessedIndex === -1 ? targets.length : firstUnprocessedIndex);
  }
  const capSkipped = result.diagnostics
    .filter((diagnostic) => diagnostic.errorClass === "cap")
    .reduce((sum, diagnostic) => sum + (diagnostic.candidateCount ?? 0), 0);
  return Math.max(1, targets.length - capSkipped);
}

export function buildAddressPriceTargetsByProvider(params: {
  assets: AddressPriceAssetLike[];
  previousAssetsById?: Map<string, AddressPriceAssetLike>;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  providers: readonly AddressPriceProviderKey[];
  nowSec?: number;
}): Map<AddressPriceProviderKey, AddressPriceTarget[]> {
  const result = new Map<AddressPriceProviderKey, AddressPriceTarget[]>();
  const enabledProviders = new Set(params.providers);
  for (const provider of enabledProviders) {
    const chainMap = PROVIDER_CHAIN_MAPS[provider];
    const targets: AddressPriceTarget[] = [];
    const seen = new Set<string>();

    for (const asset of params.assets) {
      const targeting = shouldTargetAsset(
        asset,
        params.previousAssetsById,
        params.previousMissingGenerationsById,
        params.nowSec ?? Math.floor(Date.now() / 1000),
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

      for (const deployment of deployments) {
        const chain = resolveChainId(deployment.chain);
        if (!chain) continue;
        if (provider === "birdeye-address" && chain !== "solana") continue;
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

    targets.sort(compareAddressPriceTargets);
    result.set(provider, targets);
  }

  return result;
}

async function runAddressProvider(params: {
  provider: AddressPriceProviderKey;
  targets: AddressPriceTarget[];
  config: AddressPriceProviderRuntimeConfig;
  signal?: AbortSignal;
  nowSec: number;
  deadlineMs: number;
  db?: D1Database;
}): Promise<AddressPriceProviderRunResult> {
  switch (params.provider) {
    case "dexscreener-address":
      return runDexScreenerAddressProvider(params.targets, params.signal, params.nowSec, params.deadlineMs);
    case "dexpaprika-address":
      return runDexPaprikaAddressProvider(params.targets, params.signal, params.deadlineMs, {
        db: params.db,
        nowSec: params.nowSec,
      });
    case "coingecko-onchain-address":
      return runCoingeckoOnchainAddressProvider(params.targets, params.config.cgApiKey ?? null, params.signal, params.nowSec, params.deadlineMs);
    case "alchemy-address":
      return runAlchemyAddressProvider(params.targets, params.config, params.signal, params.deadlineMs);
    case "moralis-address":
      return runMoralisAddressProvider(params.targets, params.config, params.signal, params.nowSec, params.deadlineMs);
    case "birdeye-address":
      return runBirdeyeAddressProvider(params.targets, params.config, params.signal, params.deadlineMs);
  }
}

export async function collectAddressPriceProviderQuotes(params: {
  targetsByProvider: Map<AddressPriceProviderKey, AddressPriceTarget[]>;
  providers: readonly AddressPriceProviderKey[];
  sourceAllowed: Record<AddressPriceProviderKey, boolean>;
  config: AddressPriceProviderRuntimeConfig;
  signal?: AbortSignal;
  nowSec: number;
  db?: D1Database;
}): Promise<AddressPriceProviderCollectionResult> {
  const quotesByStablecoinId = new Map<string, AddressPriceQuote[]>();
  const diagnostics: AddressPriceProviderCollectionResult["diagnostics"] = [];
  const providerOutcomes: AddressPriceProviderCollectionResult["providerOutcomes"] = new Map();
  const deadlineMs = Date.now() + ADDRESS_PROVIDER_RUN_BUDGET_MS;

  const providerOrderCursor = await readProviderTargetCursor(
    params.db,
    "address-provider-order",
    Math.floor(params.nowSec / 900),
  );
  const providers = rotateTargets(params.providers, providerOrderCursor);

  for (const provider of providers) {
    throwIfAborted(params.signal);
    const unrotatedTargets = params.targetsByProvider.get(provider) ?? [];
    const targetCursor = await readProviderTargetCursor(
      params.db,
      `address-targets:${provider}`,
      Math.floor(params.nowSec / 900),
    );
    const targets = rotateAddressPriceTargets(unrotatedTargets, targetCursor);
    if (targets.length === 0) {
      providerOutcomes.set(provider, "success");
      diagnostics.push(buildNoCandidatesDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "no-candidates",
        endpoint: provider,
      }));
      continue;
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
      continue;
    }

    if (Date.now() >= deadlineMs) {
      providerOutcomes.set(provider, "neutral");
      const diagnostic = buildPricingProviderDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "primary",
        endpoint: provider,
        candidateCount: targets.length,
      }, {
        errorClass: "timeout",
        errorMessage: "Address provider group budget exhausted",
        rejectionReasonCounts: { timeout: 1 },
      });
      diagnostic.assetAttempts = targets.slice(0, 100).map((target) => createPricingAssetAttempt({
        assetId: target.stablecoinId,
        adapter: provider,
        chain: target.chain,
        target: target.address,
        state: "skipped",
        skipReason: "budget",
        rejectionClass: "timeout",
        candidateAt: params.nowSec,
      }));
      diagnostics.push(diagnostic);
      continue;
    }

    const result = await runAddressProvider({
      provider,
      targets,
      config: params.config,
      signal: params.signal,
      nowSec: params.nowSec,
      deadlineMs,
      db: params.db,
    });
    diagnostics.push(...result.diagnostics);
    providerOutcomes.set(
      provider,
      result.attemptedRequests === 0
        ? "neutral"
        : result.successfulRequests > 0
          ? "success"
          : "failure",
    );
    for (const quote of result.quotes) {
      const list = quotesByStablecoinId.get(quote.stablecoinId) ?? [];
      list.push(quote);
      quotesByStablecoinId.set(quote.stablecoinId, list);
    }
    if (unrotatedTargets.length > 0) {
      const consideredTargets = resolveAddressProviderCursorAdvance(targets, result);
      await writeProviderTargetCursor(
        params.db,
        `address-targets:${provider}`,
        (targetCursor + consideredTargets) % unrotatedTargets.length,
        params.nowSec,
      );
    }
  }

  if (params.providers.length > 0) {
    await writeProviderTargetCursor(
      params.db,
      "address-provider-order",
      (providerOrderCursor + 1) % params.providers.length,
      params.nowSec,
    );
  }

  return { quotesByStablecoinId, diagnostics, providerOutcomes };
}
