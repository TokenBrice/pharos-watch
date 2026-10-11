import { registryRpcEndpoints, type ChainRpcConfig } from "../../lib/chain-registry";

/**
 * Build a deduped list of incumbent registry RPC URLs. Dwellir is excluded
 * independently of placement; supplemental-aware EVM transports own its routing.
 * @param order  'fallback-first' (default) | 'primary-first' | 'rotate'
 * @param seed   Rotation index used when order='rotate' (even → fallback-first, odd → primary-first)
 */
export function resolveRpcUrls(
  rpc: ChainRpcConfig | undefined,
  options: { order?: "fallback-first" | "primary-first" | "rotate"; seed?: number } = {},
): string[] {
  if (!rpc) return [];
  const { order = "fallback-first", seed = 0 } = options;
  const [primaryUrl, fallbackUrl] = registryRpcEndpoints(rpc)
    .filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
  const primary = primaryUrl || null;
  const fallback = fallbackUrl || null;
  let ordered: (string | null)[];
  if (order === "primary-first") {
    ordered = [primary, fallback];
  } else if (order === "rotate") {
    ordered = seed % 2 === 0 ? [fallback, primary] : [primary, fallback];
  } else {
    ordered = [fallback, primary];
  }
  return Array.from(new Set(ordered.filter((url): url is string => url !== null)));
}

export function createOptionalSourceBudget(
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): {
  signal: AbortSignal;
  budgetController: AbortController;
  /**
   * Absolute wall-clock deadline of the family budget. Callers that pace one
   * target at a time derive each target's share from what is still left.
   */
  deadlineMs: number;
  cleanup: () => void;
} {
  const budgetController = new AbortController();
  const deadlineMs = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    budgetController.abort(new Error(`${label} budget exhausted after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);

  return {
    signal: signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal,
    budgetController,
    deadlineMs,
    cleanup: () => clearTimeout(timer),
  };
}
