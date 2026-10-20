# Table Exports

## Export Contract

Interactive table exports prepend provenance in CSV, NDJSON, and Markdown. Producer metadata dates `asOfISO` and participating upstream generations, never browser receipt or download time. `TableExportMenu` forwards an optional nullable `sourceGenerations` map to every format without changing callers that do not provide it.

The Screener is a **mixed-source export**, not an atomic snapshot: stablecoin supply, peg summary, report cards (including mint control), stress signals and liquidity each contribute columns. Its conservative scalar As-of convention is the **oldest participating producer generation, only when all participating clocks are known**. Otherwise `asOfISO` is `unknown`; each missing clock remains null in NDJSON's `sourceGenerations` and reads `unknown` in CSV/Markdown. Each clock comes from that source's `meta.updatedAt`, so refetching cached data does not renew its generation.

Export cells preserve missing data instead of inventing values. In particular, a Screener row without a published supply exports an empty `supply_usd` cell, while an explicitly observed zero supply exports `0`. Yield leaderboard safety provenance is exported exactly as published: `live-report-card`, `cached-publish`, `default-safety`, `opportunity-safety`, or `safety-snapshot-unavailable`; an absent value exports as `unknown`.

Yield leaderboard and comparison CSVs select a shared row projection in `src/lib/yield-presentation.ts`; each keeps its existing column order and source header, and the leaderboard adds rank. Both preserve the same NR, unknown-value, qualification, and safety-provenance cells.
