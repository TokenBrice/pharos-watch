import { logWorkerEventArgs } from "../../lib/structured-log";
const OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS = 12_000;

export const OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS = 8_000;
export const OPTIONAL_PROTOCOL_API_BUDGET_MS = 25_000;

/**
 * A swallowed optional-source failure. The callers of the registry live in the
 * coordinator, so the outcome is reported through this callback instead of the
 * log alone: an unrecorded failure is indistinguishable from a source that
 * returned nothing.
 */
export interface YieldOptionalSourceOutcome {
  label: string;
  outcome: "failed" | "timeout";
}

export function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function runTimedOptionalSource<T>(
  label: string,
  signal: AbortSignal | undefined,
  fn: (budgetSignal: AbortSignal) => Promise<T>,
  fallback: T,
  onOutcome?: (outcome: YieldOptionalSourceOutcome) => void,
): Promise<T> {
  const budgetController = new AbortController();
  const timer = setTimeout(() => {
    budgetController.abort(new Error(`${label} timed out after ${Math.round(OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS / 1000)}s`));
  }, OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS);
  const budgetSignal = signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal;

  try {
    return await fn(budgetSignal);
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (budgetController.signal.aborted) {
      logWorkerEventArgs("handler", "warn", `[yield] ${label} timed out; continuing without this source`);
      onOutcome?.({ label, outcome: "timeout" });
    } else {
      onOutcome?.({ label, outcome: "failed" });
    }
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export async function runOptionalSourceFamily<T>(
  label: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    logWorkerEventArgs("handler", "warn", `[yield] ${label} failed:`, error);
    return fallback;
  }
}
