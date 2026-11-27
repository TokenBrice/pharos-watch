import { setSiteSessionGate } from "@/lib/site-session-gate";
import { trackSiteSessionReady } from "@/lib/analytics";
import { isSiteSessionCheckEnabled } from "@/lib/feature-flags";
import { SITE_SESSION_BROWSER_TTL_SEC, SITE_SESSION_EXPIRES_HEADER } from "@shared/lib/site-session-constants";
import { getStoredSiteSessionExpiry, SITE_SESSION_EXPIRY_KEY, SITE_SESSION_RENEW_WINDOW_SEC } from "@/lib/site-session-script";

type SessionState = "ready" | "pending" | "unavailable";
type Challenge = (signal: AbortSignal) => Promise<string>;
const listeners = new Set<() => void>();
let expiry = 0;
let state: SessionState = "pending";
let attempts = 0;
let inFlight: Promise<void> | null = null;
let challenge: Challenge | null = null;
let rejected = false;
let recoverQueries: (() => void) | null = null;

function publish(next: SessionState) {
  state = next;
  if (next === "ready") trackSiteSessionReady();
  for (const listener of listeners) listener();
}

export function subscribeSiteSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSiteSessionState(): SessionState {
  return state;
}

export function isSiteSessionPaused(): boolean {
  return rejected && state === "unavailable";
}

export function registerSiteSessionRecovery(recover: () => void): () => void {
  recoverQueries = recover;
  return () => { if (recoverQueries === recover) recoverQueries = null; };
}

export function hasValidSiteSession(): boolean {
  if (typeof window === "undefined") return false;
  expiry = Math.max(expiry, getStoredSiteSessionExpiry());
  return expiry > Date.now() / 1000;
}

export function invalidateSiteSession(): void {
  rejected = true;
  expiry = 0;
  try { window.localStorage.removeItem(SITE_SESSION_EXPIRY_KEY); } catch { /* Storage is optional. */ }
  publish(attempts >= 3 && !inFlight ? "unavailable" : "pending");
}

export function registerSiteSessionChallenge(run: Challenge): () => void {
  challenge = run;
  publish(state);
  return () => { if (challenge === run) challenge = null; };
}

function waitForChallenge(signal: AbortSignal): Promise<Challenge> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", abort); };
    const check = () => { if (challenge) { cleanup(); resolve(challenge); } };
    const abort = () => { cleanup(); reject(signal.reason); };
    const unsubscribe = subscribeSiteSession(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/** One bounded attempt sequence per document, shared by queries and background renewal. */
export function ensureSession(renew = false): Promise<void> {
  if (!isSiteSessionCheckEnabled() || typeof window === "undefined") return Promise.resolve();
  if (hasValidSiteSession() && !renew) { publish("ready"); return Promise.resolve(); }
  if (inFlight) return inFlight;
  if (attempts >= 3) {
    publish(hasValidSiteSession() ? "ready" : "unavailable");
    return Promise.reject(new Error("Browser check unavailable"));
  }
  publish("pending");
  inFlight = (async () => {
    while (attempts < 3) {
      if (attempts > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempts - 1)));
      attempts++;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error("Browser check timed out")), 15_000);
      try {
        const run = await waitForChallenge(controller.signal);
        const token = await run(controller.signal);
        controller.signal.throwIfAborted();
        performance.mark?.("pharos-session-token");
        const response = await fetch("/_site-data/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        });
        const expires = Number(response.headers.get(SITE_SESSION_EXPIRES_HEADER));
        await response.arrayBuffer();
        controller.signal.throwIfAborted();
        if (response.status !== 204 || !Number.isSafeInteger(expires) || expires <= 0) throw new Error("Browser session refused");
        expiry = Math.floor(Date.now() / 1000) + SITE_SESSION_BROWSER_TTL_SEC;
        try { window.localStorage.setItem(SITE_SESSION_EXPIRY_KEY, String(expiry)); } catch { /* Storage is optional. */ }
        performance.mark?.("pharos-session-ready");
        publish("ready");
        if (rejected) { rejected = false; recoverQueries?.(); }
        return;
      } catch {
        // Never log or persist the single-use challenge token.
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    }
    publish(hasValidSiteSession() ? "ready" : "unavailable");
    throw new Error("Browser check unavailable");
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Query waits are independent of the shared attempt and respect caller cancellation. */
export async function waitForSiteSession(signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(finish, 3000);
    signal?.addEventListener("abort", abort, { once: true });
    void ensureSession().then(finish, finish);
  });
  signal?.throwIfAborted();
}

export function renewSiteSessionIfNeeded(): void {
  if (document.visibilityState !== "visible") return;
  const valid = hasValidSiteSession();
  if (!valid || expiry - Date.now() / 1000 < SITE_SESSION_RENEW_WINDOW_SEC) void ensureSession(valid).catch(() => {});
  else if (state !== "ready") publish("ready");
}

setSiteSessionGate({ hasValidSiteSession, invalidateSiteSession, waitForSiteSession });
