import {
  jsonFreshResponse,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { YIELD_ADAPTER_MANIFEST } from "../cron/yield-config";
import {
  getYieldAdapterLifecycle,
  type YieldAdapterManifestEntry,
  type YieldStrategyDescriptor,
} from "../cron/yield-config-registry";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/yield-methodology-version";
import type {
  YieldAdapterManifestFamily,
  YieldAdapterManifestPublicEntry,
  YieldAdapterManifestResponse,
} from "@shared/types/yield";

const SYMBOL_BY_STABLECOIN_ID = new Map<string, string>(
  YIELD_BEARING_STABLECOINS.map((meta) => [meta.id, meta.symbol]),
);

const BUILD_UPDATED_AT_MS = Date.now();
const MANIFEST_CACHE_MAX_AGE_SEC = 300;

interface FamilyMapping {
  family: YieldAdapterManifestFamily;
  sourceKey: string;
}

function familyFromStrategy(
  entry: YieldAdapterManifestEntry,
  strategy: YieldStrategyDescriptor,
): FamilyMapping | null {
  const id = entry.stablecoinId;
  switch (strategy.kind) {
    case "deterministic-onchain":
      return { family: "onchain", sourceKey: `onchain:${id}` };
    case "protocol-api":
      return { family: "protocol-api", sourceKey: `protocol-api:${id}` };
    case "native-pool":
    case "variant-pool":
      return { family: "defillama", sourceKey: `defillama:${id}` };
    case "auto-discovery-override":
      return { family: "defillama-auto", sourceKey: `defillama-auto:${id}` };
    case "rate-derived":
      return { family: "rate-derived", sourceKey: `rate-derived:${id}` };
    case "price-derived":
      return { family: "price-derived", sourceKey: `price-derived:${id}` };
    case "intentional-gap":
      return { family: "intentional-gap", sourceKey: `intentional-gap:${id}` };
    case "quarantined":
      // Quarantined strategies surface via lifecycle on the underlying family;
      // they do not produce their own entry row.
      return null;
  }
}

function resolveChain(
  entry: YieldAdapterManifestEntry,
  strategy: YieldStrategyDescriptor,
): string | null {
  if (strategy.kind === "deterministic-onchain" && entry.onChainRate) {
    return entry.onChainRate.chain;
  }
  if ((strategy.kind === "variant-pool" || strategy.kind === "native-pool") && entry.variant?.variantChain) {
    return entry.variant.variantChain;
  }
  return null;
}

function resolveProject(
  entry: YieldAdapterManifestEntry,
  strategy: YieldStrategyDescriptor,
): string | null {
  if ((strategy.kind === "variant-pool" || strategy.kind === "native-pool") && entry.variant?.variantProject) {
    return entry.variant.variantProject;
  }
  return null;
}

function buildPublicEntries(
  methodologyVersion: string,
  updatedAt: number,
): YieldAdapterManifestPublicEntry[] {
  const entries: YieldAdapterManifestPublicEntry[] = [];
  for (const manifestEntry of YIELD_ADAPTER_MANIFEST) {
    const coinSymbol = SYMBOL_BY_STABLECOIN_ID.get(manifestEntry.stablecoinId) ?? manifestEntry.stablecoinId;
    const lifecycleEntry = getYieldAdapterLifecycle(manifestEntry.stablecoinId);
    const quarantineStrategy = manifestEntry.strategies.find((strategy) => strategy.kind === "quarantined");
    const quarantineReason = quarantineStrategy?.rationale
      ?? manifestEntry.deterministicQuarantineReason
      ?? lifecycleEntry.reason?.note
      ?? null;

    const seenSourceKeys = new Set<string>();
    for (const strategy of manifestEntry.strategies) {
      const mapping = familyFromStrategy(manifestEntry, strategy);
      if (!mapping || seenSourceKeys.has(mapping.sourceKey)) continue;
      seenSourceKeys.add(mapping.sourceKey);

      entries.push({
        stablecoinId: manifestEntry.stablecoinId,
        coinSymbol,
        family: mapping.family,
        sourceKey: mapping.sourceKey,
        label: strategy.label,
        chain: resolveChain(manifestEntry, strategy),
        project: resolveProject(manifestEntry, strategy),
        lifecycle: lifecycleEntry.lifecycle,
        quarantineReason: lifecycleEntry.lifecycle === "quarantined" ? quarantineReason : null,
        methodologyVersion,
        updatedAt,
      });
    }
  }
  return entries;
}

export const handleYieldAdapterManifest = withErrorHandler(
  "yield-adapter-manifest",
  async (): Promise<Response> => {
    const updatedAtSec = Math.floor(BUILD_UPDATED_AT_MS / 1000);
    const entries = buildPublicEntries(YIELD_METHODOLOGY_VERSION_LABEL, updatedAtSec);
    const payload: YieldAdapterManifestResponse = {
      methodologyVersion: YIELD_METHODOLOGY_VERSION_LABEL,
      updatedAt: updatedAtSec,
      entries,
    };
    return jsonFreshResponse(payload, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: updatedAtSec,
      maxAgeSec: MANIFEST_CACHE_MAX_AGE_SEC,
    });
  },
);
