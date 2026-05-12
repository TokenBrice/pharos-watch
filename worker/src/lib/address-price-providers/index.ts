import {
  ALCHEMY_CHAIN_MAP,
  BIRDEYE_CHAIN_MAP,
  DEXPAPRIKA_CHAIN_MAP,
  DS_CHAIN_MAP,
  GT_CHAIN_MAP,
  MORALIS_CHAIN_MAP,
} from "@shared/lib/chain-provider-registry";
import { resolveChainId } from "@shared/lib/chains";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { CIRCUIT_SOURCE } from "../constants";
import type { PricingProviderDiagnosticSource } from "../pricing-provider-diagnostics";
import {
  buildBlockedProviderDiagnostic,
  buildNoCandidatesDiagnostic,
} from "../pricing-provider-lifecycle";
import { runAlchemyAddressProvider } from "./alchemy";
import { runBirdeyeAddressProvider } from "./birdeye";
import { runDexPaprikaAddressProvider } from "./dexpaprika";
import { runDexScreenerAddressProvider } from "./dexscreener";
import { runGeckoTerminalAddressProvider } from "./geckoterminal";
import { runMoralisAddressProvider } from "./moralis";
import {
  ADDRESS_PROVIDER_RUN_BUDGET_MS,
  hasValue,
  normalizeAddressForKey,
} from "./shared";
import type {
  AddressPriceAssetLike,
  AddressPriceProviderCollectionResult,
  AddressPriceProviderKey,
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceQuote,
  AddressPriceTarget,
} from "./types";

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
  "geckoterminal-address",
  "alchemy-address",
  "moralis-address",
  "birdeye-address",
];

const NO_KEY_ADDRESS_PROVIDERS = new Set<AddressPriceProviderKey>([
  "dexscreener-address",
  "dexpaprika-address",
  "geckoterminal-address",
]);

export const ADDRESS_PROVIDER_CIRCUIT_SOURCE: Record<AddressPriceProviderKey, string> = {
  "alchemy-address": CIRCUIT_SOURCE.ALCHEMY_PRICES,
  "moralis-address": CIRCUIT_SOURCE.MORALIS_PRICES,
  "dexscreener-address": CIRCUIT_SOURCE.DEXSCREENER_ADDRESS_PRICES,
  "dexpaprika-address": CIRCUIT_SOURCE.DEXPAPRIKA_PRICES,
  "geckoterminal-address": CIRCUIT_SOURCE.GECKO_TERMINAL_ADDRESS_PRICES,
  "birdeye-address": CIRCUIT_SOURCE.BIRDEYE_PRICES,
};

