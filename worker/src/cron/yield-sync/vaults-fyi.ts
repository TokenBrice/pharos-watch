import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import { CIRCUIT_SOURCE, MIN_LENDING_POOL_TVL_USD, USER_AGENT } from "../../lib/constants";
import { getCache, setCache } from "../../lib/db-cache";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { recordOutcomeDecision, shouldAttemptFetch, type CircuitOutcomeDecision } from "../../lib/circuit-breaker";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import { buildYieldIdentityLookups, resolveYieldCandidateStablecoinId } from "./identity";
import { OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./optional-source-runtime";
import { createOptionalSourceBudget, resolveCanonicalChain } from "./sources-helpers";
import type { ResolvedYieldCandidate } from "./types";

const VAULTS_FYI_API_BASE = "https://api.vaults.fyi/v2";
const VAULTS_FYI_PAGE_SIZE = 50;
const VAULTS_FYI_DEFAULT_MAX_PAGES_PER_RUN = 1;
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN = 25;
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH = 2_500;
const VAULTS_FYI_MIN_VAULT_SCORE = 70;
const VAULTS_FYI_MAX_APY_PERCENT = 300;
const VAULTS_FYI_BUDGET_MS = 20_000;
const VAULTS_FYI_BUDGET_CACHE_PREFIX = "yield:vaultsfyi:budget:v1";
const VAULTS_FYI_DROP_EXAMPLE_LIMIT = 5;

type VaultsFyiRunStatus = "ok" | "skipped" | "partial" | "failed";
type VaultsFyiSkipReason =
  | "disabled"
  | "no-key"
  | "credit-cap"
  | "provider-quota"
  | "circuit-open"
  | "unauthorized"
  | "request-failed"
  | "invalid-payload";

export interface VaultsFyiTelemetry {
  enabled: boolean;
  hasKey: boolean;
  status: VaultsFyiRunStatus;
  skipReason: VaultsFyiSkipReason | null;
  requestCount: number;
  pageCount: number;
  creditsEstimated: number;
  creditsCap: number;
  monthlyCreditsEstimated: number | null;
  monthlyCreditsCap: number;
  rawVaultCount: number;
  rankableCandidateCount: number;
  auditOnlyCount: number;
  malformedDropCount: number;
  unsupportedChainCount: number;
  identityMissCount: number;
  sizeGateDropCount: number;
  warningDropCount: number;
  durationMs: number;
  budgetMs: number;
  budgetExhausted: boolean;
  dropExamples: string[];
}

export interface VaultsFyiSourceResult {
  candidates: ResolvedYieldCandidate[];
  telemetry: VaultsFyiTelemetry;
}

interface VaultsFyiSourceParams {
  db?: D1Database;
  config?: VaultsFyiRuntimeConfig;
  signal?: AbortSignal;
  startSec?: number;
}

interface ParsedRankableVault {
  network: string;
  vaultId: string;
}

function vaultsFyiNetworkToChain(value: unknown): string | null {
  const raw = getString(value);
  if (!raw) return null;
  if (raw === "mainnet") return "ethereum";
  if (raw === "mega-eth") return "megaeth";
  if (raw === "hyperliquid") return "hyperevm";
  return resolveCanonicalChain(raw);
}

function resolveVaultsFyiChain(network: Record<string, unknown> | null, fallbackNetwork?: string): string | null {
  const numericChainId = getFiniteNumber(network?.chainId ?? network?.id);
  if (numericChainId != null) {
    return resolveCanonicalChain(numericChainId);
  }

  const caip = getString(network?.networkCaip ?? network?.caip);
  if (caip) {
    const match = caip.match(/^eip155:(\d+)$/);
    if (match?.[1]) {
      return resolveCanonicalChain(Number(match[1]));
    }
  }

  return vaultsFyiNetworkToChain(network?.name) ?? vaultsFyiNetworkToChain(fallbackNetwork);
}

function emptyTelemetry(overrides: Partial<VaultsFyiTelemetry> = {}): VaultsFyiTelemetry {
  return {
    enabled: false,
    hasKey: false,
    status: "skipped",
    skipReason: "disabled",
    requestCount: 0,
    pageCount: 0,
    creditsEstimated: 0,
    creditsCap: VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN,
    monthlyCreditsEstimated: null,
    monthlyCreditsCap: VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH,
    rawVaultCount: 0,
    rankableCandidateCount: 0,
    auditOnlyCount: 0,
    malformedDropCount: 0,
    unsupportedChainCount: 0,
    identityMissCount: 0,
    sizeGateDropCount: 0,
    warningDropCount: 0,
    durationMs: 0,
    budgetMs: VAULTS_FYI_BUDGET_MS,
    budgetExhausted: false,
    dropExamples: [],
    ...overrides,
  };
}

function recordDrop(telemetry: VaultsFyiTelemetry, reason: string, example: string): void {
  if (reason === "malformed") telemetry.malformedDropCount += 1;
  else if (reason === "unsupported-chain") telemetry.unsupportedChainCount += 1;
  else if (reason === "identity-miss") telemetry.identityMissCount += 1;
  else if (reason === "size-gate") telemetry.sizeGateDropCount += 1;
  else if (reason === "warning") telemetry.warningDropCount += 1;
  if (telemetry.dropExamples.length < VAULTS_FYI_DROP_EXAMPLE_LIMIT) {
    telemetry.dropExamples.push(`${reason}:${example}`);
  }
}

function parseRankableVault(value: string): ParsedRankableVault | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.includes("/") ? trimmed.indexOf("/") : trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;
  const network = trimmed.slice(0, separatorIndex).trim();
  const vaultId = trimmed.slice(separatorIndex + 1).trim();
  return network && vaultId ? { network, vaultId } : null;
}

