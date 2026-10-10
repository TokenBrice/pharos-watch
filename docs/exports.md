# Table Exports

## Export Contract

Interactive table exports prepend provenance in CSV, NDJSON, and Markdown. Stablecoin CSVs use producer metadata for `asOfISO` and each participating upstream generation; missing times stay `unknown`. The Screener instead stamps `asOfISO` with the latest participating query update (client receipt time), not a source-data generation or download time.

Export cells preserve missing data instead of inventing values. In particular, a Screener row without a published supply exports an empty `supply_usd` cell, while an explicitly observed zero supply exports `0`. Yield leaderboard safety provenance is exported exactly as published: `live-report-card`, `cached-publish`, `default-safety`, `opportunity-safety`, or `safety-snapshot-unavailable`; an absent value exports as `unknown`.

Yield leaderboard and comparison CSVs select a shared row projection in `src/lib/yield-presentation.ts`; each keeps its existing column order and source header, and the leaderboard adds rank. Both preserve the same NR, unknown-value, qualification, and safety-provenance cells.
