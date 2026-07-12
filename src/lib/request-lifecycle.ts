export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function normalizeRequestTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === null) return null;
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.ceil(timeoutMs));
}

export type RequestSignalPolicy = "explicit-over-init" | "compose";

export function resolveRequestSignal(
  initSignal: AbortSignal | null | undefined,
  explicitSignal: AbortSignal | null | undefined,
  policy: RequestSignalPolicy,
): AbortSignal | undefined {
  if (policy === "explicit-over-init") {
    return explicitSignal ?? initSignal ?? undefined;
  }

  const signals = [initSignal, explicitSignal].filter((signal): signal is AbortSignal => signal != null);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);

  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const source of signals) {
    if (source.aborted) {
      abort(source);
      break;
    }
    source.addEventListener("abort", () => abort(source), { once: true });
  }
  return controller.signal;
}