function parseRankableVaults(values: readonly string[]): ParsedRankableVault[] {
  const seen = new Set<string>();
  const parsed: ParsedRankableVault[] = [];
  for (const value of values) {
    const entry = parseRankableVault(value);
    if (!entry) continue;
    const key = `${entry.network}:${entry.vaultId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(entry);
  }
  return parsed;
}

function getCurrentMonthBucket(nowSec: number): string {
  const date = new Date(nowSec * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseCreditLedger(value: string | null | undefined, bucket: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.bucket !== bucket || typeof parsed.creditsEstimated !== "number") return 0;
    return Number.isFinite(parsed.creditsEstimated) && parsed.creditsEstimated > 0
      ? Math.trunc(parsed.creditsEstimated)
      : 0;
  } catch {
    return 0;
  }
}

async function readMonthlyCredits(db: D1Database | undefined, bucket: string): Promise<number | null> {
  if (!db) return null;
  const cached = await getCache(db, `${VAULTS_FYI_BUDGET_CACHE_PREFIX}:${bucket}`);
  return parseCreditLedger(cached?.value, bucket);
}

async function writeMonthlyCredits(
  db: D1Database | undefined,
  bucket: string,
  creditsEstimated: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!db) return;
  await setCache(
    db,
    `${VAULTS_FYI_BUDGET_CACHE_PREFIX}:${bucket}`,
    JSON.stringify({ version: 1, bucket, creditsEstimated }),
    signal,
  );
}

function getMonthlyCreditsCap(config: VaultsFyiRuntimeConfig): number {
  return config.enabled && config.maxCreditsPerMonth != null
    ? config.maxCreditsPerMonth
    : VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH;
}

function getRunCreditsCap(config: VaultsFyiRuntimeConfig): number {
  return config.enabled && config.maxCreditsPerRun != null
    ? config.maxCreditsPerRun
    : VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN;
}

function getMaxPagesPerRun(config: VaultsFyiRuntimeConfig): number {
  return config.enabled && config.maxPagesPerRun != null
    ? config.maxPagesPerRun
    : VAULTS_FYI_DEFAULT_MAX_PAGES_PER_RUN;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function parseUnixSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed / 1000);
    }
  }
  return null;
}

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
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
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

function extractRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return null;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.vaults)) return body.vaults;
  return null;
}

function parseCandidateFromDetailedVault(
  row: unknown,
  telemetry: VaultsFyiTelemetry,
  options: { fallbackNetwork?: string; fallbackVaultId?: string; sourceObservedAt: number },
): ResolvedYieldCandidate | null {
  if (!isRecord(row)) {
    recordDrop(telemetry, "malformed", options.fallbackVaultId ?? "row");
    return null;
  }

  telemetry.rawVaultCount += 1;
  const vaultId = getVaultId(row, options.fallbackVaultId);
  const network = getNestedRecord(row, "network");
  const asset = getNestedRecord(row, "asset");
  if (!vaultId || !asset) {
    recordDrop(telemetry, "malformed", vaultId ?? "missing-vault-id");
    return null;
  }

  if (isCorrupted(row) || !isActiveStatus(row)) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "malformed", vaultId);
    return null;
  }
  if (hasWarnings(row)) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "warning", vaultId);
    return null;
  }

  const vaultScore = parseVaultScore(row);
  if (vaultScore != null && vaultScore < VAULTS_FYI_MIN_VAULT_SCORE) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "warning", vaultId);
    return null;
  }

  const chain = resolveVaultsFyiChain(network, options.fallbackNetwork);
  if (!chain) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "unsupported-chain", vaultId);
    return null;
  }

  const assetAddress = normalizeTokenAddress(parseAssetAddress(asset) ?? "");
  const symbol = getString(asset.symbol);
  if (!assetAddress || !symbol) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "identity-miss", vaultId);
    return null;
  }

  const identity = resolveYieldCandidateStablecoinId(
    { chain, address: assetAddress, symbol },
    buildYieldIdentityLookups(ACTIVE_STABLECOINS),
  );
  if (identity.status !== "matched" || identity.matchType !== "chain-address" || !identity.stablecoinId) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "identity-miss", vaultId);
    return null;
  }
  const trackedMeta = TRACKED_META_BY_ID.get(identity.stablecoinId);
  const candidateSymbol = trackedMeta?.symbol ?? symbol;

  const sourceTvlUsd = parseTvlUsd(row);
  if (sourceTvlUsd == null || sourceTvlUsd < MIN_LENDING_POOL_TVL_USD) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "size-gate", vaultId);
    return null;
  }

  const apy = parseApy(row);
  if (!apy) {
    telemetry.auditOnlyCount += 1;
    recordDrop(telemetry, "malformed", vaultId);
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
      sourceObservedAt: parseUnixSeconds(row.lastUpdateTimestamp ?? row.updatedAt) ?? options.sourceObservedAt,
      comparisonAnchorObservedAt: null,
      sourceRisk: {
        venueProtocol: protocolSlug,
        venueChain: chain,
        marketTvlUsd: sourceTvlUsd,
      },
    },
  };
}

async function fetchVaultsFyiJson(
  path: string,
  config: Extract<VaultsFyiRuntimeConfig, { enabled: true }>,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown } | null> {
  const result = await fetchJsonWithRetry<unknown>(
    `${VAULTS_FYI_API_BASE}${path}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "x-api-key": config.apiKey,
      },
      signal,
    },
    0,
    {
      timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
      logUrl: `${VAULTS_FYI_API_BASE}${path.split("?")[0]}`,
      passthroughStatuses: [400, 401, 402, 403, 404, 422, 429, 500, 502, 503],
      maxRetryDelayMs: 1,
    },
  );
  return result ? { status: result.response.status, body: result.body } : null;
}

