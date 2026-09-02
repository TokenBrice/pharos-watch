import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import { parseEpochSeconds } from "@shared/lib/epoch";
import { isRecord } from "@shared/lib/type-guards";
import { MIN_LENDING_POOL_TVL_USD } from "../../lib/constants";
import { buildYieldIdentityLookups, resolveYieldCandidateStablecoinId } from "./identity";
import type { ResolvedYieldCandidate } from "./types";
import {
  VAULTS_FYI_MAX_APY_PERCENT,
  VAULTS_FYI_MIN_VAULT_SCORE,
  getFiniteNumber,
  getNestedRecord,
  getString,
  recordVaultsFyiDrop,
  resolveVaultsFyiChain,
} from "./vaults-fyi-normalization";
import type { VaultsFyiTelemetry } from "./vaults-fyi-types";

const VAULTS_FYI_EPOCH_OPTIONS = {
  numericTextPolicy: "any",
  millisecondsThreshold: 10_000_000_000,
  millisecondsThresholdInclusive: false,
  floor: true,
  minExclusive: 0,
  numericTextMinRejectionPolicy: "iso-fallback",
} as const;

function parseAssetAddress(asset: Record<string, unknown>): string | null {
  const direct = getString(asset.address);
  if (direct) return direct;
  const caip = getString(asset.assetCaip) ?? getString(asset.caip);
  if (!caip) return null;
  const parts = caip.split("/");
  const token = parts[parts.length - 1] ?? null;
  return token?.startsWith("erc20:") ? token.slice("erc20:".length) : token;
}

function parseTvlUsd(row: Record<string, unknown>): number | null {
  const tvl = getNestedRecord(row, "tvl");
  return getFiniteNumber(tvl?.usd) ?? getFiniteNumber(row.tvlUsd) ?? getFiniteNumber(row.tvlUSD);
}

function parseVaultScore(row: Record<string, unknown>): number | null {
  const score = getNestedRecord(row, "score");
  return getFiniteNumber(score?.vaultScore) ?? getFiniteNumber(score?.total) ?? getFiniteNumber(row.vaultScore);
}

function getApyWindow(row: Record<string, unknown>): Record<string, unknown> | null {
  const apy = getNestedRecord(row, "apy") ?? getNestedRecord(row, "apyData");
  if (!apy) return null;
  return (
    getNestedRecord(apy, "7day") ??
    getNestedRecord(apy, "7d") ??
    getNestedRecord(apy, "7Day") ??
    getNestedRecord(apy, "sevenDay") ??
    apy
  );
}

function decimalApyToPercent(value: unknown): number | null {
  const parsed = getFiniteNumber(value);
  if (parsed == null) return null;
  const percent = parsed * 100;
  return Number.isFinite(percent) ? percent : null;
}

function parseApy(row: Record<string, unknown>): {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
} | null {
  const window = getApyWindow(row);
  if (!window) return null;
  const currentApy = decimalApyToPercent(window.total ?? window.apy ?? row.apy);
  if (currentApy == null || currentApy <= 0 || currentApy > VAULTS_FYI_MAX_APY_PERCENT) {
    return null;
  }
  return {
    currentApy,
    apyBase: decimalApyToPercent(window.base ?? window.baseApy ?? window.baseAPY),
    apyReward: decimalApyToPercent(window.reward ?? window.rewards ?? window.rewardApy ?? window.rewardAPY),
  };
}

function hasWarnings(row: Record<string, unknown>): boolean {
  const warnings = row.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) return true;
  const flags = row.flags;
  if (Array.isArray(flags) && flags.length > 0) return true;
  return false;
}

function isCorrupted(row: Record<string, unknown>): boolean {
  return row.isCorrupted === true || row.corrupted === true;
}

function isActiveStatus(row: Record<string, unknown>): boolean {
  const status = getString(row.status)?.toLowerCase();
  if (!status) return true;
  return ["active", "live", "ok", "normal"].includes(status);
}

function sourceId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getVaultId(row: Record<string, unknown>, fallbackVaultId?: string): string | null {
  return (
    getString(row.vaultId) ??
    getString(row.id) ??
    getString(row.address) ??
    getString(row.vaultAddress) ??
    fallbackVaultId ??
    null
  );
}

