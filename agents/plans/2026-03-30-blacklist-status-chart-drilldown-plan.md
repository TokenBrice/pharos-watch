## Goal

Add drill-through behavior on `/blacklist` so clicking a blacklistability status bar reveals the matching stablecoins.

## Approach

1. Extract the blacklist-status bucket mapping into a small shared frontend utility so the chart and drilldown stay consistent.
2. Make `BlacklistStatusCharts` accept a selected bucket plus click callback, and mark bars as interactive.
3. Store the selected bucket in the `/blacklist` URL, then render a filtered stablecoin drilldown table on the page using the existing `StablecoinTable`.
4. Add targeted tests for the new status-bucket helpers and chart click wiring.
5. Run the relevant tests, lint, build, and merge-gate validation.
