# One-shot historical backfills

> **Agent navigation** — Read the matched section only: [Operator contract](#operator-contract) · [Transport safety](#transport-safety) · [Interruption and cleanup](#interruption-and-cleanup) · [Classification evidence](#classification-evidence) · [Supply history](#backfill-supply-history) · [PSI history](#backfill-stability-index) · [Depeg replay](#backfill-depegs) · [Depeg audit](#audit-depeg-history) · [CG prices](#backfill-cg-prices) · [Yield history](#backfill-yield-history) · [Mint/burn ingestion](#backfill-mint-burn) · [Mint/burn prices](#backfill-mint-burn-prices) · [Roundtrip reclassification](#reclassify-atomic-roundtrips) · [TAPE](#backfill-tape) · [Blacklist balances](#backfill-blacklist-current-balances) · [JLTXX capture](#bootstrap-jltxx-reserves).

These operator jobs run outside the deployed Worker. Their former HTTP routes are unregistered (authenticated requests return 404); they are not admin dashboard actions. Recurring repairs remain in the Worker.

## Operator contract

Run from the repository root using the same Wrangler-authenticated remote D1 client as `worker/scripts/export-safety-score-capture-archive.ts`:

```bash
npx tsx worker/scripts/one-shot-backfill.ts <job> --query 'key=value&key=value' --execute
```

Default database is `stablecoin-db`, default target is remote; `--database <name>` and `--local` select an explicit alternative. This is an operator command, not a deployment step. Export provider credentials (`COINGECKO_API_KEY`, `ALCHEMY_API_KEY`, `DRPC_API_KEY`) from the secure credential source as required; never put them in query parameters or shell history. Wrangler authentication replaces Cloudflare Access HTTP authentication.

`--query` retains the documented parameter spelling, values, repeated keys and continuation cursors. `--body-json` retains optional body/query precedence where supported. `--method GET` is accepted only for audit previews; otherwise POST is the default. The CLI writes the unchanged job response body plus a final newline and exits nonzero on a non-2xx response. Save the output receipt and review embedded `errors`, `done`, `continuationCursor`, `hasMore` and any unavailable-input diagnostics before continuing: a successful process exit does not certify complete historical coverage.

Live operation requires `--execute`. Without it only an explicit supported preview query is accepted: `dry-run=true` for depegs, PSI, depeg audit, mint/burn prices or TAPE; `dryRun=true` for blacklist balances. Supply, CG prices, ingestion, yield history, roundtrip reclassification and staged reserve capture have no dry-run mode. Never assume an ignored parameter makes a command read-only.

Before writing, record the exact scope, schema/release identity, a fresh D1 Time Travel bookmark and the prior rows needed for reconciliation. Use bounded windows/batches and run one operator job at a time. Existing algorithm leases and guarded publication checks are retained, but there is no HTTP idempotency reservation or automatic replay. `--idempotency-key` is a run identity for live price repair and staged capture, not a generic retry guarantee. On interruption reconcile committed rows before explicitly resuming; do not blindly retry a destructive replay. No migration or deletion of product tables is part of this cutover.

## Transport safety

Ordinary jobs (`backfill-supply-history`, `backfill-cg-prices`, `backfill-yield-history`, `backfill-tape`) use `wrangler d1 execute --command --json`, not D1 file imports. Each write is followed by `SELECT changes()` in the same command; batches of independent writes run sequentially. Earlier commands can commit before a later failure: there is **no cross-command rollback**, no automatic retry and no import-induced availability outage. Ordinary query contention/latency still applies. A DDL receipt records zero, not the stale count from the preceding DML.

The Node D1 codec admits every query envelope, including all entries under supported Wrangler `result` wrappers, before the facade consumes rows or receipts. Failed/error envelopes, unknown objects and malformed/empty envelope containers abort; only a recognized `results: []` is empty evidence. Full metadata survives decoding. The backfill facade additionally requires explicit success, metadata and the exact expected statement-envelope count; ordered `changes()` receipts and atomic-import consent remain mandatory. A successful neighboring statement never masks a failed read or receipt.

The atomic jobs listed below (owned by `ATOMIC_IMPORT_BACKFILL_JOBS` in `worker/scripts/one-shot-backfill.ts`) require **`--execute --allow-atomic-import`** for live writes, including with `--local`:

| Job | Atomic boundary that must not be split |
| --- | --- |
| `backfill-depegs` | Delete overlapping historical events plus the first replacement chunk. Later chunks and provenance receipts retain their existing bounded batches. |
| `backfill-stability-index` | Scratch-table publication: delete/insert replacement of the selected PSI history. |
| `audit-depeg-history` | Provenance/event changes and available historical PSI repair in the same commit. |
| `backfill-mint-burn` | Per-hour aggregate delete/insert pairs before advancing the safe ingestion cursor. |
| `backfill-mint-burn-prices` | Per-hour aggregate replacement before repaired rows are finalized/read back. |
| `reclassify-atomic-roundtrips` | Per-hour aggregate delete/insert pairs after reclassification. |
| `bootstrap-jltxx-reserves` | Fenced composition/state/history publication under the live reserve lease. |
| `backfill-blacklist-current-balances` | Conditional Tron address-alias canonicalization plus alias deletion in one batch; the job-level gate applies even to non-Tron scopes. |

Only those jobs accept `--allow-atomic-import`; previews reject it and do not import. Single-statement writes use commands even in the atomic lane. Multi-statement batches in the atomic lane use one **unchunked** `--file` import for each existing algorithm batch, not one transaction for the whole job. Do not split a destructive batch to avoid the gate. Schedule these jobs in a coordinated maintenance window: [Wrangler's remote import implementation](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.129.0/packages/wrangler/src/d1/execute.ts) warns that **D1 may be unavailable to the live Worker during import**. The flag explicitly acknowledges that impact; `--execute` alone is insufficient. A completed import commits atomically, but killing the operator process or losing the response does not prove rollback.

Wrangler remote imports return a single aggregate envelope, not one result per SQL statement. Each import creates a unique `_pharos_backfill_<32 lowercase hex digits>` receipt table and records ordered per-write `changes()` inside the same import. The facade reads and validates that table before dropping it with a command. Aggregate import `meta.changes` includes receipt inserts and is never used as an algorithm's row count. Actual `RETURNING` writes and mixed read/write batches are rejected; quoted literals/identifiers and comments containing those words are not rejected. Read-only `SELECT` batches (including TAPE static-projector probes) always use sequential commands and never create receipt tables; they are not a transactional snapshot.
SQL binding and write validation share the same quoted-token pattern, including doubled-backtick identifiers. Question marks, semicolons, and `RETURNING` inside those identifiers remain identifier text rather than parameters or executable SQL.

## Interruption and cleanup

1. Stop other operator jobs and reconcile the saved response, exact command scope, provider evidence and authoritative product rows. Inspect continuation/frontier/run records before resuming. Atomic batches are not a whole-job transaction; even a confirmed failed import says nothing about earlier committed batches.
2. A failed import response, receipt readback or receipt drop is an **unknown-outcome** boundary. The transport preserves receipt evidence and names the exact table in its error; the CLI exits nonzero even if the historical handler catches that error and returns a success-shaped body. Do not trust a legacy “no changes committed” claim when stderr reports an unknown atomic outcome. A hard process kill may leave a receipt without emitting its name.
3. After confirming the process/import is no longer active, discover orphan candidates with a **read-only command** (run from `worker/`; substitute the same database and target used for the job):

   ```bash
   npx wrangler d1 execute stablecoin-db --remote --command "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB '_pharos_backfill_*' ORDER BY name;" --json
   ```

4. Validate each name against `^_pharos_backfill_[a-f0-9]{32}$`; never interpolate untrusted names or issue wildcard drops. Read and save `SELECT ordinal, changed FROM <exact-receipt-table> ORDER BY ordinal;` with `--command --json`. A present complete receipt proves its import's writes committed, not that the whole job completed; no receipt is not proof of no writes (successful cleanup may already have removed it). Reconcile against product rows and the pre-run bookmark.
5. Only after evidence is saved and outcomes reconciled, remove that **one exact receipt table** with `--command "DROP TABLE <exact-receipt-table>;" --json` on the original target. Do not drop product tables or unrelated scratch state. PSI's `stability_index_rebuild` has its own algorithm cleanup/lease; treat leftover scratch rows separately, never publish them by hand. Allow retained algorithm leases to expire or follow their owning reconciliation procedure; do not delete lease rows merely to force a retry.

These Wrangler examples are operator instructions, not checks to run during implementation. The CLI removes local temporary SQL directories on ordinary completion/failure, but cannot guarantee cleanup after SIGKILL; local temp-directory cleanup does not remove committed remote receipts.


## Classification evidence

`ONE_SHOT_BACKFILL_JOBS` and `ATOMIC_IMPORT_BACKFILL_JOBS` in `worker/scripts/one-shot-backfill.ts` own the job/transport inventory. Recurring repairs stay deployed; shared historical-price, extraction and day-window libraries remain shared runtime code. This runbook is an operating contract, not proof that historical repairs completed.

## backfill-blacklist-current-balances

Admin-only one-shot backfill job for `blacklist_current_balances`, intended for blacklist configs whose historical events were ingested before the current-balance cache existed.

**Transport:** operator CLI; see the operator contract above.

**Run identity:** optional `--idempotency-key`; there is no HTTP reservation or automatic replay.

**Query parameters**

| Param        | Type      | Default | Description                                                                                   |
| ------------ | --------- | ------- | --------------------------------------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | Optional uppercase symbol filter; only configs whose `stablecoinId` is active are eligible |
| `chainId`    | `string`  | —       | Optional chain filter matching the blacklist contract config `chainId`                        |
| `limit`      | `integer` | `500`   | Max newest canonical addresses per config (`2000` max); retain their transition history |
| `dryRun`     | `"true"`  | —       | Preview the execution snapshot fold, including retained freezes after releases; unconfirmed Tron order is withheld |

`400` is returned when the filters match no configured blacklist contracts.

**Response:** both modes return `ok`, `dryRun`, per-config identity (`configKey`, `stablecoin`, `chainId`) and `candidateCount`/`updated`/`deleted`/`failed`, matching `totals` and `budgetUsed`/`budgetLimit`. Preview has no writes (zero updated/deleted and request budget); write mode reports actual committed/failed work. A successful process exit does not erase per-config failures.

## bootstrap-jltxx-reserves

```bash
npx tsx worker/scripts/one-shot-backfill.ts bootstrap-jltxx-reserves --execute --allow-atomic-import --idempotency-key '<unique-capture-intent>'
```

No query/body/config/RPC/coin/admission overrides are accepted. The fixed quarantined JLTXX allowlist uses `jpmorgan-nav`, pinned native shares, ordinary `sync-live-reserves` lease, finite cancellation/deadline and connection budget. Captured state/composition source, attempt, fingerprint and success clocks must match on readback. The result always retains `admissionAllowed=false` and `runtimePriceMarketcapPass=false`: this command cannot activate the asset or publish scores. See [live reserve capture policy](../process/live-reserves-appendix.md).

## backfill-depegs

Backfills historical depeg events from stored price data.

For coins with a registered authoritative historical price provider, the backfill uses that same provider family first (for example, replayed protocol redemption quotes) before falling back to market history. If the authoritative provider is configured but unavailable, existing `source='backfill'` rows for that coin are preserved instead of being rebuilt from a weaker source.

Supported non-USD fiat assets now prefer direct CoinGecko native-fiat history first and compare that series to the native `1.0` peg before they fall back to USD-denominated CoinGecko/DefiLlama history plus historical FX. In that native-fiat mode, backfill uses daily points plus a two-point confirmation window across 36 hours, while still preserving extreme single-point crashes of `>= 5000 bps`.

`dry-run=true` compares the freshly replayed historical events against the currently stored `source='backfill'` rows without mutating the database. The preview reports whether the replay exactly matches the stored backfill rows, how many stored backfill rows would be removed, how many replayed rows would be added, and the current live-row counts for the same asset.

Bounded replay windows also support `startDay` / `endDay`, plus optional `contextDays` to widen the replay pad around that UTC window. This makes long-history audits and repairs practical through bounded CLI invocations without waiting for a full-coin rebuild. In mutating mode, bounded replays only replace overlapping `source='backfill'` rows for that coin and preserve non-overlapping backfill rows plus all `source='live'` rows.
For commodity-pegged assets, bounded replays limit the peer-median reference fetch to the replay pad and only fetch the needed gold or silver source family.

**Query parameters**

| Param         | Type                               | Default | Description                                                           |
| ------------- | ---------------------------------- | ------- | --------------------------------------------------------------------- |
| `stablecoin`  | `string`                           | —       | Process a single stablecoin ID                                        |
| `batch`       | `integer`                          | `0`     | Batch offset (3 coins per batch)                                      |
| `dry-run`     | `"true"`                           | —       | Preview replay-vs-backfill differences without writing `depeg_events` |
| `startDay`    | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for bounded replay compare/mutation                       |
| `endDay`      | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for bounded replay compare/mutation                       |
| `contextDays` | `integer`                          | `7`     | Extra replay context days on each side of a bounded window (max `90`) |

Epoch text requires unsigned integer digits or calendar-valid ISO date/date-time text; signed/decimal tokens and rollover dates such as February 30 are rejected before repair-window selection.

## backfill-supply-history

Backfills per-coin supply history snapshots. When historical market-price series are available, the job also persists daily `supply_history.price` values on restored rows so historical PSI replay can use day-level deviation instead of blunt peak fallback.

DefiLlama detail history preserves complete observed zero circulation, inserting missing days or replacing prior positive rows. Native non-USD zero needs no USD valuation and may carry `price: null`; positive native observations still require historical valuation or the explicitly enabled recent-window emergency fallback. Missing, empty or malformed circulating buckets never become zero and leave existing history unchanged.

Commodity/CoinGecko history pairs prices and caps at the same timestamp, selecting the first valid pair per UTC day. Missing caps may use historical EVM `totalSupply()` at day close only for a complete roster containing exactly one canonically supported EVM deployment; mixed-family/multi-deployment rosters fail closed with `unsupported-complete-roster`. Current supply is never projected backward. Protocol-TVL fallback stores `price: null` outside returned price-chart coverage rather than extrapolating jobs.

Protocol-TVL fallback additionally requires a commodity peg and a dedicated token slug admitted by `shared/lib/commodity-protocols.ts`. Both the protocol market cap and latest TVL must be finite and strictly positive, with their market-cap/TVL ratio in the inclusive `0.85`–`1.15` band. Missing or unusable equivalence evidence returns an explicit error without replacing history. An admitted fallback stores historical TVL points, not today's market cap or current supply projected backward; non-finite/nonpositive historical TVL points are withheld.

**Query parameters**

| Param                           | Type                               | Default | Description                                                                               |
| ------------------------------- | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `stablecoin`                    | `string`                           | —       | Process a single stablecoin ID                                                            |
| `batch`                         | `integer`                          | `0`     | Batch offset for chunked processing                                                       |
| `batchSize`                     | `integer`                          | `10`    | Coins per batch                                                                           |
| `allow-constant-price-fallback` | `"true"`                           | —       | Allow current-price fallback when historical non-USD prices are missing                   |
| `startDay`                      | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for UTC daily rows written                                                    |
| `endDay`                        | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for UTC daily rows written; future values clamp to the last completed UTC day |
| `windowDays`                    | `integer`                          | `30` when windowed | Window size (`1`–`90`); explicit values persist through cursors. Omitting all window/cursor/date parameters processes unbounded history. |
| `cursor`                        | `string`                           | —       | Opaque continuation cursor; cursor-only requests resume the stored window size, while an explicit `windowDays` overrides and persists a new size |

## backfill-stability-index

Backfills historical stability index scores from stored depeg events and supply data.

The rebuild stops at the last completed UTC day and preserves a stored day when archival inputs are unavailable. Denominators include only core stablecoins, cash equivalents and PSI historical assets; other classes retain history without contributing. Historical replay uses overlapping events and the as-of supply/price and start-day-versus-later-day severity rules in [Stability Index](../stability-index.md). Repair available historical price coverage before rerunning, including PSI historical assets; absent source series are never manufactured. Methodology `v3.0+` derives daily stress breadth from core-universe historical warning bands. The response names evaluated `startDay`/`endDay`.

The replay supply window includes the full 21-day lookback needed by target/prior-week as-of admission. Trend compares paired identities only. The response's additive `unavailableDays` entries contain `{ day, reason, trendUnavailableIds }`; `trend-inputs-unavailable` and required-v3 `dews-archive-unavailable` preserve the previously stored day rather than publish neutral components. An observed all-CALM archive still yields measured zero stress.

**Query parameters**

| Param      | Type                               | Default                | Description                                                                      |
| ---------- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `dry-run`  | `"true"`                           | —                      | Preview the rebuild window and change summary without mutating `stability_index` |
| `startDay` | `integer \| ISO date (YYYY-MM-DD)` | earliest depeg day     | Lower bound for rebuilt UTC days                                                 |
| `endDay`   | `integer \| ISO date (YYYY-MM-DD)` | last completed UTC day | Upper bound for rebuilt UTC days                                                 |

## backfill-cg-prices

Backfills market prices for the PSI-eligible universe, including off-catalog historical assets such as `ust-terra`. It fills NULL `supply_history.price` gaps and inserts missing daily supply rows only when upstream market-cap history exists.

**Query parameters**

| Param        | Type      | Default | Description                         |
| ------------ | --------- | ------- | ----------------------------------- |
| `stablecoin` | `string`  | —       | Process a single stablecoin ID      |
| `batchSize`  | `integer` | `10`    | Coins per batch                     |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing |

## backfill-yield-history

Backfills protocol API yield-history rows for the curated `TARGET_YIELD_HISTORY_SOURCES` in `worker/scripts/backfills/backfill-yield-history.ts`; consult that table for supported IDs and source keys.

**Query parameters**

| Param        | Type      | Default | Description                              |
| ------------ | --------- | ------- | ---------------------------------------- |
| `stablecoin` | `string`  | —       | Process a single supported stablecoin ID |
| `batchSize`  | `integer` | `10`    | Coins per batch                          |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing      |

## backfill-tape

Runs the same TAPE projectors as `project-tape` with operator window/limit overrides. Writes are idempotent on `(source_table, source_row_id, transition)`. `depeg.peak_worsened` filters open rows by `started_at` and scans pages of 500 up to `maxRows`; the CLI defaults to 5000, while the uncapped cron scans all matches. `methodology.bumped`, `cemetery.entry.added`, and `lifecycle.tracked.frozen` ignore `since`, `until`, and `maxRows`: they scan static sources keyed by ID.

**Request body or query parameters**

Query parameters win when the same field is supplied in both places.

| Param     | Type      | Default | Description                                                            |
| --------- | --------- | ------- | ---------------------------------------------------------------------- |
| `class`   | `string`  | all     | Query-only repeatable projector filter, for example `class=depeg.opened` |
| `since`   | `integer` | none    | Lower source-row timestamp bound in Unix seconds                       |
| `until`   | `integer` | none    | Upper source-row timestamp bound in Unix seconds                       |
| `maxRows` | `integer` | `5000`  | Per-class scan cap, min `1`, max `50000`                               |
| `dryRun`  | `boolean` | `false` | Compute results without writing rows or advancing projector watermarks |
| `dry-run` | `boolean` | `false` | Query/body alias for `dryRun`                                          |

Supported classes come from `TAPE_PROJECTOR_JOBS` in `worker/src/lib/tape-projectors/registry.ts`. `dews.band_transitions` emits both `dews.escalated` and `dews.deescalated` events. `depeg.resolved` projects only recovery-backed closures, not coverage-loss, orphan, or superseded-direction terminal rows.

For every selected blind class, the response `ignoredParams` map lists the ignored fields (`since`, `until`, and `maxRows`). Other classes honor all supplied window and cap parameters.

**Response**

```json
{
  "ok": true,
  "dryRun": false,
  "maxRows": 5000,
  "since": null,
  "until": null,
  "selectedClasses": ["depeg.opened"],
  "ignoredParams": {},
  "projected": 12,
  "perClass": { "depeg.opened": 12 },
  "errors": []
}
```

**Error responses:** `400` for unknown `class` values, invalid negative timestamps, `since > until`, or `maxRows` outside `1..50000`.

## backfill-mint-burn-prices

Repairs bounded historical mint/burn NULL-USD debt using exact event-day evidence. The job defaults to `dry-run=true`, accepts `limit=1..500` (default `100`) and optional `stablecoin=<id>`, and never uses current `price_cache` or an adjacent-day price. Source order is exact-day `supply_history`, CoinGecko historical market chart, DefiLlama CoinGecko-identity chart, then an exact configured contract chart. DefiLlama spans are loaded sequentially in up to eight 800-day windows per identity; points are merged before event-day resolution, and an over-budget range or unavailable window keeps unresolved rows retryable rather than falsely irreducible.

Mutation requires `dry-run=false&confirm=historical-mint-prices&bookmark=<fresh-d1-bookmark>` plus an `--idempotency-key` argument from 1 to 128 trimmed characters. The bookmark and idempotency key are persisted on every attempted row. Rows without a valid point after definitive source responses become explicitly `irreducible`; transient provider failures remain retryable. Recovered rows are finalized only after `mint_burn_hourly` is rebuilt and verified against source events. `retry-irreducible=true` is reserved for reopening classifications after source coverage improves.

Cron `sync-mint-burn` automatically heals recent NULL-price events within a 48-hour window and reports the healed count in cron metadata as `nullPricesHealed`; this job is primarily for historical backfills beyond that window.

**Response**

```json
{
  "dryRun": true,
  "limit": 100,
  "selected": 1,
  "recovered": 1,
  "classifiedIrreducible": 0,
  "deferredForRetry": 0,
  "aggregateCoinsRebuilt": ["ustb-superstate"],
  "aggregateVerificationPassed": null,
  "dispositions": [
    {
      "eventId": "ethereum-0xabc-0",
      "stablecoinId": "ustb-superstate",
      "chainId": "ethereum",
      "timestamp": 1740279479,
      "disposition": "recover",
      "price": 10.58,
      "priceTimestamp": 1740272109,
      "priceSource": "repair:defillama-gecko-chart-event-day:superstate-short-duration-us-government-securities-fund-ustb",
      "reason": null
    }
  ],
  "backlog": {
    "unclassified": 529,
    "irreducible": 0,
    "pendingAggregate": 0,
    "totalNullUsd": 529
  }
}
```

## backfill-mint-burn

Backfills mint/burn event ingestion for a specific EVM contract config using the same parsing/classification pipeline as the cron.
If `configKey` is omitted, the job auto-selects one tracked EVM config using a critical-first / major-symbol-first / most-behind policy and returns the selected config in the response. Tron uses scheduled pending-admission catch-up, with no pre-activation bootstrap requirement. Explicit Tron selection returns HTTP `400` with `mint-burn-operator-chain-unsupported: tron` before credential checks, provider reads or D1 selection writes; this operator path does not ingest Tron.

**Request body or query parameters**

| Param       | Type      | Default         | Description                                                                              |
| ----------- | --------- | --------------- | ---------------------------------------------------------------------------------------- |
| `configKey` | `string`  | auto-selected   | Optional config key: `{chainId}-{contractAddress}` across the tracked EVM issuance-chain set |
| `fromBlock` | `integer` | from sync state | Start block override                                                                     |
| `toBlock`   | `integer` | finalized head  | End block override (clamped to the validated chain-specific finalized head)              |
| `chunkSize` | `integer` | `50000`         | Block span per fetch chunk (max 50000)                                                   |
| `maxChunks` | `integer` | `24`            | Maximum chunks to process per request                                                    |

Successful chunks materialize hours before committing a safe cursor. Both eventful and quiet chunks advance through the complete requested range capped to CHAIN's validated `finalized` header; explicit historical chunks retain full-range advancement below that ceiling. A missing, refused or unsupported finalized head returns `502` with `finality-head-unavailable: <chain>`, without tip fallback or ingestion writes. `done`/`nextFromBlock` reflect committed finalized coverage, not the provisional tip; a later request can resume when finality advances.

Decode failures count in `rowsDropped` and `rowsDroppedDecode`; valid peers persist while the cursor holds below `earliestDecodeFailureBlock`. Shared per-log retries quarantine on observation three (`rowsQuarantinedDecode`, `decodeQuarantines[]`, reason `amount-decode-retry-exhausted`), then release the frontier. A held chunk ends the request; retry with a new observation.

## reclassify-atomic-roundtrips

Retroactively reclassifies `(tx_hash, stablecoin_id, chain_id)` groups using the shared amount-match tolerance. Apply migration `0280_mint_burn_dirty_hours.sql` and the compatible maintenance writers/drain before running this job; production writes still require a coordinated maintenance window and `--execute --allow-atomic-import`.

Every tag update atomically enqueues all matching source hours in `mint_burn_dirty_hours`, including hours beyond the discovery group's earliest timestamp. Source writes use bounded atomic batches; they are not one whole-job transaction. The job drains persisted debt on entry and after both passes, independently of `since` and `stablecoinId`, so an interrupted run is repairable even when its changed transactions no longer match either scan. Each shared drain atomically rebuilds current hourly totals, finalizes eligible priced `pending_aggregate` repairs and removes that hour's debt. A concurrent mutation either enters that rebuild or leaves fresh debt afterward; it is never cleared against a stale pre-read aggregate.

After any failure, reconcile uncertain atomic-import receipts using [Interruption and cleanup](#interruption-and-cleanup) before an explicitly authorized retry. Keep every dirty-hour row and the additive table through code rollback; do not manually delete debt or rely on process cleanup to repair aggregates.

**Query parameters**

| Param          | Type      | Default         | Description                                                                                                                                 |
| -------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`        | `integer` | `now - 90 days` | Unix seconds cutoff for both forward and reverse scans; `0` requests a full-table sweep and may exceed D1 CPU limits without `stablecoinId` |
| `stablecoinId` | `string`  | —               | Optional Pharos stablecoin ID filter applied to both scans                                                                                  |

**Response**

```json
{
  "done": false,
  "since": 1765218367,
  "stablecoinId": "usdt-tether",
  "updated": 428,
  "toRoundtrip": 420,
  "toStandard": 8,
  "hoursRecalculated": 31,
  "batchSize": 1000
}
```

Each forward and reverse pass processes up to 1000 `(tx_hash, stablecoin_id, chain_id)` groups. Repeat until `done=true`: both scans must return fewer than 1000 groups and the final durable-debt read must be empty. Entry/exit drains process bounded chunks until the selected backlog is exhausted; `hoursRecalculated` counts completed hour rebuilds, including debt from prior runs and other discovery scopes, rather than newly changed transaction groups. A failed read, write or rebuild fails the job, not an empty-success response. New debt observed after the final drain keeps `done=false` for the next run.

## audit-depeg-history

`--method GET` supports only `dry-run=true`; mutations use default POST. Shared audit/repair parameters are below. The default CoinGecko audit uses `COINGECKO_API_KEY`, the Pro host and `x-cg-pro-api-key`, 200 ms start spacing and concurrency 4. Missing key attempts no upstream request: HTTP 200 retains `upstreamErrorReason: "coingecko_api_key_missing"`, `upstreamReachable: false`, per-event `verdict: "error"` and no persisted provenance. Delete and both repair modes skip CoinGecko and need no key.

Historical samples must have an array `prices` envelope and two-member tuples with nonnegative safe-integer millisecond clocks inside the inclusive requested window (`started_at - 1h` through `ended_at + 1h`). Clock/tuple rejections increment `rejectedByTimestampCount` before price validation; valid in-window peg-par samples retain a measured zero deviation. A malformed envelope or a nonempty series containing only rejected clocks yields `error`, with no provenance for that event; an empty or price-validation-rejected series retains `no_data`. No source substitution or automatic historical-verdict rewrite is performed.

With `min-supply > 0`, `totalMatching` counts only symbol-matching events whose nearest observed supply within the existing inclusive 30-day tolerance meets the threshold. `belowMinSupplyExcludedCount` counts measured exclusions, including observed zero. Missing or too-distant history stays unavailable and fails admission: `unavailableSupplyExcludedCount` covers the full pre-pagination cohort, while `unavailableSupplyExclusions` retains at most 25 event identities (`id`, `stablecoinId`, `symbol`, `startedAt`) and `history-missing` / `history-outside-tolerance` reasons; `unavailableSupplyExclusionsTruncated` identifies omitted details. With no minimum-supply filter these diagnostics remain zero/empty; no current-supply substitution is used.

```json
{
  "totalMatching": 5,
  "unavailableSupplyExcludedCount": 0,
  "unavailableSupplyExclusions": [],
  "unavailableSupplyExclusionsTruncated": false,
  "belowMinSupplyExcludedCount": 0,
  "offset": 0,
  "limit": 25,
  "dryRun": true,
  "auditedEvents": [
    { "id": 49235, "symbol": "USN", "startedAt": 1759849487, "verdict": "error" }
  ],
  "falsePositivesFound": 0,
  "deletedEvents": [],
  "daysRecomputed": 0,
  "rejectedByValidationCount": 0,
  "rejectedByTimestampCount": 0,
  "upstreamErrorCount": 5,
  "upstreamReachable": false,
  "upstreamErrorReason": "coingecko_api_key_missing"
}
```

The audit can only rule on episodes whose stored move CoinGecko's own history does not reproduce, so a CoinGecko-derived price-feed artifact looks `confirmed` to it by construction. Removing those artifacts is a reviewed operator decision recorded in the backfill replay-suppression registry, not an audit verdict — see [Depeg Artifact-Event Removal](../runbooks/depeg-artifact-removal.md).

**Query parameters**

| Param        | Type                                                   | Default  | Description                                                                                                                 |
| ------------ | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `limit`      | `integer`                                              | `25`     | Max events or repair candidates to inspect per request (`max 25`)                                                           |
| `offset`     | `integer`                                              | `0`      | Pagination offset                                                                                                           |
| `dry-run`    | `"true"`                                               | GET required; POST optional | Preview only; POST without it may mutate |
| `min-supply` | `integer`                                              | `0`      | Minimum audit supply (USD) |
| `symbol`     | `string`                                               | —        | Case-insensitive filter |
| `repair`     | `"synthetic-splits" \| "contradictory-recovery-price"` | —        | Preview or execute the selected repair instead of CG audit |
| `delete`     | `string`                                               | —        | POST-only comma-separated exact IDs; skips CG audit; `dry-run=true` previews deletion |

### Live audit and repair

POST executes the audit or selected delete/repair using the shared parameters and provider/unavailable-evidence rules above.

`--query 'repair=synthetic-splits'` instead runs a historical repair pass that consolidates adjacent same-direction events when either:

- a live event was split by the retired DEX-only auto-close behavior after the earlier row closed near peg, or
- a backfill row ended without recovery and a live row resumed the same severe move within one sync gap because the historical replay window expired mid-event.

When a repair group ends in a live row, the live tail is kept as the canonical record and inherits the earlier start plus worst peak so future backfills do not recreate the split.

`--query 'repair=contradictory-recovery-price'` instead nulls ended-event `recovery_price` values that still sit outside the permitted depeg threshold. This is the bounded repair path for legacy rows closed by a native-quote recovery while the stored USD price still looked depegged.

Mutating delete/synthetic-repair runs and audit eligibility changes stage available PSI stability-index repairs into the same D1 batch commit. The canonical historical replay receives the post-audit event universe: invalidated events leave it and restored eligible events re-enter it. Supply prices, native quote-domain evidence and same-day DEWS archive rows match bounded backfill. Missing replay inputs retain the existing PSI day and log the named unavailable reason without inflating `daysRecomputed`. If the atomic provenance/mutation-plus-PSI commit fails, the job returns `500` with a specific error and leaves both provenance/events and PSI unchanged.

`GET` is accepted only with `dry-run=true`; mutating audits require `POST`.
