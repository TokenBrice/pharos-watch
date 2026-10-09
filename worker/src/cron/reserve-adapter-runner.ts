import { logWorkerEventArgs } from "../lib/structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../lib/abort";
import type { AdapterContext, AdapterResult, ReserveAdapterDefinition } from "./reserve-adapters/types";
import type { AdapterLatencyCollector, AdapterLatencyStage } from "./sync-live-reserves-core";
import {
  buildSharedSourceCacheKey,
  buildReserveAdapterAttemptChainError,
  type ConfiguredCoin,
  type LiveReserveConfig,
} from "./sync-live-reserves-shared";
import { createAdapterIoLimiter, RESERVE_ADAPTER_MAX_PARALLEL_IO } from "./reserve-adapters/concurrency";

/** Stamped by the fallback runner on a result read from `inputs.fallbacks` after the primary failed. */
export const PRIMARY_FALLBACK_USED_WARNING_CODE = "primary-fallback-used";

function createAbortableAttemptSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
  reason = "adapter-timeout",
): { signal: AbortSignal; cleanup: () => void } {
  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new Error(reason),
    parentSignal,
  });
  const cleanup = () => timeout.dispose();

  return { signal: timeout.signal, cleanup };
}

function abortReason(signal: AbortSignal, fallback: string): Error | DOMException {
  const reason = signal.reason;
  if (reason instanceof Error || reason instanceof DOMException) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error(fallback);
}

async function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallbackReason: string,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, fallbackReason);

  let cleanup = () => {};
  const abortPromise = new Promise<T>((_resolve, reject) => {
    const abort = () => reject(abortReason(signal, fallbackReason));
    cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    cleanup();
  }
}

function classifyAdapterAttemptChain(config: LiveReserveConfig): string {
  const chains = new Set<string>();
  const input = config.inputs.primary;
  if (input.kind === "onchain-evm") chains.add(input.chain);
  if (input.kind === "onchain-solana") chains.add("solana");

  const visit = (value: unknown, key?: string, depth = 0): void => {
    if (depth > 8 || value == null) return;
    if (key === "chain" && typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (/^[a-z0-9._-]+$/.test(normalized)) chains.add(normalized.slice(0, 80));
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested, undefined, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, nestedKey, depth + 1);
      }
    }
  };
  visit(config.params);

  if (chains.size > 1) return "multi";
  if (chains.size === 1) return chains.values().next().value!;
  return input.kind === "http-json" || input.kind === "http-html" || input.kind === "indexer"
    ? "offchain"
    : "multi";
}

async function runAdapterAttempt(
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
  signal: AbortSignal,
  adapterTimeoutMs: number,
  stage: AdapterLatencyStage,
  cacheHit: boolean,
  telemetry: AdapterLatencyCollector,
  adapterCtx?: AdapterContext,
  deadlineMs?: number,
): Promise<AdapterResult> {
  const remainingMs = (deadlineMs ?? Infinity) - Date.now();
  if (remainingMs <= 0) throw new Error("run-budget-exhausted");
  const { signal: attemptSignal, cleanup } = createAbortableAttemptSignal(
    signal, Math.min(adapterTimeoutMs, remainingMs),
    remainingMs < adapterTimeoutMs ? "run-budget-exhausted" : "adapter-timeout",
  );
  const startedMs = Date.now();
  let ioCallCount = 0;
  let ioActivityBurstCount = 0;
  let activeIo = 0;
  let attemptErrored = true;
  const limiter = createAdapterIoLimiter(RESERVE_ADAPTER_MAX_PARALLEL_IO);
  const instrumentedLimiter = {
    run<T>(label: string, factory: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      ioCallCount += 1;
      return limiter.run(label, () => {
        if (activeIo === 0) ioActivityBurstCount += 1;
        activeIo += 1;
        try {
          const operation = factory();
          void operation.then(
            () => { activeIo -= 1; },
            () => { activeIo -= 1; },
          );
          return operation;
        } catch (error) {
          activeIo -= 1;
          throw error;
        }
      }, options);
    },
  };
  try {
    const result = await raceWithAbortSignal(
      adapter.fetch(coin, config, attemptSignal, Object.assign({}, adapterCtx, {
        nowSec: Math.floor(startedMs / 1_000),
        abortSignal: attemptSignal,
        ioLimiter: instrumentedLimiter,
      })),
      attemptSignal,
      "adapter-timeout",
    );
    attemptErrored = false;
    return result;
  } finally {
    telemetry.recordAttempt({
      adapterKey: adapter.key,
      chain: classifyAdapterAttemptChain(config),
      stage,
      cacheHit,
      ioCallCount,
      ioActivityBurstCount,
      elapsedMs: Date.now() - startedMs,
      error: attemptErrored,
    });
    cleanup();
  }
}

