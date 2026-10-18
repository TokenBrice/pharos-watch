export interface BootstrapBody {
  status: number;
  headers: [string, string][];
  bodyText: string | null;
}

type BootstrapOutcome = { ok: true; body: BootstrapBody } | { ok: false; error: unknown };

interface BootstrapEntry {
  url: string;
  accept: string;
  controller: AbortController;
  outcome: Promise<BootstrapOutcome>;
}

interface BootstrapRegistry {
  version: 1;
  route: string;
  expiresAt: number;
  entries: Map<string, BootstrapEntry>;
  discard: () => void;
}

declare global {
  interface Window {
    __pharosDataBootstrap?: BootstrapRegistry;
  }
}

export interface DataBootstrapConfig {
  route: string;
  requests: { key: string; url: string }[];
  accept: string;
  timeoutMs: number;
  handoffMs: number;
  policy: { disabled: boolean; anyHostname: boolean; hostnames: string[]; hostnameSuffix: string };
}

/** Self-contained: serialized into route HTML, with no app/schema dependency graph. */
export function startDataBootstrap(config: DataBootstrapConfig): void {
  const host = window.location.hostname;
  if (window.__pharosDataBootstrap || window.location.pathname !== config.route || config.policy.disabled) return;
  if (!config.policy.anyHostname && !config.policy.hostnames.includes(host) && !host.endsWith(config.policy.hostnameSuffix)) return;

  const entries = new Map<string, BootstrapEntry>();
  const registry: BootstrapRegistry = {
    version: 1,
    route: config.route,
    expiresAt: Date.now() + config.handoffMs,
    entries,
    discard() {
      for (const entry of entries.values()) entry.controller.abort(new DOMException("Document bootstrap discarded", "AbortError"));
      entries.clear();
      clearTimeout(handoffTimer);
      window.removeEventListener("pagehide", registry.discard);
      window.removeEventListener("popstate", registry.discard);
    },
  };
  // Leave the consumed registry as a document tombstone: A → B → A cannot restart it.
  window.__pharosDataBootstrap = registry;
  const handoffTimer = setTimeout(registry.discard, config.handoffMs);
  window.addEventListener("pagehide", registry.discard);
  window.addEventListener("popstate", registry.discard);

  for (const request of config.requests) {
    if (entries.has(request.key) || !request.url.startsWith("/_site-data/")) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException(`API request timed out after ${config.timeoutMs}ms`, "TimeoutError"));
    }, config.timeoutMs);
    const outcome = (async (): Promise<BootstrapOutcome> => {
      try {
        const response = await fetch(request.url, {
          headers: { Accept: config.accept },
          signal: controller.signal,
        });
        let bodyText: string | null;
        try {
          bodyText = await response.text();
        } catch (error) {
          // Match buildFetchError: unreadable HTTP-error bodies retain status with null context.
          if (response.status >= 200 && response.status < 300) throw error;
          bodyText = null;
        }
        controller.signal.throwIfAborted();
        return { ok: true, body: { status: response.status, headers: Array.from(response.headers.entries()), bodyText } };
      } catch (error) {
        // An observed outcome (not an unhandled rejection) waits for the canonical query.
        return { ok: false, error: controller.signal.aborted ? controller.signal.reason : error };
      } finally {
        clearTimeout(timeout);
      }
    })();
    entries.set(request.key, { url: request.url, accept: config.accept, controller, outcome });
  }
}

/** A recent build seed must not strand an already-started document transport. */
export function hasDataBootstrap(queryKey: readonly unknown[]): boolean {
  if (typeof window === "undefined") return false;
  const registry = window.__pharosDataBootstrap;
  return !!registry && registry.version === 1 && registry.route === window.location.pathname
    && Date.now() < registry.expiresAt && registry.entries.has(JSON.stringify(queryKey));
}

/** Claims raw transport only; validation and all QueryClient writes stay in the canonical queryFn. */
export function claimDataBootstrap(
  queryKey: readonly unknown[] | undefined,
  url: string,
  init: RequestInit | undefined,
): Promise<BootstrapBody> | undefined {
  if (typeof window === "undefined" || !queryKey) return undefined;
  const registry = window.__pharosDataBootstrap;
  if (!registry || registry.version !== 1) return undefined;
  if (registry.route !== window.location.pathname || Date.now() >= registry.expiresAt) {
    registry.discard();
    return undefined;
  }
  const key = JSON.stringify(queryKey);
  const entry = registry.entries.get(key);
  if (!entry) return undefined;
  registry.entries.delete(key);

  const headers = new Headers(init?.headers);
  // Only the exact default GET request may take a parser-started transport.
  const mismatch = entry.url !== url || (init?.method ?? "GET") !== "GET"
    || headers.get("Accept") !== entry.accept || Array.from(headers.keys()).some((name) => name !== "accept")
    || (init?.mode !== undefined && init.mode !== "cors")
    || (init?.credentials !== undefined && init.credentials !== "same-origin")
    || Object.keys(init ?? {}).some((name) => !["signal", "headers", "method", "mode", "credentials"].includes(name));
  if (mismatch) {
    entry.controller.abort(new DOMException("Bootstrap request mismatch", "AbortError"));
    return undefined;
  }

  const signal = init?.signal;
  const abort = () => entry.controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return (async () => {
    try {
      signal?.throwIfAborted();
      const outcome = await entry.outcome;
      entry.controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!outcome.ok) throw outcome.error;
      return outcome.body;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  })();
}

export function discardDataBootstrap(): void {
  if (typeof window !== "undefined") window.__pharosDataBootstrap?.discard();
}
