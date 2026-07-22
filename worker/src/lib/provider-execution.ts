import { CRON_CONNECTION_BUDGET, CRON_CONNECTION_BUDGET_ENTRIES } from "@shared/lib/cron-jobs";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import {
  recordOutcomeSafe,
  shouldAttemptFetch,
  type CircuitOutcomeDecision,
  type CircuitOutcomeRecord,
} from "./circuit-breaker";
import { abortError, throwIfAborted } from "./abort";
import {
  cancelResponseBodyQuietly,
  drainResponseBody,
  readResponseJsonWithSignal,
  readResponseTextBoundedWithSignal,
} from "./response-body";

const PROVIDER_EXECUTION_PLATFORM_CONNECTION_LIMIT = CRON_CONNECTION_BUDGET.maxPerTrigger;
const PROVIDER_EXECUTION_HEADROOM_CONNECTION_LIMIT = CRON_CONNECTION_BUDGET.fullForNewFetchHeavyWorkAt;

export type ProviderResponseBodyPolicy = "consume" | "cancel" | "stream";

export interface ProviderRetryPolicy {
  maxRetries: number;
  maxRetryDelayMs?: number;
}

export interface ProviderBreakerPolicy {
  circuitKey?: string;
  enabled?: boolean;
  recordOutcome?: boolean;
}

export interface ProviderExecutionPolicy<TResult = unknown> {
  providerId: string;
  maxConcurrent: number;
  timeoutMs: number;
  retryPolicy?: ProviderRetryPolicy;
  breakerPolicy?: ProviderBreakerPolicy;
  countsAgainstLaneBudget?: boolean;
  responseBodyPolicy: ProviderResponseBodyPolicy;
  classifyOutcome?: (result: TResult) => CircuitOutcomeDecision | boolean;
}

export interface ProviderExecutionAttempt {
  providerId: string;
  circuitKey: string | null;
  laneId: string;
  job: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  timeoutMs: number;
  timedOut: boolean;
  laneMaxConcurrent: number;
  providerMaxConcurrent: number;
  countsAgainstLaneBudget: boolean;
  lanePermitAcquired: boolean;
  providerPermitAcquired: boolean;
  outcome: CircuitOutcomeDecision | null;
  httpStatus?: number;
  error?: string;
}

export interface ProviderExecutionResult<TResult> {
  value: TResult;
  attempt: ProviderExecutionAttempt;
  circuitOutcome: CircuitOutcomeRecord | null;
}

export interface ProviderOperationContext {
  signal: AbortSignal;
  attempt: ProviderExecutionAttempt;
}

interface ProviderPermit {
  release: () => void;
}

interface ProviderSemaphoreWaiter {
  resolve: (permit: ProviderPermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class ProviderSemaphore {
  private active = 0;
  private readonly waiters: ProviderSemaphoreWaiter[] = [];

  constructor(
    readonly label: string,
    readonly maxConcurrent: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<ProviderPermit> {
    throwIfAborted(signal);

    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.makePermit());
    }

    return new Promise((resolve, reject) => {
      const waiter: ProviderSemaphoreWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  snapshot(): { maxConcurrent: number; inUse: number; queued: number } {
    return {
      maxConcurrent: this.maxConcurrent,
      inUse: this.active,
      queued: this.waiters.length,
    };
  }

  private makePermit(): ProviderPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.dispatch();
      },
    };
  }

  private dispatch(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active++;
      waiter.resolve(this.makePermit());
    }
  }
}

export interface ProviderExecutionContextOptions {
  laneId: string;
  laneMaxConcurrent: number;
  signal?: AbortSignal;
  db?: D1Database;
  job?: string;
}

export interface ScheduledProviderExecutionContextOptions {
  job: string;
  laneId?: string;
  laneMaxConcurrent?: number;
  signal?: AbortSignal;
  db?: D1Database;
}

class ProviderExecutionContext {
  readonly laneId: string;
  readonly laneMaxConcurrent: number;
  readonly signal?: AbortSignal;
  readonly db?: D1Database;
  readonly job: string | null;

  private readonly laneSemaphore: ProviderSemaphore;
  private readonly providerSemaphores = new Map<string, ProviderSemaphore>();

