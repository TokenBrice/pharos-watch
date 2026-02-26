# GA Event Tracking Design

**Date:** 2026-02-26
**Goal:** Product insight — understand which features people actually use vs ignore.

## Current State

Bare-minimum GA4 setup in `src/app/layout.tsx` (measurement ID `G-6TS0KG8H04`). Only automatic pageviews, session data, and scroll depth. Zero custom events across 100+ interactive features.

## Architecture

One new file: `src/lib/analytics.ts` — a typed `trackEvent()` wrapper around `window.gtag`. Handles the `window` check (SSR safety) and provides a typed event catalog. Components call `trackEvent('event_name', { params })` directly.

No hooks, no context providers, no dependencies. Plain TypeScript module.

## Event Catalog (19 events, 3 tiers)

### Tier 1 — Feature Adoption (6 events)

*"Are people using our key features?"*

| Event | Fires when | Key params |
|-------|-----------|------------|
| `portfolio_coin_added` | User adds a coin to portfolio | `coin_id` |
| `portfolio_shared` | User clicks Share in portfolio panel | `coin_count` |
| `stress_test_run` | User selects coin + grade in stress test | `target_coin`, `target_grade`, `affected_count` |
| `comparison_created` | 2nd coin added to Compare page | `coin_count`, `coin_ids` (first 5) |
| `comparison_exported` | User clicks Tweet/Share/Download on Compare | `method` (tweet/share/download), `coin_count` |
| `search_performed` | User types in any search input (debounced 1s) | `page`, `query_length` |

### Tier 2 — Feature Engagement (8 events)

*"How are people using features?"*

| Event | Fires when | Key params |
|-------|-----------|------------|
| `filter_applied` | User clicks any filter chip/dropdown | `page`, `filter_type` (peg/type/grade/chain/event), `filter_value` |
| `time_range_changed` | User clicks a chart time range button | `page`, `range` (7d/1m/3m/6m/1y/all) |
| `sort_changed` | User changes sort on Report Cards or any table | `page`, `sort_by` |
| `external_link_clicked` | User clicks any outbound link | `url`, `page` |
| `contract_copied` | User copies a contract address | `coin_id`, `chain` |
| `digest_opened` | User views a specific digest entry | `digest_date` |
| `report_card_viewed` | User clicks into a specific report card detail | `coin_id`, `grade` |
| `coin_detail_navigated` | User navigates to stablecoin detail via any route | `coin_id`, `source` (heatmap/table/comparison/related) |

### Tier 3 — Engagement Signals (5 events)

*"How engaged are users?"*

| Event | Fires when | Key params |
|-------|-----------|------------|
| `theme_toggled` | User switches dark/light mode | `theme` (dark/light) |
| `panel_toggled` | User expands/collapses Portfolio or Stress Test panel | `panel` (portfolio/stress_test), `action` (open/close) |
| `portfolio_cleared` | User clears entire portfolio | `coin_count` |
| `portfolio_coin_removed` | User removes a coin from portfolio | `coin_id` |
| `share_link_copied` | User copies any shareable URL | `page`, `content_type` |

## Intentionally NOT Tracked

- **Navigation clicks** — GA4 pageviews already capture this
- **Hover/tooltip interactions** — too noisy, no actionable insight
- **Scroll depth** — GA4 enhanced measurement handles this
- **Individual table row clicks** — covered by `coin_detail_navigated` with `source` param
- **Status page interactions** — admin-only, not product usage
- **Every keystroke in search** — debounced to 1s, only fires once user pauses

## Utility Design

```typescript
// src/lib/analytics.ts
type EventMap = {
  portfolio_coin_added: { coin_id: string }
  portfolio_shared: { coin_count: number }
  stress_test_run: { target_coin: string; target_grade: string; affected_count: number }
  comparison_created: { coin_count: number; coin_ids: string }
  comparison_exported: { method: string; coin_count: number }
  search_performed: { page: string; query_length: number }
  filter_applied: { page: string; filter_type: string; filter_value: string }
  time_range_changed: { page: string; range: string }
  sort_changed: { page: string; sort_by: string }
  external_link_clicked: { url: string; page: string }
  contract_copied: { coin_id: string; chain: string }
  digest_opened: { digest_date: string }
  report_card_viewed: { coin_id: string; grade: string }
  coin_detail_navigated: { coin_id: string; source: string }
  theme_toggled: { theme: string }
  panel_toggled: { panel: string; action: string }
  portfolio_cleared: { coin_count: number }
  portfolio_coin_removed: { coin_id: string }
  share_link_copied: { page: string; content_type: string }
}

export function trackEvent<K extends keyof EventMap>(
  name: K,
  params: EventMap[K]
): void {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', name, params)
  }
}
```

## Integration Points

| File | Events |
|------|--------|
| `src/components/report-cards/portfolio-panel.tsx` | `portfolio_coin_added`, `portfolio_shared`, `portfolio_cleared`, `portfolio_coin_removed` |
| `src/components/report-cards/stress-test-panel.tsx` | `stress_test_run`, `panel_toggled` |
| `src/app/compare/client.tsx` | `comparison_created`, `comparison_exported` |
| `src/app/peg-tracker/client.tsx` | `filter_applied`, `search_performed` |
| `src/app/blacklist/page.tsx` | `filter_applied`, `search_performed` |
| `src/app/liquidity/client.tsx` | `filter_applied`, `search_performed` |
| `src/app/report-cards/client.tsx` | `filter_applied`, `sort_changed`, `panel_toggled` |
| `src/app/stability-index/client.tsx` | `time_range_changed` |
| `src/app/stablecoin/[id]/client.tsx` | `contract_copied`, `external_link_clicked`, `coin_detail_navigated` |
| `src/app/digest/` | `digest_opened` |
| `src/components/theme-toggle.tsx` | `theme_toggled` |
