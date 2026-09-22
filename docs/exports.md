# Table Exports

## Export Contract

Interactive table exports prepend provenance in CSV, NDJSON, and Markdown. `asOfISO` records the source-data generation represented by the rows, not the time the user clicks download. The Screener derives that value from the most recent participating query update timestamp.

Export cells preserve missing data instead of inventing values. In particular, a Screener row without a published supply exports an empty `supply_usd` cell. Yield leaderboard safety provenance is exported exactly as published: `live-report-card`, `cached-publish`, `default-safety`, `opportunity-safety`, or `safety-snapshot-unavailable`; an absent value exports as `unknown`.
