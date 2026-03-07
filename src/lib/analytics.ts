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
  stress_test_run: { target_coin: string; target_grade: string; affected_count: number };
  comparison_created: { coin_count: number; coin_ids: string };
  comparison_preset_selected: { preset: string };
  comparison_exported: { method: string; coin_count: number };
  search_performed: { page: string; query_length: number };
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
  panel_toggled: { panel: string; action: string };
};

// ---------------------------------------------------------------------------
// Core tracking function
// ---------------------------------------------------------------------------

export function trackEvent<K extends keyof EventMap>(name: K, params: EventMap[K]): void {
  if (typeof window !== "undefined" && window.gtag) {
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