function classifyStatus(status: number): { skipReason: VaultsFyiSkipReason | null; circuit: CircuitOutcomeDecision } {
  if (status >= 200 && status < 300) return { skipReason: null, circuit: "success" };
  if (status === 401 || status === 403) return { skipReason: "unauthorized", circuit: "failure" };
  if (status === 402 || status === 429) return { skipReason: "provider-quota", circuit: "neutral" };
  return { skipReason: "request-failed", circuit: "failure" };
}

function detailedVaultListCredits(rowCount: number): number {
  return 1 + rowCount * 3;
}

function getRemainingCredits(telemetry: VaultsFyiTelemetry): number {
  const runRemaining = telemetry.creditsCap - telemetry.creditsEstimated;
  const monthlyRemaining = telemetry.monthlyCreditsEstimated == null
    ? Number.POSITIVE_INFINITY
    : telemetry.monthlyCreditsCap - telemetry.monthlyCreditsEstimated;
  return Math.max(0, Math.min(runRemaining, monthlyRemaining));
}

function getDetailedVaultsPerPage(telemetry: VaultsFyiTelemetry): number | null {
  const remainingCredits = getRemainingCredits(telemetry);
  if (remainingCredits <= 1) return null;
  const creditBoundedRows = Math.floor((remainingCredits - 1) / 3);
  return creditBoundedRows > 0 ? Math.min(VAULTS_FYI_PAGE_SIZE, creditBoundedRows) : null;
}

