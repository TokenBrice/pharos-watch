import {
  jsonResponse,
  } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { YIELD_ADAPTER_MANIFEST } from "../cron/yield-config";
import {
  type YieldAdapterManifestEntry,
  type YieldStrategyDescriptor,
} from "../cron/yield-config-registry";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/yield-methodology";
import type {
  YieldAdapterManifestFamily,
  YieldAdapterManifestPublicEntry,
  YieldAdapterManifestResponse,
} from "@shared/types/yield";

const SYMBOL_BY_STABLECOIN_ID = new Map<string, string>(
  YIELD_BEARING_STABLECOINS.map((meta) => [meta.id, meta.symbol]),
);

const MANIFEST_UPDATED_AT_SEC =
  YIELD_METHODOLOGY_CHANGELOG.find((entry) => entry.version === YIELD_METHODOLOGY_VERSION)?.effectiveAt
  ?? 0;

interface FamilyMapping {
  family: YieldAdapterManifestFamily;
  sourceKey: string | null;
  sourceKeyPattern?: string | null;
}

function familyFromStrategy(strategy: YieldStrategyDescriptor): FamilyMapping | null {
  const sourceKey = strategy.sourceKey ?? null;
  switch (strategy.kind) {
    case "deterministic-onchain":
      return { family: "onchain", sourceKey };
    case "protocol-api": {
      const family: YieldAdapterManifestFamily = sourceKey?.startsWith("onchain:")
        ? "onchain"
        : "protocol-api";
      return { family, sourceKey };
    }
    case "native-pool":
    case "weighted-pool":
      return { family: "defillama", sourceKey };
    case "variant-pool":
      return { family: "defillama", sourceKey, sourceKeyPattern: strategy.sourceKeyPattern ?? null };
    case "auto-discovery-override":
      return { family: "defillama-auto", sourceKey };
    case "rate-derived":
      return { family: "rate-derived", sourceKey };
    case "price-derived":
      return { family: "price-derived", sourceKey };
    case "intentional-gap":
      return { family: "intentional-gap", sourceKey };
    case "quarantined":
      return { family: "onchain", sourceKey, sourceKeyPattern: strategy.sourceKeyPattern ?? null };
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

    const seenSourceKeys = new Set<string>();
    for (const strategy of manifestEntry.strategies) {
      const mapping = familyFromStrategy(strategy);
      if (!mapping) continue;
      const dedupeKey = [
        mapping.family,
        mapping.sourceKey ?? mapping.sourceKeyPattern ?? strategy.label,
        strategy.lifecycle ?? "active",
      ].join(":");
      if (seenSourceKeys.has(dedupeKey)) continue;
      seenSourceKeys.add(dedupeKey);

      const lifecycle = strategy.lifecycle ?? "active";
      const quarantineReason = lifecycle === "quarantined"
        ? strategy.lifecycleReason?.note ?? strategy.rationale ?? manifestEntry.deterministicQuarantineReason ?? null
        : null;

      entries.push({
        stablecoinId: manifestEntry.stablecoinId,
        coinSymbol,
        family: mapping.family,
        sourceKey: mapping.sourceKey,
        sourceKeyPattern: mapping.sourceKeyPattern ?? null,
        label: strategy.label,
        chain: resolveChain(manifestEntry, strategy),
        project: resolveProject(manifestEntry, strategy),
        lifecycle,
        quarantineReason,
        methodologyVersion,
        updatedAt,
      });
    }
  }
  return entries;
}

export const handleYieldAdapterManifest = async (): Promise<Response> => {
    const updatedAtSec = MANIFEST_UPDATED_AT_SEC;
    const entries = buildPublicEntries(YIELD_METHODOLOGY_VERSION_LABEL, updatedAtSec);
    const payload: YieldAdapterManifestResponse = {
      methodologyVersion: YIELD_METHODOLOGY_VERSION_LABEL,
      updatedAt: updatedAtSec,
      entries,
    };
    return jsonResponse(payload, {
      headers: {
        "Cache-Control": CACHE_PROFILES.standard,
      },
    });
  };