  constructor(options: ProviderExecutionContextOptions) {
    this.laneId = options.laneId;
    this.laneMaxConcurrent = normalizeConcurrency(
      options.laneMaxConcurrent,
      `provider execution lane ${options.laneId}`,
      PROVIDER_EXECUTION_HEADROOM_CONNECTION_LIMIT,
    );
    this.signal = options.signal;
    this.db = options.db;
    this.job = options.job ?? null;
    this.laneSemaphore = new ProviderSemaphore(`lane:${options.laneId}`, this.laneMaxConcurrent);
  }

  acquireLanePermit(signal?: AbortSignal): Promise<ProviderPermit> {
    return this.laneSemaphore.acquire(signal);
  }

  acquireProviderPermit(providerId: string, maxConcurrent: number, signal?: AbortSignal): Promise<ProviderPermit> {
    const normalized = normalizeConcurrency(
      maxConcurrent,
      `provider execution policy ${providerId}`,
      PROVIDER_EXECUTION_HEADROOM_CONNECTION_LIMIT,
    );
    const existing = this.providerSemaphores.get(providerId);
    if (existing) {
      if (existing.maxConcurrent !== normalized) {
        throw new RangeError(
          `Provider ${providerId} already registered with maxConcurrent=${existing.maxConcurrent}; received ${normalized}.`,
        );
      }
      return existing.acquire(signal);
    }

    const semaphore = new ProviderSemaphore(`provider:${providerId}`, normalized);
    this.providerSemaphores.set(providerId, semaphore);
    return semaphore.acquire(signal);
  }

  snapshot(): {
    lane: { id: string; maxConcurrent: number; inUse: number; queued: number };
    providers: Record<string, { maxConcurrent: number; inUse: number; queued: number }>;
  } {
    return {
      lane: {
        id: this.laneId,
        ...this.laneSemaphore.snapshot(),
      },
      providers: Object.fromEntries(
        [...this.providerSemaphores.entries()].map(([providerId, semaphore]) => [
          providerId,
          semaphore.snapshot(),
        ]),
      ),
    };
  }
}

export class ProviderCircuitOpenError extends Error {
  constructor(
    readonly providerId: string,
    readonly circuitKey: string,
  ) {
    super(`Provider circuit is open: ${circuitKey}`);
    this.name = "ProviderCircuitOpenError";
  }
}