const PROVIDER_CHAIN_MAPS: Record<AddressPriceProviderKey, Record<string, string>> = {
  "alchemy-address": ALCHEMY_CHAIN_MAP,
  "moralis-address": MORALIS_CHAIN_MAP,
  "dexscreener-address": DS_CHAIN_MAP,
  "dexpaprika-address": DEXPAPRIKA_CHAIN_MAP,
  "geckoterminal-address": GT_CHAIN_MAP,
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

function sumCirculatingUsd(asset: AddressPriceAssetLike): number {
  return Object.values(asset.circulating ?? {}).reduce((sum, value) => (
    typeof value === "number" && Number.isFinite(value) ? sum + value : sum
  ), 0);
}

function shouldTargetAsset(asset: AddressPriceAssetLike, previousAssetsById?: Map<string, AddressPriceAssetLike>): {
  previousSourceDepth: number;
  missingPrice: boolean;
  include: boolean;
} {
  const previous = previousAssetsById?.get(asset.id);
  const previousSourceDepth = previous?.consensusSources?.length ?? asset.consensusSources?.length ?? 0;
  const missingPrice = asset.price == null || typeof asset.price !== "number" || asset.price <= 0;
  return {
    previousSourceDepth,
    missingPrice,
    include: !previousAssetsById || previousSourceDepth < 3 || missingPrice,
  };
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
    deployments.push({
      chain: rawAddress.startsWith("0x") ? "ethereum" : "solana",
      address: rawAddress,
      origin: "asset.address",
    });
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

export function buildAddressPriceTargetsByProvider(params: {
  assets: AddressPriceAssetLike[];
  previousAssetsById?: Map<string, AddressPriceAssetLike>;
  providers: readonly AddressPriceProviderKey[];
}): Map<AddressPriceProviderKey, AddressPriceTarget[]> {
  const result = new Map<AddressPriceProviderKey, AddressPriceTarget[]>();
  const enabledProviders = new Set(params.providers);
  for (const provider of enabledProviders) {
    const chainMap = PROVIDER_CHAIN_MAPS[provider];
    const targets: AddressPriceTarget[] = [];
    const seen = new Set<string>();

    for (const asset of params.assets) {
      const targeting = shouldTargetAsset(asset, params.previousAssetsById);
      if (!targeting.include) continue;

      for (const deployment of buildAssetDeployments(asset)) {
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
          missingPrice: targeting.missingPrice,
          circulatingUsd: sumCirculatingUsd(asset),
        });
      }
    }

    targets.sort((left, right) => {
      if (left.previousSourceDepth !== right.previousSourceDepth) {
        return left.previousSourceDepth - right.previousSourceDepth;
      }
      if (left.missingPrice !== right.missingPrice) return left.missingPrice ? -1 : 1;
      if (left.circulatingUsd !== right.circulatingUsd) return right.circulatingUsd - left.circulatingUsd;
      return `${left.stablecoinId}:${left.chain}:${left.address}`.localeCompare(`${right.stablecoinId}:${right.chain}:${right.address}`);
    });
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
}): Promise<AddressPriceProviderRunResult> {
  switch (params.provider) {
    case "dexscreener-address":
      return runDexScreenerAddressProvider(params.targets, params.signal, params.nowSec, params.deadlineMs);
    case "dexpaprika-address":
      return runDexPaprikaAddressProvider(params.targets, params.signal, params.deadlineMs);
    case "geckoterminal-address":
      return runGeckoTerminalAddressProvider(params.targets, params.signal, params.nowSec, params.deadlineMs);
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
}): Promise<AddressPriceProviderCollectionResult> {
  const quotesByStablecoinId = new Map<string, AddressPriceQuote[]>();
  const diagnostics: AddressPriceProviderCollectionResult["diagnostics"] = [];
  const providerOutcomes = new Map<AddressPriceProviderKey, boolean>();
  const deadlineMs = Date.now() + ADDRESS_PROVIDER_RUN_BUDGET_MS;

  for (const provider of params.providers) {
    const targets = params.targetsByProvider.get(provider) ?? [];
    if (targets.length === 0) {
      providerOutcomes.set(provider, true);
      diagnostics.push(buildNoCandidatesDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "no-candidates",
        endpoint: provider,
      }));
      continue;
    }

    if (!params.sourceAllowed[provider]) {
      providerOutcomes.set(provider, false);
      diagnostics.push(buildBlockedProviderDiagnostic({
        source: provider as PricingProviderDiagnosticSource,
        stage: "primary",
        endpoint: provider,
        candidateCount: targets.length,
      }, `${provider} circuit open`));
      continue;
    }

    if (Date.now() >= deadlineMs) {
      providerOutcomes.set(provider, false);
      diagnostics.push({
        source: provider as PricingProviderDiagnosticSource,
        stage: "primary",
        endpoint: provider,
        status: null,
        ok: false,
        success: false,
        candidateCount: targets.length,
        errorClass: "timeout",
        errorMessage: "Address provider group budget exhausted",
        rejectionReasonCounts: { timeout: 1 },
      });
      continue;
    }

    const result = await runAddressProvider({
      provider,
      targets,
      config: params.config,
      signal: params.signal,
      nowSec: params.nowSec,
      deadlineMs,
    });
    diagnostics.push(...result.diagnostics);
    providerOutcomes.set(provider, result.successfulRequests > 0 || result.attemptedRequests === 0);
    for (const quote of result.quotes) {
      const list = quotesByStablecoinId.get(quote.stablecoinId) ?? [];
      list.push(quote);
      quotesByStablecoinId.set(quote.stablecoinId, list);
    }
  }

  return { quotesByStablecoinId, diagnostics, providerOutcomes };
}
