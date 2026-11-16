import { SITE_SESSION_BROWSER_TTL_SEC, SITE_SESSION_CLOCK_LEEWAY_SEC } from "@shared/lib/site-session-constants";

export const SITE_SESSION_EXPIRY_KEY = "pharos-site-session-exp";
export const SITE_SESSION_RENEW_WINDOW_SEC = 3600;

export function getStoredSiteSessionExpiry(): number {
  try {
    const stored = Number(window.localStorage.getItem(SITE_SESSION_EXPIRY_KEY));
    const now = Date.now() / 1000;
    if (Number.isSafeInteger(stored) && stored > now
      && stored <= now + SITE_SESSION_BROWSER_TTL_SEC + SITE_SESSION_CLOCK_LEEWAY_SEC) return stored;
  } catch { /* Storage is optional. */ }
  return 0;
}

export function loadSiteSessionScript(): HTMLScriptElement {
  let script = document.getElementById("pharos-turnstile") as HTMLScriptElement | null;
  if (!script) {
    script = document.createElement("script");
    script.id = "pharos-turnstile";
    script.async = true;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.addEventListener("error", (event) => { (event.currentTarget as HTMLScriptElement).dataset.failed = "true"; }, { once: true });
    performance.mark?.("pharos-session-script");
    document.head.appendChild(script);
  }
  return script;
}

export function preloadSiteSessionScript(): void {
  if (process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK === "true" && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()
    && getStoredSiteSessionExpiry() - Date.now() / 1000 < SITE_SESSION_RENEW_WINDOW_SEC) loadSiteSessionScript();
}