function getRankableVaultKey(network: string, vaultId: string): string {
  return `${network.trim().toLowerCase()}:${vaultId.trim().toLowerCase()}`;
}

function buildRankableVaultKeySet(rankableVaults: ParsedRankableVault[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of rankableVaults) {
    keys.add(getRankableVaultKey(entry.network, entry.vaultId));
    const chain = vaultsFyiNetworkToChain(entry.network);
    if (chain) keys.add(getRankableVaultKey(chain, entry.vaultId));
    if (chain === "ethereum") keys.add(getRankableVaultKey("mainnet", entry.vaultId));
    if (chain === "megaeth") keys.add(getRankableVaultKey("mega-eth", entry.vaultId));
    if (chain === "hyperevm") keys.add(getRankableVaultKey("hyperliquid", entry.vaultId));
  }
  return keys;
}

function rankableNetworks(rankableVaults: ParsedRankableVault[]): string[] {
  const networks = new Set<string>();
  for (const entry of rankableVaults) {
    networks.add(entry.network);
    const chain = vaultsFyiNetworkToChain(entry.network);
    if (chain === "ethereum") networks.add("mainnet");
    if (chain === "megaeth") networks.add("mega-eth");
    if (chain === "hyperevm") networks.add("hyperliquid");
  }
  return [...networks].sort((a, b) => a.localeCompare(b));
}

function rowNetworkKeys(row: Record<string, unknown>): string[] {
  const network = getNestedRecord(row, "network");
  const keys = new Set<string>();
  const name = getString(network?.name);
  const caip = getString(network?.networkCaip ?? network?.caip);
  const chain = resolveVaultsFyiChain(network);
  if (name) keys.add(name.toLowerCase());
  if (caip) keys.add(caip.toLowerCase());
  if (chain) {
    keys.add(chain);
    if (chain === "ethereum") keys.add("mainnet");
    if (chain === "megaeth") keys.add("mega-eth");
    if (chain === "hyperevm") keys.add("hyperliquid");
  }
  return [...keys];
}

function isRankableVaultAllowed(row: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  const vaultIds = [
    getString(row.vaultId),
    getString(row.id),
    getString(row.address),
    getString(row.vaultAddress),
  ].filter((value): value is string => value != null);
  if (vaultIds.length === 0) return false;

  for (const network of rowNetworkKeys(row)) {
    for (const vaultId of vaultIds) {
      if (allowedKeys.has(getRankableVaultKey(network, vaultId))) return true;
    }
  }
  return false;
}

function buildDetailedVaultsPath(args: {
  page: number;
  perPage: number;
  allowedNetworks?: string[];
}): string {
  const params = new URLSearchParams();
  params.set("page", String(args.page));
  params.set("perPage", String(args.perPage));
  params.set("minTvl", String(MIN_LENDING_POOL_TVL_USD));
  params.set("minVaultScore", String(VAULTS_FYI_MIN_VAULT_SCORE));
  params.set("maxApy", String(VAULTS_FYI_MAX_APY_PERCENT / 100));
  params.set("allowCorrupted", "false");
  params.set("allowVaultsWithWarnings", "false");
  params.set("sortBy", "tvl");
  params.set("sortOrder", "desc");
  for (const network of args.allowedNetworks ?? []) {
    params.append("allowedNetworks", network);
  }
  return `/detailed-vaults?${params.toString()}`;
}

function getResponseNextPage(body: unknown, fallbackNextPage: number, rowCount: number, perPage: number): number | null {
  if (isRecord(body) && "nextPage" in body) {
    return Number.isInteger(body.nextPage) ? body.nextPage as number : null;
  }
  return rowCount >= perPage ? fallbackNextPage : null;
}

