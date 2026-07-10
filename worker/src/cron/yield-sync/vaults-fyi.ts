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
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_RUN = 13;
const VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH = 2_500;
const VAULTS_FYI_BUDGET_MS = 20_000;
const VAULTS_FYI_BUDGET_CACHE_PREFIX = "yield:vaultsfyi:budget:v1";
const VAULTS_FYI_SCHEDULE_INTERVAL_SEC = 4 * 60 * 60;
const VAULTS_FYI_RESERVATION_TTL_SEC = 20 * 60;
const VAULTS_FYI_BUDGET_WARNING_RATIO = 0.75;

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
    monthlyCreditsReserved: null,
    monthlyCreditsCap: VAULTS_FYI_DEFAULT_MAX_CREDITS_PER_MONTH,
    monthlyCreditsForecast: null,
    monthlyUnthrottledForecast: null,
    monthlyBudgetUtilization: null,
    monthlyBudgetWarning: false,
    monthlyRunsRemaining: null,
    coverageBudgetState: "unavailable",
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

interface VaultsFyiCreditLedger {
  creditsEstimated: number;
  creditsReserved: number;
  reservationId: string | null;
  reservationExpiresAt: number | null;
}

interface VaultsFyiCreditReservation extends VaultsFyiCreditLedger {
  bucket: string;
}

function emptyCreditLedger(): VaultsFyiCreditLedger {
  return { creditsEstimated: 0, creditsReserved: 0, reservationId: null, reservationExpiresAt: null };
}

function parseCreditLedger(value: string | null | undefined, bucket: string, nowSec: number): VaultsFyiCreditLedger {
  if (!value) return emptyCreditLedger();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.bucket !== bucket || typeof parsed.creditsEstimated !== "number") {
      return emptyCreditLedger();
    }
    const creditsEstimated = Number.isFinite(parsed.creditsEstimated) && parsed.creditsEstimated > 0
      ? Math.trunc(parsed.creditsEstimated)
      : 0;
    const reservationExpiresAt = typeof parsed.reservationExpiresAt === "number"
      ? Math.trunc(parsed.reservationExpiresAt)
      : null;
    const reservationActive = reservationExpiresAt != null && reservationExpiresAt > nowSec;
    return {
      creditsEstimated,
      creditsReserved:
        reservationActive && typeof parsed.creditsReserved === "number" && Number.isFinite(parsed.creditsReserved)
          ? Math.max(0, Math.trunc(parsed.creditsReserved))
          : 0,
      reservationId: reservationActive && typeof parsed.reservationId === "string" ? parsed.reservationId : null,
      reservationExpiresAt: reservationActive ? reservationExpiresAt : null,
    };
  } catch {
    return emptyCreditLedger();
  }
}

async function readMonthlyCredits(
  db: D1Database | undefined,
  bucket: string,
  nowSec: number,
): Promise<VaultsFyiCreditLedger | null> {
  if (!db) return null;
  const cached = await getCache(db, `${VAULTS_FYI_BUDGET_CACHE_PREFIX}:${bucket}`);
  return parseCreditLedger(cached?.value, bucket, nowSec);
}

async function writeMonthlyCredits(
  db: D1Database | undefined,
  bucket: string,
  ledger: VaultsFyiCreditLedger,
  signal?: AbortSignal,
): Promise<void> {
  if (!db) return;
  await setCache(
    db,
    `${VAULTS_FYI_BUDGET_CACHE_PREFIX}:${bucket}`,
    JSON.stringify({ version: 2, bucket, ...ledger }),
    signal,
  );
}

function getRunsRemainingInMonth(nowSec: number): number {
  const now = new Date(nowSec * 1000);
  const nextMonthSec = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
  return Math.max(1, Math.ceil((nextMonthSec - nowSec) / VAULTS_FYI_SCHEDULE_INTERVAL_SEC));
}

export function buildVaultsFyiBudgetPlan(input: {
  nowSec: number;
  creditsEstimated: number;
  creditsReserved?: number;
  configuredRunCap: number;
  monthlyCap: number;
}) {
  const creditsReserved = Math.max(0, Math.trunc(input.creditsReserved ?? 0));
  const creditsEstimated = Math.max(0, Math.trunc(input.creditsEstimated));
  const runsRemaining = getRunsRemainingInMonth(input.nowSec);
  const remainingCredits = Math.max(0, input.monthlyCap - creditsEstimated - creditsReserved);
  const sustainableRunCap = Math.max(
    0,
    Math.min(input.configuredRunCap, Math.floor(remainingCredits / runsRemaining)),
  );
  const monthlyCreditsForecast = Math.min(
    input.monthlyCap,
    creditsEstimated + creditsReserved + sustainableRunCap * runsRemaining,
  );
  const monthlyUnthrottledForecast = creditsEstimated + creditsReserved + input.configuredRunCap * runsRemaining;
  const monthlyBudgetUtilization = input.monthlyCap > 0 ? creditsEstimated / input.monthlyCap : 1;
  const monthlyBudgetWarning =
    monthlyBudgetUtilization >= VAULTS_FYI_BUDGET_WARNING_RATIO ||
    monthlyCreditsForecast / input.monthlyCap >= VAULTS_FYI_BUDGET_WARNING_RATIO;
  const coverageBudgetState = remainingCredits === 0 || sustainableRunCap === 0
    ? "exhausted"
    : sustainableRunCap < input.configuredRunCap
      ? "throttled"
      : monthlyBudgetWarning
        ? "warning"
        : "within-budget";
  return {
    runsRemaining,
    sustainableRunCap,
    monthlyCreditsForecast,
    monthlyUnthrottledForecast,
    monthlyBudgetUtilization,
    monthlyBudgetWarning,
    coverageBudgetState,
  } as const;
}