function getProtocolLabel(row: Record<string, unknown>): string {
  const protocol = getNestedRecord(row, "protocol");
  return getString(protocol?.name) ?? getString(protocol?.slug) ?? "vaults.fyi";
}

function getProtocolSlug(row: Record<string, unknown>): string | null {
  const protocol = getNestedRecord(row, "protocol");
  return getString(protocol?.slug) ?? getString(protocol?.id) ?? null;
}

function getVaultName(row: Record<string, unknown>, vaultId: string): string {
  return getString(row.name) ?? getString(row.displayName) ?? vaultId;
}

export function parseVaultsFyiCandidateFromDetailedVault(
  row: unknown,
  telemetry: VaultsFyiTelemetry,
  options: { fallbackNetwork?: string; fallbackVaultId?: string; sourceObservedAt: number },
): ResolvedYieldCandidate | null {
  if (!isRecord(row)) {
    recordVaultsFyiDrop(telemetry, "malformed", options.fallbackVaultId ?? "row");
    return null;
  }

  telemetry.rawVaultCount += 1;
  const vaultId = getVaultId(row, options.fallbackVaultId);
  const network = getNestedRecord(row, "network");
  const asset = getNestedRecord(row, "asset");
  if (!vaultId || !asset) {
    recordVaultsFyiDrop(telemetry, "malformed", vaultId ?? "missing-vault-id");
    return null;
  }

  if (isCorrupted(row) || !isActiveStatus(row)) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "malformed", vaultId);
    return null;
  }
  if (hasWarnings(row)) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "warning", vaultId);
    return null;
  }

  const vaultScore = parseVaultScore(row);
  if (vaultScore != null && vaultScore < VAULTS_FYI_MIN_VAULT_SCORE) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "warning", vaultId);
    return null;
  }

  const chain = resolveVaultsFyiChain(network, options.fallbackNetwork);
  if (!chain) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "unsupported-chain", vaultId);
    return null;
  }

  const assetAddress = canonicalExitRouteScopedId(chain, parseAssetAddress(asset) ?? "");
  const symbol = getString(asset.symbol);
  if (!assetAddress || !symbol) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "identity-miss", vaultId);
    return null;
  }

  const identity = resolveYieldCandidateStablecoinId(
    { chain, address: assetAddress, symbol },
    buildYieldIdentityLookups(ACTIVE_STABLECOINS),
  );
  if (identity.status !== "matched" || identity.matchType !== "chain-address" || !identity.stablecoinId) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "identity-miss", vaultId);
    return null;
  }
  const trackedMeta = TRACKED_META_BY_ID.get(identity.stablecoinId);
  const candidateSymbol = trackedMeta?.symbol ?? symbol;

  const sourceTvlUsd = parseTvlUsd(row);
  if (sourceTvlUsd == null || sourceTvlUsd < MIN_LENDING_POOL_TVL_USD) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "size-gate", vaultId);
    return null;
  }

  const apy = parseApy(row);
  if (!apy) {
    telemetry.auditOnlyCount += 1;
    recordVaultsFyiDrop(telemetry, "malformed", vaultId);
    return null;
  }

  const vaultSourceId = sourceId(getString(row.address) ?? vaultId);
  const protocolLabel = getProtocolLabel(row);
  const protocolSlug = getProtocolSlug(row) ?? sourceId(protocolLabel);
  const vaultName = getVaultName(row, vaultId);
  telemetry.rankableCandidateCount += 1;

  return {
    stablecoinId: identity.stablecoinId,
    symbol: candidateSymbol,
    chain,
    address: assetAddress,
    yield: {
      currentApy: apy.currentApy,
      apyBase: apy.apyBase,
      apyReward: apy.apyReward,
      sourcePool: vaultId,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: `protocol-api:vaults-fyi:${chain}:${vaultSourceId}`,
      yieldSource: `${protocolLabel}: ${vaultName}`,
      yieldType: "lending-opportunity",
      project: protocolSlug,
      chain,
      sourceObservedAt:
        parseEpochSeconds(row.lastUpdateTimestamp ?? row.updatedAt, VAULTS_FYI_EPOCH_OPTIONS) ??
        options.sourceObservedAt,
      comparisonAnchorObservedAt: null,
      sourceRisk: {
        venueProtocol: protocolSlug,
        venueChain: chain,
        marketTvlUsd: sourceTvlUsd,
      },
    },
  };
}
