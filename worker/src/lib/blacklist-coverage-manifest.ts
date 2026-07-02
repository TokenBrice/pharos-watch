import { resolveBlacklistStatuses } from "@shared/lib/report-card-blacklist-matchers";
import {
  type BlacklistStablecoin,
} from "@shared/types/market";
import type { StablecoinMeta } from "@shared/types";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "./blacklist-contracts";

// Runtime callers use the narrow accessors below. The full manifest builder is
// kept as a test-validated coverage guard over blacklist metadata/config drift.

export type BlacklistCoverageManifestStatus = "tracked" | "deferred" | "waived" | "out-of-scope";

export interface BlacklistCoverageManifestEntry {
  stablecoinId: string;
  symbol: string;
  chainId: string;
  contractAddress?: string;
  native?: boolean;
  status: BlacklistCoverageManifestStatus;
  reason: string;
  source: string;
  reviewer: string;
  reviewedAt: string;
  expectedSymbol: string;
}

export interface BlacklistDeferredCoverageEntry {
  symbol: BlacklistStablecoin;
  chainId: string;
  reason: string;
}

const REVIEWER = "Codex blacklist coverage pass";
const REVIEWED_AT = "2026-05-12";

const DEFERRED_BLACKLIST_COVERAGE_MANIFEST = [
  { symbol: "AID", stablecoinId: "aid-gaib", chainId: "base", reason: "deferred_contract_creation_verification" },
  { symbol: "TGBP", stablecoinId: "tgbp-tokenised", chainId: "base", reason: "deferred_contract_creation_verification" },
  { symbol: "TGBP", stablecoinId: "tgbp-tokenised", chainId: "bsc", reason: "deferred_contract_creation_verification" },
  { symbol: "TUSD", stablecoinId: "tusd-trueusd", chainId: "bsc", reason: "deferred_contract_creation_verification" },
  { symbol: "TUSD", stablecoinId: "tusd-trueusd", chainId: "avalanche", reason: "deferred_contract_creation_verification" },
  { symbol: "TUSD", stablecoinId: "tusd-trueusd", chainId: "polygon", reason: "bridged_token_without_blacklist_events" },
  { symbol: "TUSD", stablecoinId: "tusd-trueusd", chainId: "optimism", reason: "bridged_token_without_blacklist_events" },
  { symbol: "USDA", stablecoinId: "usda-avalon", chainId: "bsc", reason: "deferred_contract_creation_verification" },
  { symbol: "AEUR", stablecoinId: "aeur-anchored-coins", chainId: "bsc", reason: "deferred_contract_creation_verification" },
  { symbol: "JPYC", stablecoinId: "jpyc-jpyc", chainId: "avalanche", reason: "deferred_contract_creation_verification" },
] as const satisfies ReadonlyArray<{
  symbol: BlacklistStablecoin;
  stablecoinId: string;
  chainId: string;
  reason: string;
}>;

export function getSupportedBlacklistChainIds(
  configs: readonly ContractEventConfig[] = CONTRACT_CONFIGS,
): Set<string> {
  return new Set(configs.map((config) => config.chain.chainId));
}

export function getSupportedBlacklistChainNames(
  configs: readonly ContractEventConfig[] = CONTRACT_CONFIGS,
): Set<string> {
  return new Set(configs.map((config) => config.chain.chainName));
}

function buildTrackedCoverageEntries(
  configs: readonly ContractEventConfig[] = CONTRACT_CONFIGS,
): BlacklistCoverageManifestEntry[] {
  return configs.map((config) => ({
    stablecoinId: config.stablecoinId,
    symbol: config.stablecoin,
    chainId: config.chain.chainId,
    contractAddress: config.contractAddress,
    status: "tracked",
    reason: "event_config_tracks_supported_blacklist_or_destroy_events",
    source: "worker/src/lib/blacklist-contracts.ts",
    reviewer: REVIEWER,
    reviewedAt: REVIEWED_AT,
    expectedSymbol: config.stablecoin,
  }));
}

function buildDeferredCoverageEntries(): BlacklistCoverageManifestEntry[] {
  return DEFERRED_BLACKLIST_COVERAGE_MANIFEST.map((entry) => ({
    stablecoinId: entry.stablecoinId,
    symbol: entry.symbol,
    chainId: entry.chainId,
    status: "deferred",
    reason: entry.reason,
    source: "worker/src/lib/blacklist-coverage-manifest.ts",
    reviewer: REVIEWER,
    reviewedAt: REVIEWED_AT,
    expectedSymbol: entry.symbol,
  }));
}

export function getDeferredBlacklistCoverage(): BlacklistDeferredCoverageEntry[] {
  return DEFERRED_BLACKLIST_COVERAGE_MANIFEST.map(({ symbol, chainId, reason }) => ({
    symbol,
    chainId,
    reason,
  }));
}

function buildOutOfScopeCoverageEntries(
  metas: readonly StablecoinMeta[],
  configs: readonly ContractEventConfig[] = CONTRACT_CONFIGS,
): BlacklistCoverageManifestEntry[] {
  const resolved = resolveBlacklistStatuses(metas);
  const configuredIds = new Set<string>(configs.map((config) => config.stablecoinId));
  const deferredIds = new Set<string>(DEFERRED_BLACKLIST_COVERAGE_MANIFEST.map((entry) => entry.stablecoinId));

  return metas
    .filter((meta) => resolved.get(meta.id) === true)
    .filter((meta) => !configuredIds.has(meta.id) && !deferredIds.has(meta.id))
    .map((meta) => {
      return {
        stablecoinId: meta.id,
        symbol: meta.symbol,
        chainId: meta.contracts?.[0]?.chain ?? "metadata-only",
        native: meta.contracts == null || meta.contracts.length === 0,
        status: "out-of-scope" as const,
        reason: "direct_freezable_assessment_without_supported_blacklist_event_config",
        source: meta.blacklistabilityReview?.sources?.[0]?.url ?? "shared stablecoin metadata",
        reviewer: meta.blacklistabilityReview?.reviewer ?? REVIEWER,
        reviewedAt: meta.blacklistabilityReview?.reviewedAt ?? REVIEWED_AT,
        expectedSymbol: meta.symbol,
      };
    });
}

export function buildBlacklistCoverageManifest(
  metas: readonly StablecoinMeta[],
  configs: readonly ContractEventConfig[] = CONTRACT_CONFIGS,
): BlacklistCoverageManifestEntry[] {
  return [
    ...buildTrackedCoverageEntries(configs),
    ...buildDeferredCoverageEntries(),
    ...buildOutOfScopeCoverageEntries(metas, configs),
  ];
}
