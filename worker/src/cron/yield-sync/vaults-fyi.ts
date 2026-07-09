import { isRecord } from "@shared/lib/type-guards";
import { throwIfAborted } from "../../lib/abort";
import { CIRCUIT_SOURCE, MIN_LENDING_POOL_TVL_USD, USER_AGENT } from "../../lib/constants";
import { getCache, setCache } from "../../lib/db-cache";
import type { VaultsFyiRuntimeConfig } from "../../lib/env";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { logWorkerEvent } from "../../lib/structured-log";
import { recordOutcomeDecision, shouldAttemptFetch, type CircuitOutcomeDecision } from "../../lib/circuit-breaker";
import { OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./optional-source-runtime";
import { createOptionalSourceBudget } from "./sources-helpers";
import type { ResolvedYieldCandidate } from "./types";
import { parseVaultsFyiCandidateFromDetailedVault } from "./vaults-fyi-candidate";
import {
  VAULTS_FYI_MAX_APY_PERCENT,
  VAULTS_FYI_MIN_VAULT_SCORE,
  buildRankableVaultKeySet,
  extractDetailedVault,
  extractRows,
  isRankableVaultAllowed,
  parseRankableVaults,
  rankableVaultNetwork,
  recordVaultsFyiDrop,
} from "./vaults-fyi-normalization";
import type { VaultsFyiSkipReason, VaultsFyiSourceResult, VaultsFyiTelemetry } from "./vaults-fyi-types";

export type { VaultsFyiSourceResult, VaultsFyiTelemetry } from "./vaults-fyi-types";

const VAULTS_FYI_API_BASE = "https://api.vaults.fyi/v2";
const VAULTS_FYI_PAGE_SIZE = 50;
const VAULTS_FYI_DEFAULT_MAX_PAGES_PER_RUN = 1;
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN = 25;
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH = 2_500;
const VAULTS_FYI_BUDGET_MS = 20_000;
const VAULTS_FYI_BUDGET_CACHE_PREFIX = "yield:vaultsfyi:budget:v1";

interface VaultsFyiSourceParams {
  db?: D1Database;
  config?: VaultsFyiRuntimeConfig;
  signal?: AbortSignal;
  startSec?: number;
}

function emptyTelemetry(overrides: Partial<VaultsFyiTelemetry> = {}): VaultsFyiTelemetry {
  return {
    enabled: false,
    hasKey: false,
    status: "skipped",
    skipReason: "disabled",
    requestCount: 0,
    pageCount: 0,
    pageCapReached: false,
    creditsEstimated: 0,
    creditsCap: VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN,
    creditCapReached: false,
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
  return config.enabled && config.maxPagesPerRun != null ? config.maxPagesPerRun : VAULTS_FYI_DEFAULT_MAX_PAGES_PER_RUN;
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
  if (status === 401) return { skipReason: "unauthorized", circuit: "failure" };
  if (status === 402 || status === 403 || status === 429) {
    return { skipReason: "provider-quota", circuit: "neutral" };
  }
  return { skipReason: "request-failed", circuit: "failure" };
}

function detailedVaultListCredits(rowCount: number): number {
  return 1 + rowCount * 3;
}

function getRemainingCredits(telemetry: VaultsFyiTelemetry): number {
  const runRemaining = telemetry.creditsCap - telemetry.creditsEstimated;
  const monthlyRemaining =
    telemetry.monthlyCreditsEstimated == null
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

function buildDetailedVaultsPath(args: { page: number; perPage: number; allowedNetworks?: string[] }): string {
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

function getResponseNextPage(
  body: unknown,
  fallbackNextPage: number,
  rowCount: number,
  perPage: number,
): number | null {
  if (isRecord(body) && "nextPage" in body) {
    return Number.isInteger(body.nextPage) ? (body.nextPage as number) : null;
  }
  return rowCount >= perPage ? fallbackNextPage : null;
}

function limitRowsToRequestedPageSize(rows: unknown[], perPage: number, telemetry: VaultsFyiTelemetry): unknown[] {
  if (rows.length <= perPage) return rows;
  recordVaultsFyiDrop(telemetry, "malformed", `over-page:${rows.length}>${perPage}`);
  telemetry.status = "partial";
  telemetry.skipReason = "invalid-payload";
  return rows.slice(0, perPage);
}

function canSpendCredits(telemetry: VaultsFyiTelemetry, credits: number): boolean {
  return (
    telemetry.creditsEstimated + credits <= telemetry.creditsCap &&
    (telemetry.monthlyCreditsEstimated == null ||
      telemetry.monthlyCreditsEstimated + credits <= telemetry.monthlyCreditsCap)
  );
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
    await writeMonthlyCredits(db, bucket, telemetry.monthlyCreditsEstimated, signal).catch((error: unknown) => {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "vaults_fyi_credit_ledger_write_failed",
        job: "sync-yield-supplemental",
        provider: "vaults-fyi",
        source: "credit-ledger",
        message: "vaults.fyi credit ledger write failed",
        error,
      });
    });
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
    throwIfAborted(params.signal);
    const perPage = getDetailedVaultsPerPage(params.telemetry);
    if (perPage == null) {
      params.telemetry.creditCapReached = true;
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "ok" : "skipped";
      params.telemetry.skipReason = params.telemetry.rawVaultCount > 0 ? null : "credit-cap";
      return;
    }
    const body = await fetchVaultsFyiJson(buildDetailedVaultsPath({ page, perPage }), params.config, params.signal);
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
    const responseRows = extractRows(body.body);
    const rows = responseRows ? limitRowsToRequestedPageSize(responseRows, perPage, params.telemetry) : null;
    if (!rows) {
      params.telemetry.status = params.telemetry.rawVaultCount > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "invalid-payload";
      return;
    }
    await spendCredits(
      params.db,
      params.bucket,
      params.telemetry,
      detailedVaultListCredits(rows.length),
      params.signal,
    );
    params.telemetry.rawVaultCount += rows.length;
    params.telemetry.auditOnlyCount += rows.length;
    const nextPage = getResponseNextPage(body.body, page + 1, rows.length, perPage);
    if (nextPage == null) break;
    if (params.telemetry.skipReason === "invalid-payload") break;
    if (page + 1 >= maxPages) {
      params.telemetry.pageCapReached = true;
      params.telemetry.status = "ok";
      params.telemetry.skipReason = null;
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
    params.telemetry.skipReason = "invalid-config";
    return candidates;
  }
  const allowedKeys = buildRankableVaultKeySet(rankableVaults);

  for (const entry of rankableVaults) {
    throwIfAborted(params.signal);
    if (!canSpendCredits(params.telemetry, 3)) {
      params.telemetry.creditCapReached = true;
      params.telemetry.status = candidates.length > 0 ? "partial" : "skipped";
      params.telemetry.skipReason = "credit-cap";
      break;
    }
    const body = await fetchVaultsFyiJson(
      `/detailed-vaults/${encodeURIComponent(rankableVaultNetwork(entry.network))}/${encodeURIComponent(entry.vaultId)}`,
      params.config,
      params.signal,
    );
    params.telemetry.requestCount += 1;
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
    await spendCredits(params.db, params.bucket, params.telemetry, 3, params.signal);

    const row = extractDetailedVault(body.body);
    if (!isRecord(row)) {
      params.telemetry.status = candidates.length > 0 ? "partial" : "failed";
      params.telemetry.skipReason = "invalid-payload";
      recordVaultsFyiDrop(params.telemetry, "malformed", entry.vaultId);
      break;
    }
    if (!isRankableVaultAllowed(row, allowedKeys)) {
      params.telemetry.rawVaultCount += 1;
      params.telemetry.auditOnlyCount += 1;
      continue;
    }
    const candidate = parseVaultsFyiCandidateFromDetailedVault(row, params.telemetry, {
      fallbackNetwork: entry.network,
      fallbackVaultId: entry.vaultId,
      sourceObservedAt: params.startSec,
    });
    if (candidate) {
      candidates.push(candidate);
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
  const disabledSkipReason =
    config?.enabled === false
      ? config.disabledReason === "no-key"
        ? "no-key"
        : config.disabledReason === "invalid-enabled-flag"
          ? "invalid-config"
          : "disabled"
      : "disabled";
  const telemetry = emptyTelemetry({
    enabled,
    hasKey: enabled && Boolean(config?.apiKey),
    status: enabled ? "ok" : "skipped",
    skipReason: enabled ? null : disabledSkipReason,
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
    telemetry.creditCapReached = true;
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

    if (
      telemetry.skipReason === "provider-quota" ||
      telemetry.skipReason === "credit-cap" ||
      telemetry.skipReason === "invalid-config"
    ) {
      circuitOutcome = "neutral";
    } else if (
      telemetry.status === "failed" ||
      telemetry.skipReason === "request-failed" ||
      telemetry.skipReason === "invalid-payload" ||
      telemetry.skipReason === "unauthorized"
    ) {
      circuitOutcome = "failure";
    } else {
      circuitOutcome = "success";
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    telemetry.status = telemetry.rawVaultCount > 0 || candidates.length > 0 ? "partial" : "failed";
    telemetry.skipReason = "request-failed";
    telemetry.budgetExhausted = budget.budgetController.signal.aborted;
    circuitOutcome = "failure";
  } finally {
    budget.cleanup();
    telemetry.durationMs = Date.now() - startedAtMs;
    telemetry.budgetExhausted ||= budget.budgetController.signal.aborted;
    if (db) {
      await recordOutcomeDecision(db, CIRCUIT_SOURCE.VAULTS_FYI, circuitOutcome).catch((error: unknown) => {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "vaults_fyi_circuit_outcome_write_failed",
          job: "sync-yield-supplemental",
          provider: "vaults-fyi",
          message: "vaults.fyi circuit outcome write failed",
          error,
        });
      });
    }
  }

  return { candidates, telemetry };
}
