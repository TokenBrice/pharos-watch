# UI Freshness Warning Alignment

## Audit Findings

- Several stale-data banners were driven by TanStack Query `dataUpdatedAt`, which measures the browser fetch time rather than the API dataset timestamp.
- A few meta-aware hooks were still deriving freshness from the polling interval instead of the worker endpoint's actual `X-Data-Age` max-age budget.
- Cached-data refresh errors could degrade the generic stale-data banner even when backend freshness metadata still said the dataset was fresh.
- The blacklist endpoints were emitting a 15-minute freshness window even though the page and cron contract are hourly.

## Implementation Plan

1. Introduce a shared endpoint freshness map for banner-driving routes.
2. Switch stale-banner hooks and page models onto API freshness metadata.
3. Keep `QueryErrorNotice` responsible for refresh failures; keep stale-data banners focused on freshness.
4. Align blacklist API freshness headers with the hourly writer cadence and update the matching docs note.