function canSpendCredits(telemetry: VaultsFyiTelemetry, credits: number): boolean {
  return telemetry.creditsEstimated + credits <= telemetry.creditsCap
    && (telemetry.monthlyCreditsEstimated == null || telemetry.monthlyCreditsEstimated + credits <= telemetry.monthlyCreditsCap);
}

async function spendCredits(
  db: D1Database | undefined,
  bucket: string,
  telemetry: VaultsFyiTelemetry,
  credits: number,
  signal?: AbortSignal,
): Promise<void> {
  telemetry.creditsEstimated += credits;
  if (telemetry.monthlyCreditsEstimated != null) {
    telemetry.monthlyCreditsEstimated += credits;
    await writeMonthlyCredits(db, bucket, telemetry.monthlyCreditsEstimated, signal);
  }
}

async function runInventoryProbe(params: {
  db?: D1Database;
  config: Extract<VaultsFyiRuntimeConfig, { enabled: true }>;
  signal: AbortSignal;
  telemetry: VaultsFyiTelemetry;
  bucket: string;
}): Promise<void> {
  const maxPages = getMaxPagesPerRun(params.config);
  for (let page = 0; page < maxPages; page += 1) {
    const perPage = getDetailedVaultsPerPage(params.telemetry);
    if (perPage == null) {
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "partial" : "skipped";
      params.telemetry.skipReason = "credit-cap";
      return;
    }
    const body = await fetchVaultsFyiJson(
      buildDetailedVaultsPath({ page, perPage }),
      params.config,
      params.signal,
    );
    params.telemetry.requestCount += 1;
    params.telemetry.pageCount += 1;
    if (!body) {
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "request-failed";
      return;
    }
    const status = classifyStatus(body.status);
    if (status.skipReason) {
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "partial" : "skipped";
      params.telemetry.skipReason = status.skipReason;
      return;
    }
    const rows = extractRows(body.body);
    if (!rows) {
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "invalid-payload";
      return;
    }
    await spendCredits(params.db, params.bucket, params.telemetry, detailedVaultListCredits(rows.length), params.signal);
    params.telemetry.rawVaultCount += rows.length;
    params.telemetry.auditOnlyCount += rows.length;
    const nextPage = getResponseNextPage(body.body, page + 1, rows.length, perPage);
    if (nextPage == null) break;
    if (page + 1 >= maxPages) {
      params.telemetry.status = "partial";
      break;
    }
  }
}

