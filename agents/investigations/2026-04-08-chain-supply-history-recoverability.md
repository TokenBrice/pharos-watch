# Chain Supply History Recoverability

Date: 2026-04-08
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`

## Decision

`chain_supply_history` is not safely reconstructable for pre-fix rows.

Reason:
- the writer only reads the current `stablecoins` cache row
- D1 does not retain archived historical `stablecoins` payloads
- `supply_history` and `onchain_supply` do not preserve exact historical chain-level splits needed to rebuild the table deterministically

## Current Safe Policy

- keep `chain_supply_history` out of any public UI until a post-fix baseline date
- treat rows written before the 2026-04-08 canonicalization fix as non-authoritative for charting
- if a public chain-history API is added later, enforce a start-date contract at or after the post-fix baseline unless an audited export/purge plan has been completed

## Operator Steps

1. Export the current table before any cleanup:
   - `wrangler d1 execute pharos --remote --command "SELECT * FROM chain_supply_history ORDER BY snapshot_date, chain_id;"`
2. Validate the fixed writer on a cloned DB:
   - run `snapshot-chain-supply` against a staging copy
   - confirm alias/display-name inputs collapse to canonical IDs
   - confirm same-day reruns are idempotent
3. If a public history surface is approved later:
   - use the first post-fix snapshot date as the chart baseline, or
   - perform an explicit export-and-purge workflow before exposing the series

## Hidden Consumers

No live runtime consumers were found. The current product reads live chain data from:
- `GET /api/chains`
- `GET /api/stablecoins`

The table is currently written by the cron only.