function observeSharedAdapterResult(
  promise: Promise<AdapterResult>,
  input: {
    adapterKey: string;
    chain: string;
    telemetry: AdapterLatencyCollector;
  },
): Promise<AdapterResult> {
  const startedMs = Date.now();
  return promise.then(
    (result) => {
      input.telemetry.recordAttempt({
        adapterKey: input.adapterKey,
        chain: input.chain,
        stage: "primary",
        cacheHit: true,
        ioCallCount: 0,
        ioActivityBurstCount: 0,
        elapsedMs: Date.now() - startedMs,
        error: false,
      });
      return result;
    },
    (error) => {
      input.telemetry.recordAttempt({
        adapterKey: input.adapterKey,
        chain: input.chain,
        stage: "primary",
        cacheHit: true,
        ioCallCount: 0,
        ioActivityBurstCount: 0,
        elapsedMs: Date.now() - startedMs,
        error: true,
      });
      throw error;
    },
  );
}

export function createReserveAdapterRunner(args: {
  signal: AbortSignal;
  adapterCtx: AdapterContext;
  adapterTimeoutMs: number;
  telemetry: AdapterLatencyCollector;
}): (
  coin: ConfiguredCoin,
  config: LiveReserveConfig,
  adapter: ReserveAdapterDefinition,
  deadlineMs?: number,
) => Promise<AdapterResult> {
  const sharedSourceResults = new Map<string, Promise<AdapterResult>>();

  const tryPrimary = (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
    deadlineMs?: number,
  ): Promise<AdapterResult> => {
    const cacheKey = buildSharedSourceCacheKey(config, adapter);
    if (!cacheKey) {
      return runAdapterAttempt(
        coin,
        config,
        adapter,
        args.signal,
        args.adapterTimeoutMs,
        "primary",
        false,
        args.telemetry,
        args.adapterCtx,
        deadlineMs,
      );
    }

    const cached = sharedSourceResults.get(cacheKey);
    if (cached) {
      return observeSharedAdapterResult(cached, {
        adapterKey: adapter.key,
        chain: classifyAdapterAttemptChain(config),
        telemetry: args.telemetry,
      });
    }

    // Retain the promise (including rejections) for the remainder of the run
    // so every coin sharing this source sees a single fetch outcome. The
    // circuit breaker handles cross-run retry suppression.
    const resultPromise = runAdapterAttempt(
      coin,
      config,
      adapter,
      args.signal,
      args.adapterTimeoutMs,
      "primary",
      false,
      args.telemetry,
      args.adapterCtx,
      deadlineMs,
    );
    sharedSourceResults.set(cacheKey, resultPromise);
    return resultPromise;
  };

  return async (
    coin: ConfiguredCoin,
    config: LiveReserveConfig,
    adapter: ReserveAdapterDefinition,
    deadlineMs?: number,
  ): Promise<AdapterResult> => {
    try {
      if (Date.now() >= (deadlineMs ?? Infinity)) throw new Error("run-budget-exhausted");
      return await tryPrimary(coin, config, adapter, deadlineMs);
    } catch (primaryError) {
      const fallbackAttempts: Array<{
        input: LiveReserveConfig["inputs"]["primary"];
        error: unknown;
        index: number;
      }> = [];
      // Hive's second node corroborates the first; substituting it as primary
      // would falsely turn a failed two-node proof into a one-node success.
      const fallbackInputs = adapter.key === "hive-hbd-protocol" ? [] : config.inputs.fallbacks ?? [];
      for (const fb of fallbackInputs) {
        throwIfAborted(args.signal);
        if (Date.now() >= (deadlineMs ?? Infinity)) throw new Error("run-budget-exhausted");
        try {
          const fbConfig = { ...config, inputs: { ...config.inputs, primary: fb } };
          const fallbackResult = await runAdapterAttempt(
            coin,
            fbConfig,
            adapter,
            args.signal,
            args.adapterTimeoutMs,
            "fallback",
            false,
            args.telemetry,
            args.adapterCtx,
            deadlineMs,
          );
          const primaryMessage = toErrorMessage(primaryError);
          const truncated = primaryMessage.length > 200
            ? `${primaryMessage.slice(0, 200)}…`
            : primaryMessage;
          const fallbackWarning = {
            code: PRIMARY_FALLBACK_USED_WARNING_CODE,
            message: `Primary reserve source failed; fell through to fallback. Primary error: ${truncated}`,
            severity: "info" as const,
            effect: "info" as const,
          };
          return {
            ...fallbackResult,
            warnings: [...(fallbackResult.warnings ?? []), fallbackWarning],
          };
        } catch (error) {
          fallbackAttempts.push({ input: fb, error, index: fallbackAttempts.length });
          logWorkerEventArgs("handler", "warn", `[sync-live-reserves] Fallback failed for ${coin.id}:`, error);
        }
      }
      throw buildReserveAdapterAttemptChainError(config, primaryError, fallbackAttempts);
    }
  };
}

