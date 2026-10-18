# Timeline Page

Public `/timeline/` is the cross-class event feed. Internal tape names remain (`tape_events`, `TAPE_PROJECTOR_JOBS`, `src/components/tape/`). Preserve `/tape/` redirects and query strings, including event/coin/type permalinks. Dedicated depeg, freeze, flow and safety trackers remain canonical single-class surfaces.

## Route Shape

`src/app/timeline/page.tsx` owns shell/metadata, client/controller modules feed state, and `src/components/tape/` controls/cards. `src/lib/tape-digest.ts`, `tape-collapse.ts` and `tape-derive.ts` own grouping/public labels. `GET /api/events` is the dataset, via browser same-origin `/_site-data/events`.

The route metadata is canonical `/timeline/`, static `og-timeline.png`, noindex/follow and omitted from sitemap/public route inventory. It keeps navigation and per-class links; there is no dynamic Timeline OG handler. Indexable trackers, coin pages and homepage provide search entrypoints.

## Visual Identity

The [Tape special](./design-language.md#tape-special) pointer delegates the route exception here: flat wire-service/terminal stream, dominant core mono, hairline grouping, no rounded `pharos-card-shell` around events/day groups/open band/pinned block/empty state. Shared sans pill controls are the exception. Class tints use `src/lib/tape-class-style.ts`; severity stays text colour, not a risk fill or left rail. Do not harmonize this into analytics cards unless explicitly retiring the treatment. Time/day labels use UTC; compact relative times retain absolute `<time>` metadata. Stored machine reason keys/chain IDs must pass through public formatters, not leak into copy.

## URL Filter Contract

`TIMELINE_URL_SCHEMA` and shared URL codec own validation/defaults for type, severity, coin, peg, chain, window, search and event target. Types allow exact and prefix wildcard; canonical coin/chain/peg registries own IDs. Defaults are omitted; clearing restores them. `alltime` is canonical and legacy `all` remains accepted. `notice+` is the default floor; Info drops it. Search is debounced/server-side. Default omission must not lose decoded severity/peg/chain/window values.

An event permalink may be outside ordinary filters. Resolve through the bounded latest buffer, pin inside the feed even with zero normal rows, and show filtered-empty explanation separately. Successful resolution scrolls, focuses and briefly highlights with reduced-motion support. Do not silently replace an unresolved target with a different event.

## API Contract

[API reference](./api-reference.md) and `worker/src/api/events.ts` own query/cursor/limit/HTTP details; route requests remain bounded. `useEvents()` is infinite-query; `useLatestEvents()` serves the homepage/permalink buffer. No duplicated wire table belongs here.

Freshness follows confirmed `project-tape` publication, not newest event time. TTL cannot exceed fresh runway; stale uses no-store/Warning 110. Missing/invalid producer history or failed freshness lookup uses no-store/Warning 199 plus named reason. Shared producer budgets/ratios own numeric windows.

Read rows must pass JSON/object and `TapeEventSchema` validation. Invalid payload/wire rows are logged with `payload-json-invalid` or `wire-schema-invalid`, counted in droppedRows and excluded while valid peers publish; never coerce corrupt JSON into an empty payload. Static-catalog dates must round-trip as valid UTC month/day dates; missing/invalid values skip/log, never become publication-time events.

## Backing Pipeline

`worker/src/cron/project-tape.ts` materializes existing producers on the scheduled DEWS/PSI lane. `TAPE_PROJECTOR_JOBS` in `worker/src/lib/tape-projectors/registry.ts` owns projector enrollment. The job is idempotent on `(source_table, source_row_id, transition)` and its projection work is D1-only. The [placed-fetch canary](./worker-infrastructure.md#project-tape-placed-fetch-canary) reserves one service-binding connection on the public driver; only project-tape delegates, and its flag-off rollback runs in-process. `TAPE_CLASSES` owns the UI roster; a class earns a chip only when its projector ships. Do not restate either registry as a second roster.

`tape_events` is a permanent product archive. Filters/cursors/windows/severity bound reads, not retention: all-time browsing, permalinks, homepage reads and DDRR review need historical events. The baseline migration owns table schema; event IDs remain `${ts_ms}-${type}-${hash8}` for permalinks.

### Source Reconciliation

Depeg open/recovery, freeze and large-flow projectors reconcile immutable source identities independent of watermark. Scheduled reconciliation uses the source-owned trailing event-time window; older repair uses explicit admin bounds (`since=0` for all history). Exclude already-projected identities/non-recovery closures before limiting. Source clocks own presentation; watermarks never regress. Freeze historical alerts retain the 24-hour recovery gate. Depeg alerts use active source episodes/exact prior episode IDs, not Tape insert IDs; backfills cannot replay historical depegs live.

Forced time seeks plus source-key existence probes bound freeze/flow candidates. Depeg opens use source start indexes; resolutions can read beyond candidate-window cost. Ties may expand result caps. Observe post-deploy rows_read over comparable windows; drain historical admin bounds separately. Static-catalog source-key probes and inserts use bounded D1-overload retry.

### Split-Scan Determinism

PYS-drop carries the last usable selected score across null generations, seeded at/before watermark with source-defined timestamp/generation tie-break. Leading gaps invent no baseline. PSI shifts use immediately preceding sample, including unchanged bands. Split invocations/batches must match one-shot identities/payloads. Capped/bounded depeg peak scans preserve unscanned baselines; only full unbounded census prunes closed events.

### Freeze Chain Repair

Canonical chain IDs belong in persisted freeze rows; display labels remain public titles/payloads. Migration `0266` and recurring repair share exact source/type/display-name predicate. Each non-dry invocation scans at most 500 existing rows per freeze type, including when no new event exists, through `idx_tape_type_ts` with persisted `(ts,id)` cursor `tape-projector:freeze-chain-repair:<type>` and wraparound. Filter after bounded page read, not full clean-archive scan. Guarded updates change chain only: no identity, payload, clock or Telegram replay.

Structured logs report scanned/repaired/continuing; settled pages repair zero. Cursor advances only after successful whole batch, including clean pages; failed pages retry. Repair failure is isolated/logged as `freeze-chain-repair-failed`, not a fresh-projection failure. Dry runs write neither chains nor cursor.

After old writers drain, retain a full sweep's counts and verify zero remaining exact-predicate rows before declaring completion. Activation alone is not completion. Old-Worker rollback can restore legacy names and suspends repair; roll forward and observe another sweep. Inserts ahead of cursor are found on the next pass regardless of watermark/event age. Operator backfills share this path.

### Published-Generation Proof

DEWS sparse scans and prior-band seed join published `surface_publication_generations`. Changes always create history rows; unchanged samples may be sparse. Failed/partial row-count generations emit no event and advance no DEWS watermark; recovery compares to the last published band. Cache pointer and ledger commit atomically, with migration/runtime reconciliation bootstrapping prior publication. A newest row alone is not publication proof.

## Behavior

The hydration-safe browser clock seeds frozen query-window anchor and ticking presentation clock together after subscription. Server/first hydration uses null clock, not `Date.now()`; ticking ages labels/freshness without sliding query bounds.

UTC-day grouping persists across infinite-page seams. `digestPage`/`mergeDigestedPages` own recap thresholds; `collapseByCoinClass` merges matching coin/chain/full-type/severity/transition, not different event types. Summary counts describe loaded feed, not the full archive. Active-open band considers source episodes with no observed recovery-backed resolution in-window and deduplicates per coin; absence of a visible recovery is not a new on-chain measurement.

First Load more enables sentinel auto-loading. Exhausted cursors get an explicit terminal footer. Empty-state widening takes the smallest applicable step: clear active filters, then lower floor, then all-time. Shared freshness/error notices retain retry and producer clocks. CRT treatment is dark-only presentation, not data state.

## SEO And Crawlability

Noindex is deliberate; do not re-add this client mount to sitemap merely because the shell emits CollectionPage and projector-class ItemList schema. Keep canonical per-class See all on Timeline links on trackers.

## Homepage Integration

The [homepage marquee](./homepage.md) reads the same dataset and ends in one View all events link. Change both owners when severity/class scope or source changes; homepage display caps are not archive statistics.

## Admin

Use `npx tsx worker/scripts/one-shot-backfill.ts backfill-tape --query 'dry-run=true'`. For older history use explicit since/until/maxRows, review dry-run output, then execute with `dry-run=false`. This is operator-only remote-D1 replay, not an HTTP/dashboard action. [Backfill command contract](./runbooks/one-shot-backfills.md#backfill-tape) owns execution details.

## Update Rules

Update source registry/UI class list, tracker deep links and focused projector/grouping/URL tests together. Changes to retention, identity, source clocks, publication proof, replay/repair bounds or rollback acceptance update this contract. API owner remains authoritative for HTTP shape. Keep the single [visual exception](#visual-identity), not an appendix or second aesthetic lock.