async function fetchAllowlistedVaults(params: {
  db?: D1Database;
  config: Extract<VaultsFyiRuntimeConfig, { enabled: true }>;
  signal: AbortSignal;
  telemetry: VaultsFyiTelemetry;
  bucket: string;
  startSec: number;
}): Promise<ResolvedYieldCandidate[]> {
  const candidates: ResolvedYieldCandidate[] = [];
  const rankableVaults = parseRankableVaults(params.config.rankableVaults);
  if (rankableVaults.length === 0) {
    params.telemetry.status = "skipped";
    params.telemetry.skipReason = "invalid-payload";
    return candidates;
  }
  const allowedKeys = buildRankableVaultKeySet(rankableVaults);
  const allowedNetworks = rankableNetworks(rankableVaults);
  const maxPages = getMaxPagesPerRun(params.config);

  for (let page = 0; page < maxPages; page += 1) {
    const perPage = getDetailedVaultsPerPage(params.telemetry);
    if (perPage == null) {
      params.telemetry.status = candidates.length > 0 ? "partial" : "skipped";
      params.telemetry.skipReason = "credit-cap";
      break;
    }
    const body = await fetchVaultsFyiJson(
      buildDetailedVaultsPath({ page, perPage, allowedNetworks }),
      params.config,
      params.signal,
    );
    params.telemetry.requestCount += 1;
    params.telemetry.pageCount += 1;
    if (!body) {
      params.telemetry.status = candidates.length > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "request-failed";
      break;
    }
    const status = classifyStatus(body.status);
    if (status.skipReason) {
      params.telemetry.status = candidates.length > 0 ? "partial" : "skipped";
      params.telemetry.skipReason = status.skipReason;
      break;
    }
    const rows = extractRows(body.body);
    if (!rows) {
      params.telemetry.status = candidates.length > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "invalid-payload";
      break;
    }
    await spendCredits(params.db, params.bucket, params.telemetry, detailedVaultListCredits(rows.length), params.signal);
    for (const row of rows) {
      if (!isRecord(row)) {
        recordDrop(params.telemetry, "malformed", "row");
        continue;
      }
      if (!isRankableVaultAllowed(row, allowedKeys)) {
        params.telemetry.rawVaultCount += 1;
        params.telemetry.auditOnlyCount += 1;
        continue;
      }
      const candidate = parseCandidateFromDetailedVault(row, params.telemetry, {
        sourceObservedAt: params.startSec,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }

    const nextPage = getResponseNextPage(body.body, page + 1, rows.length, perPage);
    if (nextPage == null) break;
    if (page + 1 >= maxPages) {
      params.telemetry.status = "partial";
      break;
    }
  }
  return candidates;
}

export async function fetchVaultsFyiSources({
  db,
  config,
  signal,
  startSec = Math.floor(Date.now() / 1000),
}: VaultsFyiSourceParams = {}): Promise<VaultsFyiSourceResult> {
  const startedAtMs = Date.now();
  const enabled = config?.enabled === true;
  const telemetry = emptyTelemetry({
    enabled,
    hasKey: enabled && Boolean(config?.apiKey),
    status: enabled ? "ok" : "skipped",
    skipReason: enabled ? null : "disabled",
    creditsCap: config ? getRunCreditsCap(config) : VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN,
    monthlyCreditsCap: config ? getMonthlyCreditsCap(config) : VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH,
  });

  if (!config?.enabled) {
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  if (!config.apiKey) {
    telemetry.status = "skipped";
    telemetry.skipReason = "no-key";
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  const bucket = getCurrentMonthBucket(startSec);
  telemetry.monthlyCreditsEstimated = await readMonthlyCredits(db, bucket);
  if (telemetry.monthlyCreditsEstimated != null && telemetry.monthlyCreditsEstimated >= telemetry.monthlyCreditsCap) {
    telemetry.status = "skipped";
    telemetry.skipReason = "credit-cap";
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.VAULTS_FYI))) {
    telemetry.status = "skipped";
    telemetry.skipReason = "circuit-open";
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  const budget = createOptionalSourceBudget("vaults.fyi sources", VAULTS_FYI_BUDGET_MS, signal);
  let circuitOutcome: CircuitOutcomeDecision = "neutral";
  let candidates: ResolvedYieldCandidate[] = [];
  try {
    if (config.rankableVaults.length > 0) {
      candidates = await fetchAllowlistedVaults({
        db,
        config,
        signal: budget.signal,
        telemetry,
        bucket,
        startSec,
      });
    } else {
      await runInventoryProbe({
        db,
        config,
        signal: budget.signal,
        telemetry,
        bucket,
      });
    }

    if (telemetry.skipReason === "provider-quota" || telemetry.skipReason === "credit-cap") {
      circuitOutcome = "neutral";
    } else if (telemetry.status === "failed" || telemetry.skipReason === "request-failed" || telemetry.skipReason === "invalid-payload" || telemetry.skipReason === "unauthorized") {
      circuitOutcome = "failure";
    } else {
      circuitOutcome = "success";
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    telemetry.status = telemetry.rawVaultCount > 0 || candidates.length > 0 ? "partial" : "failed";
    telemetry.skipReason = budget.budgetController.signal.aborted ? "request-failed" : "request-failed";
    telemetry.budgetExhausted = budget.budgetController.signal.aborted;
    circuitOutcome = "failure";
  } finally {
    budget.cleanup();
    telemetry.durationMs = Date.now() - startedAtMs;
    telemetry.budgetExhausted ||= budget.budgetController.signal.aborted;
    if (db) {
      await recordOutcomeDecision(db, CIRCUIT_SOURCE.VAULTS_FYI, circuitOutcome).catch((error: unknown) => {
        console.warn("[yield] vaults.fyi circuit outcome write failed:", error);
      });
    }
  }

  return { candidates, telemetry };
}
