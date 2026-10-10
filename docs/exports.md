# Table Exports

## Export Contract

Interactive table exports prepend provenance in CSV, NDJSON, and Markdown. `asOfISO` identifies source-data generation, not download time. Stablecoin tables also name each participating upstream generation from response metadata; missing times remain `unknown`, never browser refetch/click time. The Screener derives its as-of from participating query updates.

Export cells preserve missing data instead of inventing values. In particular, a Screener row without a published supply exports an empty `supply_usd` cell, while an explicitly observed zero supply exports `0`. Yield leaderboard safety provenance is exported exactly as published: `live-report-card`, `cached-publish`, `default-safety`, `opportunity-safety`, or `safety-snapshot-unavailable`; an absent value exports as `unknown`.
