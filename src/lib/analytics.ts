import { isTelegramMiniAppPath } from "@shared/lib/site-csp";
import { SITE_HOSTNAME } from "@shared/lib/runtime-origins";
import { isOpsPath } from "@/lib/admin-workspaces";

// Extend Window to include gtag
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// ---------------------------------------------------------------------------
// Event catalog — every custom event and its typed parameters
// ---------------------------------------------------------------------------

type EventMap = {
  // Tier 1 — Feature Adoption
  comparison_created: { coin_count: number; coin_ids: string };
  comparison_preset_selected: { preset: string };
  comparison_exported: { method: string; coin_count: number };
  search_performed: { page: string; query_length: number };
  // Yield Intelligence decision funnel. Values are bounded enums/ids; raw
  // search text and free-form provider data must never be sent.
  yield_risk_budget_selected: { risk_budget: string; result_count: number };
  yield_preset_selected: { preset: string; action: "applied" | "cleared"; result_count: number };
  yield_filter_changed: { filter_type: string; filter_value: string; action: "applied" | "cleared" };
  yield_filters_cleared: { filter_count: number };
  yield_zero_results: { active_filter_count: number };
  yield_sort_changed: { sort_by: string; direction: "asc" | "desc" };
  yield_row_action: {
    action: "history_opened" | "source_opened" | "provider_opened" | "deep_dive_opened";
    coin_id: string;
    warning_count: number;
  };
  yield_watchlist_changed: { action: "added" | "removed"; coin_id: string };
  yield_compare_changed: { action: "added" | "removed" | "cleared"; coin_count: number; coin_id: string };
  yield_compare_opened: { source: "tray" | "deep_link"; coin_count: number };
  yield_comparison_shared: {
    method: "web_share" | "clipboard";
    coin_count: number;
    success: boolean;
  };
  yield_degraded_exposure: { warning_code: string };
  yield_exported: { scope: "ranking" | "comparison"; row_count: number };
  // Tier 2 — Feature Engagement
  filter_applied: { page: string; filter_type: string; filter_value: string };
  time_range_changed: { page: string; range: string };
  sort_changed: { page: string; sort_by: string };
  contract_copied: { coin_id: string; chain: string };
  // Portfolio
  portfolio_coin_added: { coin_id: string };
  portfolio_coin_removed: { coin_id: string };
  portfolio_shared: { coin_count: number };
  portfolio_cleared: { coin_count: number };
  portfolio_preset_loaded: { preset: string };
  // Tier 3 — Engagement Signals
  theme_toggled: { theme: string };
  // Tier 4 — Web Vitals
  web_vital: {
    name:
      | "CLS"
      | "FCP"
      | "INP"
      | "LCP"
      | "TTFB"
      | "FID"
      | "Next.js-hydration"
      | "Next.js-route-change-to-render"
      | "Next.js-render";
    value: number;
    id: string;
    rating: "good" | "needs-improvement" | "poor";
    navigation_type: string;
    page_path: string;
  };
};

// ---------------------------------------------------------------------------
// Core tracking function
// ---------------------------------------------------------------------------

export function isAnalyticsAllowed(
  pathname: string | null | undefined,
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
): boolean {
  // Loopback preserves explicit local GA smoke checks; layout still requires NEXT_PUBLIC_GA_ID.
  const allowedHost = hostname === SITE_HOSTNAME || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  return allowedHost && Boolean(pathname) && !isOpsPath(pathname) && !isTelegramMiniAppPath(pathname ?? "");
}

export function trackEvent<K extends keyof EventMap>(name: K, params: EventMap[K]): void {
  if (typeof window !== "undefined" && isAnalyticsAllowed(window.location.pathname) && window.gtag) {
    window.gtag("event", name, params);
  }
}

// ---------------------------------------------------------------------------
// Debounced search tracking (fires once after user stops typing for 1s)
// ---------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export function trackSearch(page: string, queryLength: number): void {
  if (searchTimer) clearTimeout(searchTimer);
  if (queryLength === 0) return;
  searchTimer = setTimeout(() => {
    trackEvent("search_performed", { page, query_length: queryLength });
  }, 1000);
}

/**
 * Cancel any pending debounced tracking timers. Call this on client-side
 * navigation so a mid-debounce search timer does not fire after the user has
 * left the page, which would emit a search_performed event attributed to the
 * previous page captured in the closure.
 */
export function clearAllTrackingTimers(): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}
