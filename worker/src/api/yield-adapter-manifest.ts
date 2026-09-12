import { jsonResponse } from "../lib/api-response";
import { addFreshnessHeaders } from "../lib/api-freshness-headers";
import { CACHE_PROFILES } from "../lib/constants";
import { YIELD_ADAPTER_MANIFEST } from "../lib/yield-config/yield-config";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION,
} from "@shared/lib/methodology-versions/yield-methodology";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type {
  YieldAdapterManifestFamily,
  YieldAdapterManifestPublicEntry,
  YieldAdapterManifestResponse,
} from "@shared/types/yield";

type YieldAdapterManifestEntry = (typeof YIELD_ADAPTER_MANIFEST)[number];
type YieldStrategyDescriptor = YieldAdapterManifestEntry["strategies"][number];

const SYMBOL_BY_STABLECOIN_ID = new Map<string, string>(
  YIELD_BEARING_STABLECOINS.map((meta) => [meta.id, meta.symbol]),
);

/**
 * Freshness budget for the manifest: the registry's own review cadence (its
 * lifecycle entries carry quarterly `nextReviewAt` horizons), not a cron
 * interval. `addFreshnessHeaders` only warns past 8x this budget, so it flags a
 * registry that has stopped being reviewed rather than a manifest that is
 * simply older than the live ranking data — which it always is.
 */
const MANIFEST_REVIEW_BUDGET_SEC = 90 * DAY_SECONDS;

/**
 * Revision stamp for the manifest projection.
 *
 * The manifest is derived from the static adapter registry, so the honest stamp
 * is the newest registry evidence this module can see: the most recent adapter
 * lifecycle review (`lifecycleReason.since`, when a strategy entered its current
 * `quarantined` / `intentional-gap` state) or the methodology revision that
 * re-derived the registry, whichever is newer.
 *
 * The previous implementation published the *current* methodology entry's date
 * alone: a registry whose adapter set changed without a version bump kept
 * reporting an older update than its own content, and a changelog lookup miss
 * published `updatedAt: 0` (epoch 1970) — with freshness headers attached that
 * would have served a permanent stale warning plus `no-store`.
 */
const MANIFEST_UPDATED_AT_SEC = (() => {
  const lifecycleReviews = YIELD_ADAPTER_MANIFEST.flatMap((entry) =>
    entry.strategies
      .map((strategy) => strategy.lifecycleReason?.since)
      .filter((since): since is string => typeof since === "string")
      .map((since) => Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000))
      .filter((seconds) => Number.isFinite(seconds)),
  );
  const methodologyRevisions = YIELD_METHODOLOGY_CHANGELOG
    .map((entry) => entry.effectiveAt)
    .filter((effectiveAt) => Number.isFinite(effectiveAt) && effectiveAt > 0);
  if (lifecycleReviews.length === 0 && methodologyRevisions.length === 0) {
    throw new Error("Yield adapter manifest has no registry revision date to publish");
  }
  return Math.max(...lifecycleReviews, ...methodologyRevisions);
})();

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
  // Plain version, matching `/api/yield-rankings`' `methodology.version`; the
  // `v`-prefixed label is a display string and made the two endpoints disagree.
  const methodologyVersion = YIELD_METHODOLOGY_VERSION;
  const entries = buildPublicEntries(methodologyVersion, updatedAtSec);
  const payload: YieldAdapterManifestResponse = {
    methodologyVersion,
    updatedAt: updatedAtSec,
    entries,
  };
  return jsonResponse(payload, {
    headers: addFreshnessHeaders(
      { "Cache-Control": CACHE_PROFILES.standard },
      updatedAtSec,
      MANIFEST_REVIEW_BUDGET_SEC,
    ),
  });
};