class ProviderHttpError extends Error {
  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly bodySnippet?: string,
  ) {
    super(bodySnippet ? `${providerId} returned ${status}: ${bodySnippet}` : `${providerId} returned ${status}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderExecutionError extends Error {
  constructor(
    readonly providerId: string,
    readonly originalError: unknown,
    readonly attempt: ProviderExecutionAttempt,
    readonly circuitOutcome: CircuitOutcomeRecord | null,
  ) {
    super(`Provider ${providerId} failed: ${errorMessage(originalError)}`);
    this.name = "ProviderExecutionError";
  }
}

function normalizeConcurrency(value: number, label: string, maxAllowed: number): number {
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1) {
    throw new RangeError(`${label} requires a positive integer concurrency limit (received ${value}).`);
  }
  if (value > PROVIDER_EXECUTION_PLATFORM_CONNECTION_LIMIT) {
    throw new RangeError(
      `${label} cannot exceed the Worker platform connection ceiling (${PROVIDER_EXECUTION_PLATFORM_CONNECTION_LIMIT}).`,
    );
  }
  if (value > maxAllowed) {
    throw new RangeError(
      `${label} cannot exceed the repo headroom limit (${maxAllowed}/${PROVIDER_EXECUTION_PLATFORM_CONNECTION_LIMIT}).`,
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function finishAttempt(
  attempt: ProviderExecutionAttempt,
  monotonicStartedAtMs: number,
  error?: unknown,
): void {
  const finishedAt = nowSec();
  attempt.finishedAt = finishedAt;
  attempt.durationMs = Math.max(0, performance.now() - monotonicStartedAtMs);
  if (error != null) {
    attempt.error = errorMessage(error);
  }
}

function circuitKeyForPolicy<TResult>(policy: ProviderExecutionPolicy<TResult>): string | null {
  if (!policy.breakerPolicy || policy.breakerPolicy.enabled === false) return null;
  return policy.breakerPolicy.circuitKey ?? policy.providerId;
}

function shouldRecordCircuitOutcome<TResult>(policy: ProviderExecutionPolicy<TResult>): boolean {
  return Boolean(policy.breakerPolicy && policy.breakerPolicy.enabled !== false && policy.breakerPolicy.recordOutcome !== false);
}

function normalizeOutcome(outcome: CircuitOutcomeDecision | boolean): CircuitOutcomeDecision {
  if (typeof outcome === "boolean") return outcome ? "success" : "failure";
  return outcome;
}

async function recordProviderOutcome<TResult>(
  context: ProviderExecutionContext,
  policy: ProviderExecutionPolicy<TResult>,
  circuitKey: string | null,
  outcome: CircuitOutcomeDecision,
): Promise<CircuitOutcomeRecord | null> {
  if (!context.db || !circuitKey || !shouldRecordCircuitOutcome(policy) || outcome === "neutral") {
    return null;
  }

  return recordOutcomeSafe(
    context.db,
    circuitKey,
    outcome === "success",
  );
}

export function createProviderExecutionContext(options: ProviderExecutionContextOptions): ProviderExecutionContext {
  return new ProviderExecutionContext(options);
}

export function createProviderExecutionContextForJob(
  options: ScheduledProviderExecutionContextOptions,
): ProviderExecutionContext {
  const entry = CRON_CONNECTION_BUDGET_ENTRIES.find((candidate) => candidate.job === options.job);
  if (!entry) {
    throw new Error(`No CRON_CONNECTION_BUDGET_ENTRIES entry found for ${options.job}.`);
  }
  if (entry.maxConnections < 1) {
    throw new RangeError(`${options.job} has no declared outbound connection budget.`);
  }

  const requested = options.laneMaxConcurrent ?? entry.maxConnections;
  if (requested > entry.maxConnections) {
    throw new RangeError(
      `${options.job} provider lane requested ${requested} connections but the declared job budget is ${entry.maxConnections}.`,
    );
  }

  return createProviderExecutionContext({
    laneId: options.laneId ?? options.job,
    laneMaxConcurrent: requested,
    signal: options.signal,
    db: options.db,
    job: options.job,
  });
}

export async function withProviderExecution<TResult>(
  context: ProviderExecutionContext,
  policy: ProviderExecutionPolicy<TResult>,
  operation: (operationContext: ProviderOperationContext) => Promise<TResult>,
): Promise<ProviderExecutionResult<TResult>> {
  const circuitKey = circuitKeyForPolicy(policy);
  const monotonicStartedAtMs = performance.now();
  const attempt: ProviderExecutionAttempt = {
    providerId: policy.providerId,
    circuitKey,
    laneId: context.laneId,
    job: context.job,
    startedAt: nowSec(),
    finishedAt: null,
    durationMs: null,
    timeoutMs: policy.timeoutMs,
    timedOut: false,
    laneMaxConcurrent: context.laneMaxConcurrent,
    providerMaxConcurrent: policy.maxConcurrent,
    countsAgainstLaneBudget: policy.countsAgainstLaneBudget !== false,
    lanePermitAcquired: false,
    providerPermitAcquired: false,
    outcome: null,
  };

  if (circuitKey) {
    if (!context.db) {
      throw new Error(`Provider ${policy.providerId} declares a breaker but no D1 database was supplied.`);
    }
    const allowed = await shouldAttemptFetch(context.db, circuitKey);
    if (!allowed) {
      finishAttempt(attempt, monotonicStartedAtMs);
      throw new ProviderCircuitOpenError(policy.providerId, circuitKey);
    }
  }

  const releases: ProviderPermit[] = [];
  let timeout: ReturnType<typeof createTimeoutSignal> | null = null;
  let circuitOutcome: CircuitOutcomeRecord | null = null;

  try {
    throwIfAborted(context.signal);

    if (policy.countsAgainstLaneBudget !== false) {
      const lanePermit = await context.acquireLanePermit(context.signal);
      attempt.lanePermitAcquired = true;
      releases.push(lanePermit);
    }
    throwIfAborted(context.signal);
    const providerPermit = await context.acquireProviderPermit(policy.providerId, policy.maxConcurrent, context.signal);
    attempt.providerPermitAcquired = true;
    releases.push(providerPermit);
    throwIfAborted(context.signal);

    timeout = createTimeoutSignal({
      timeoutMs: policy.timeoutMs,
      timeoutReason: new DOMException(
        `provider ${policy.providerId} timed out after ${policy.timeoutMs}ms`,
        "TimeoutError",
      ),
      parentSignal: context.signal,
    });

    const value = await operation({ signal: timeout.signal, attempt });
    attempt.timedOut = timeout.isTimedOut();
    const outcome = attempt.timedOut
      ? "failure"
      : normalizeOutcome(policy.classifyOutcome?.(value) ?? "success");
    attempt.outcome = outcome;
    circuitOutcome = await recordProviderOutcome(context, policy, circuitKey, outcome);
    finishAttempt(attempt, monotonicStartedAtMs);
    return { value, attempt, circuitOutcome };
  } catch (error) {
    attempt.timedOut = timeout?.isTimedOut() ?? false;
    const parentAborted = Boolean(context.signal?.aborted && !attempt.timedOut);
    const outcome: CircuitOutcomeDecision = parentAborted ? "neutral" : "failure";
    attempt.outcome = outcome;
    circuitOutcome = await recordProviderOutcome(context, policy, circuitKey, outcome);
    finishAttempt(attempt, monotonicStartedAtMs, error);

    if (parentAborted) {
      throw abortError(context.signal);
    }
    throw new ProviderExecutionError(policy.providerId, error, attempt, circuitOutcome);
  } finally {
    timeout?.dispose();
    for (let index = releases.length - 1; index >= 0; index--) {
      releases[index]?.release();
    }
  }
}

async function cancelOrDrainResponse(
  response: Response | null | undefined,
  policy: ProviderResponseBodyPolicy,
): Promise<void> {
  if (!response || policy === "stream") return;
  if (policy === "consume") {
    await drainResponseBody(response);
    return;
  }
  await cancelResponseBodyQuietly(response);
}

export async function providerFetch(
  context: ProviderExecutionContext,
  policy: ProviderExecutionPolicy<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ProviderExecutionResult<Response>> {
  return withProviderExecution(context, {
    ...policy,
    classifyOutcome: (response) => response.ok ? "success" : "failure",
  }, async ({ signal, attempt }) => {
    const requestSignal = init?.signal
      ? AbortSignal.any([init.signal, signal])
      : signal;
    const response = await fetch(input, { ...init, signal: requestSignal });
    attempt.httpStatus = response.status;
    if (!response.ok && policy.responseBodyPolicy !== "stream") {
      await cancelOrDrainResponse(response, policy.responseBodyPolicy);
    }
    return response;
  });
}

export async function providerJson<TResult>(
  context: ProviderExecutionContext,
  policy: ProviderExecutionPolicy<TResult>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ProviderExecutionResult<TResult>> {
  return withProviderExecution(context, policy, async ({ signal, attempt }) => {
    const requestSignal = init?.signal
      ? AbortSignal.any([init.signal, signal])
      : signal;
    const response = await fetch(input, { ...init, signal: requestSignal });
    attempt.httpStatus = response.status;
    if (!response.ok) {
      await cancelOrDrainResponse(response, policy.responseBodyPolicy);
      throw new ProviderHttpError(policy.providerId, response.status);
    }
    return await readResponseJsonWithSignal<TResult>(response, requestSignal);
  });
}

export async function providerTextBounded(
  context: ProviderExecutionContext,
  policy: ProviderExecutionPolicy<string>,
  input: RequestInfo | URL,
  init?: RequestInit,
  maxBytes = 65_536,
): Promise<ProviderExecutionResult<string>> {
  return withProviderExecution(context, policy, async ({ signal, attempt }) => {
    const requestSignal = init?.signal
      ? AbortSignal.any([init.signal, signal])
      : signal;
    const response = await fetch(input, { ...init, signal: requestSignal });
    attempt.httpStatus = response.status;
    const text = await readResponseTextBoundedWithSignal(response, maxBytes, requestSignal);
    if (!response.ok) {
      throw new ProviderHttpError(policy.providerId, response.status, text);
    }
    return text;
  });
}