async function reserveMonthlyCredits(
  db: D1Database,
  bucket: string,
  ledger: VaultsFyiCreditLedger,
  credits: number,
  nowSec: number,
  signal?: AbortSignal,
): Promise<VaultsFyiCreditReservation> {
  const reservationId = crypto.randomUUID();
  const reservation: VaultsFyiCreditReservation = {
    bucket,
    creditsEstimated: ledger.creditsEstimated,
    creditsReserved: credits,
    reservationId,
    reservationExpiresAt: nowSec + VAULTS_FYI_RESERVATION_TTL_SEC,
  };
  await writeMonthlyCredits(db, bucket, reservation, signal);
  return reservation;
}

async function finalizeMonthlyCredits(
  db: D1Database | undefined,
  reservation: VaultsFyiCreditReservation | null,
  creditsSpent: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!db || !reservation) return;
  await writeMonthlyCredits(
    db,
    reservation.bucket,
    {
      creditsEstimated: reservation.creditsEstimated + creditsSpent,
      creditsReserved: 0,
      reservationId: null,
      reservationExpiresAt: null,
    },
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

function spendCredits(telemetry: VaultsFyiTelemetry, credits: number): void {
  telemetry.creditsEstimated += credits;
  if (telemetry.monthlyCreditsEstimated != null) {
    telemetry.monthlyCreditsEstimated += credits;
  }
}

async function runInventoryProbe(params: {
  config: Extract<VaultsFyiRuntimeConfig, { enabled: true }>;
  signal: AbortSignal;
  telemetry: VaultsFyiTelemetry;
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
    spendCredits(params.telemetry, detailedVaultListCredits(rows.length));
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
  config: Extract<VaultsFyiRuntimeConfig, { enabled: true }>;
  signal: AbortSignal;
  telemetry: VaultsFyiTelemetry;
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
    spendCredits(params.telemetry, 3);

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

  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.VAULTS_FYI))) {
    telemetry.status = "skipped";
    telemetry.skipReason = "circuit-open";
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  const bucket = getCurrentMonthBucket(startSec);
  const ledger = await readMonthlyCredits(db, bucket, startSec);
  let reservation: VaultsFyiCreditReservation | null = null;
  if (ledger) {
    const plan = buildVaultsFyiBudgetPlan({
      nowSec: startSec,
      creditsEstimated: ledger.creditsEstimated,
      creditsReserved: ledger.creditsReserved,
      configuredRunCap: telemetry.creditsCap,
      monthlyCap: telemetry.monthlyCreditsCap,
    });
    telemetry.monthlyCreditsEstimated = ledger.creditsEstimated;
    telemetry.monthlyCreditsReserved = ledger.creditsReserved;
    telemetry.monthlyCreditsForecast = plan.monthlyCreditsForecast;
    telemetry.monthlyUnthrottledForecast = plan.monthlyUnthrottledForecast;
    telemetry.monthlyBudgetUtilization = plan.monthlyBudgetUtilization;
    telemetry.monthlyBudgetWarning = plan.monthlyBudgetWarning;
    telemetry.monthlyRunsRemaining = plan.runsRemaining;
    telemetry.coverageBudgetState = plan.coverageBudgetState;
    telemetry.creditsCap = ledger.creditsReserved > 0 ? 0 : plan.sustainableRunCap;

    if (telemetry.creditsCap > 0) {
      reservation = await reserveMonthlyCredits(
        db!,
        bucket,
        ledger,
        telemetry.creditsCap,
        startSec,
        signal,
      );
      telemetry.monthlyCreditsReserved = telemetry.creditsCap;
    }
  }

  if (telemetry.creditsCap <= 0) {
    telemetry.creditCapReached = true;
    telemetry.status = "skipped";
    telemetry.skipReason = "credit-cap";
    telemetry.durationMs = Date.now() - startedAtMs;
    return { candidates: [], telemetry };
  }

  const budget = createOptionalSourceBudget("vaults.fyi sources", VAULTS_FYI_BUDGET_MS, signal);
  let circuitOutcome: CircuitOutcomeDecision = "neutral";
  let candidates: ResolvedYieldCandidate[] = [];
  try {
    if (config.rankableVaults.length > 0) {
      candidates = await fetchAllowlistedVaults({
        config,
        signal: budget.signal,
        telemetry,
        startSec,
      });
    } else {
      await runInventoryProbe({
        config,
        signal: budget.signal,
        telemetry,
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
    await finalizeMonthlyCredits(db, reservation, telemetry.creditsEstimated).then(() => {
      if (reservation) telemetry.monthlyCreditsReserved = 0;
    }).catch((error: unknown) => {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "vaults_fyi_credit_ledger_write_failed",
        job: "sync-yield-supplemental",
        provider: "vaults-fyi",
        source: "credit-ledger",
        message: "vaults.fyi credit reservation could not be finalized",
        error,
      });
    });
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
