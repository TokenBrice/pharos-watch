import { CHAIN_META, resolveChainId } from "@shared/lib/chains";

export function createOptionalSourceBudget(
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; budgetController: AbortController; cleanup: () => void } {
  const budgetController = new AbortController();
  const timer = setTimeout(() => {
    budgetController.abort(new Error(`${label} budget exhausted after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);

  return {
    signal: signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal,
    budgetController,
    cleanup: () => clearTimeout(timer),
  };
}

export function resolveCanonicalChain(chain: string | number | null | undefined): string | null {
  if (typeof chain === "number") {
    for (const [chainId, meta] of Object.entries(CHAIN_META)) {
      if (meta.evmChainId === chain) {
        return chainId;
      }
    }
    return null;
  }

  if (typeof chain === "string" && chain.length > 0) {
    return resolveChainId(chain) ?? chain.toLowerCase();
  }

  return null;
}
