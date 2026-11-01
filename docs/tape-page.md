# Timeline Page

Public `/timeline/` is the cross-class event feed. Internal tape names remain (`tape_events`, `TAPE_PROJECTOR_JOBS`, `src/components/tape/`). Preserve `/tape/` redirects and query strings, including event/coin/type permalinks. Dedicated depeg, freeze, flow and safety trackers remain canonical single-class surfaces.

## Route Shape

`src/app/timeline/page.tsx` owns shell/metadata, client/controller modules feed state, and `src/components/tape/` controls/cards. `src/lib/tape-digest.ts`, `tape-collapse.ts` and `tape-derive.ts` own grouping/public labels. `GET /api/events` is the dataset, via browser same-origin `/_site-data/events`.

The route metadata is canonical `/timeline/`, static `og-timeline.png`, noindex/follow and omitted from sitemap/public route inventory. It keeps navigation and per-class links; there is no dynamic Timeline OG handler. Indexable trackers, coin pages and homepage provide search entrypoints.

## Visual Identity

The [Tape special](./design-language.md#tape-special) pointer delegates the route exception here: flat wire-service/terminal stream, dominant core mono, hairline grouping, no rounded `pharos-card-shell` around events/day groups/open band/pinned block/empty state. Shared sans pill controls are the exception. Class tints use `src/lib/tape-class-style.ts`; severity stays text colour, not a risk fill or left rail. Do not harmonize this into analytics cards unless explicitly retiring the treatment. Time/day labels use UTC; compact relative times retain absolute `<time>` metadata. Stored machine reason keys/chain IDs must pass through public formatters, not leak into copy.

## URL Filter Contract

`TIMELINE_URL_SCHEMA` and shared URL codec own validation/defaults for type, severity, coin, peg, chain, window, search and event target. Types allow exact and prefix wildcard; canonical coin/chain/peg registries own IDs. Defaults are omitted; clearing restores them. `alltime` is canonical and legacy `all` remains accepted. `notice+` is the default floor; Info drops it. Search is debounced/server-side. Default omission must not lose decoded severity/peg/chain/window values.

An event permalink may be outside ordinary filters. Resolve a loaded-feed miss through the exact `event` API query, pin inside the feed even with zero normal rows, and show filtered-empty explanation separately. Successful resolution scrolls, focuses and briefly highlights with reduced-motion support. Retracted freeze claims return `404` with reason `freeze-claim-retracted`, never an empty event or a substitute target.

## API Contract

[API reference](./api-reference.md) and `worker/src/api/events.ts` own query/cursor/limit/HTTP details; route requests remain bounded. `useEvents()` is infinite-query; `useLatestEvents()` serves homepage lists and exact permalink lookups. No duplicated wire table belongs here.

Freshness follows confirmed `project-tape` publication, not newest event time. A fully settled projection pass confirms publication even when it inserts no events; a failed class does not. TTL cannot exceed fresh runway; stale uses no-store/Warning 110. Missing/invalid producer history or failed freshness lookup uses no-store/Warning 199 plus named reason. Shared producer budgets/ratios own numeric windows.

Read rows must pass JSON/object and `TapeEventSchema` validation. Invalid payload/wire rows are logged with `payload-json-invalid` or `wire-schema-invalid`, counted in droppedRows and excluded while valid peers publish; never coerce corrupt JSON into an empty payload. Static-catalog dates must round-trip as valid UTC month/day dates; missing/invalid values skip/log, never become publication-time events.

## Backing Pipeline

`worker/src/cron/project-tape.ts` materializes existing producers on the scheduled DEWS/PSI lane. `TAPE_PROJECTOR_JOBS` in `worker/src/lib/tape-projectors/registry.ts` owns projector enrollment. The job is idempotent on `(source_table, source_row_id, transition)` and its projection work is D1-only. The [placed-fetch canary](./worker-infrastructure.md#project-tape-placed-fetch-canary) reserves one service-binding connection on the public driver; only project-tape delegates, and its flag-off rollback runs in-process. `TAPE_CLASSES` owns the UI roster; a class earns a chip only when its projector ships. Do not restate either registry as a second roster.

`tape_events` is a permanent product archive. Filters/cursors/windows/severity bound reads, not retention: all-time browsing, permalinks, homepage reads and DDRR review need historical events. The baseline migration owns table schema; event IDs remain `${ts_ms}-${type}-${hash8}` for permalinks.

Peak-worsened observations are insert-if-absent on their source key: identical-peak replay retains the first permalink, numeric ingestion ID, observation timestamp, creation time and payload. A genuinely larger peak has a distinct source identity. Freeze amount corrections retain those same identity/clock fields through guarded updates; other event classes retain source-correction replacement behavior.

Historical flow, yield and DEWS events use the persisted source methodology identity where the source retains it, otherwise the domain registry at the source timestamp, never the projector's current version. Static catalogs build their authoritative source identity into each event; the shared helper only probes/inserts those events.

Archive methodology correction is a separately reviewed metadata operation, not a projector replay. First census the affected source tables/types by source-time range and stored version; compare each candidate to retained source identity or its registry epoch. Approve explicit IDs and old/new versions in bounded pages before updating only `methodology_version` with an ID/source-key/old-version guard. Retain before/after IDs, numeric ingestion IDs, timestamps, creation times and payloads and require exact equality outside that column. Do not change historical scores, thresholds, watermarks or alert state, and never blanket-replay the archive to repair metadata.

### Source Reconciliation

Since mint/burn v6.31, large-flow selection and corrections use only admitted, enabled config pairs. Scope filtering happens before the row cap, so pending legs cannot starve admitted flows. Scheduled projection starts a newly admitted leg at its admission timestamp; its 90-day baseline is not announced retroactively. Grandfathered legs retain their existing history, and explicit admin `since` bounds can still repair admitted historical events. Disabling a leg stops new projection without erasing historical claims; source-invalid claims retain the retraction behavior below.

Depeg open/recovery, freeze and large-flow projectors reconcile immutable source identities independent of watermark. Scheduled reconciliation uses the source-owned trailing event-time window; older repair uses explicit admin bounds (`since=0` for all history). New-identity selection excludes already-projected identities/non-recovery closures before limiting. Freeze additionally reconciles already-projected claims with changed amounts or source suppression inside the event-time or recent amount-attempt window, without backfilling unrelated old sources. Source clocks own presentation; watermarks never regress. Freeze historical alerts retain the 24-hour recovery gate. Depeg alerts use active source episodes/exact prior episode IDs, not Tape insert IDs; backfills cannot replay historical depegs live.

Forced time seeks plus source-key existence probes bound freeze/flow candidates. Depeg opens use source start indexes; resolutions can read beyond candidate-window cost. Ties may expand result caps. Observe post-deploy rows_read over comparable windows; drain historical admin bounds separately. Static-catalog source-key probes and inserts use bounded D1-overload retry.

Large mint/burn claims follow their source the same way: the projector re-checks recent already-projected claims against `mint_burn_events` (amount, flow type, burn type, eligibility), republishes eligible corrections in place (identity, clocks and methodology preserved; only severity, title, summary and payload change) and hard-suppresses claims whose source became internal, bridged, review-required, unpriced or sub-threshold with reason `flow-claim-retracted`. A pruned source is never treated as a retraction, and a suppressed identity is never revived. Exact permalink lookup returns the stored reason (`flow-claim-retracted`, `freeze-claim-retracted`) or `event-not-found`. Timeline copy for a retracted permalink is not changed here.

Migration `0283` adds only nullable suppression markers. A source-retracted freeze claim is hard-suppressed from list/search/counts, page/feed grouping, recap selection and alert admission; no tombstone payload or archived permalink representation is published. Its retained source identity prevents re-insertion, even on explicit replay. Queued-unsent freeze alerts recheck current source suppression and cancel with `freeze-claim-retracted`; the final send fence repeats that guard. Already-sent or uncertain effects are never edited, deleted or replayed. Apply the migration before the Worker; keep suppression-aware readers as the rollback floor once markers exist.

### Split-Scan Determinism

PYS-drop carries the last usable selected score across null generations, seeded at/before watermark with source-defined timestamp/generation tie-break. Leading gaps invent no baseline. PSI shifts use immediately preceding sample, including unchanged bands. Split invocations/batches must match one-shot identities/payloads. Capped/bounded depeg peak scans preserve unscanned baselines; only full unbounded census prunes closed events.

Yield warnings distinguish observed empty (SQL NULL or `[]`), valid signal lists and unavailable evidence. Malformed JSON, non-arrays and any invalid member quarantine only that row; they never clear warnings. Both the backward prior-row seek and batch walk use the same decoder and retain the last usable baseline, including source-key tie-breaking at a shared timestamp; the seek is bounded per coin, after which the baseline is unavailable. Structured `warning-evidence-unavailable` logs expose machine-reason counts and at most ten row identities per invocation; no raw corrupt payload is logged.
Existing-but-unavailable history is distinct from successful no-history bootstrap: when no usable predecessor survives a corrupt prefix, the first valid observation establishes state without emitting a transition. Later valid additions and observed-empty clears remain eligible.

The peak seen-map checkpoint commits atomically with the final bounded event batch (or alone for a baseline-only scan). Larger scans can commit earlier batches before a later failure; the error propagates, the checkpoint remains unchanged, and source-key replay preserves every already-committed observation. No lease/checkpoint reset or production fault injection is needed for rollout.

### Freeze Chain Repair

Canonical chain IDs belong in persisted freeze rows; display labels remain public titles/payloads. Migration `0266` and recurring repair share exact source/type/display-name predicate. Each non-dry invocation scans at most 500 existing rows per freeze type, including when no new event exists, through `idx_tape_type_ts` with persisted `(ts,id)` cursor `tape-projector:freeze-chain-repair:<type>` and wraparound. Filter after bounded page read, not full clean-archive scan. Guarded updates change chain only: no identity, payload, clock or Telegram replay.

Structured logs report scanned/repaired/continuing; settled pages repair zero. Cursor advances only after successful whole batch, including clean pages; failed pages retry. Repair failure is isolated/logged as `freeze-chain-repair-failed`, not a fresh-projection failure. Dry runs write neither chains nor cursor.

After old writers drain, retain a full sweep's counts and verify zero remaining exact-predicate rows before declaring completion. Activation alone is not completion. Old-Worker rollback can restore legacy names and suspends repair; roll forward and observe another sweep. Inserts ahead of cursor are found on the next pass regardless of watermark/event age. Operator backfills share this path.

### Published-Generation Proof

DEWS sparse scans and prior-band seed join published `surface_publication_generations`. Changes always create history rows; unchanged samples may be sparse. Failed/partial row-count generations emit no event and advance no DEWS watermark; recovery compares to the last published band. Cache pointer and ledger commit atomically, with migration/runtime reconciliation bootstrapping prior publication. A newest row alone is not publication proof.

## Behavior

The hydration-safe browser clock seeds frozen query-window anchor and ticking presentation clock together after subscription. Server/first hydration uses null clock, not `Date.now()`; ticking ages labels/freshness without sliding query bounds. The same page-owned clock reaches digest, pinned and active-incident rows; memoized event cards update both compact and suffixed relative ages while absolute UTC timestamps stay fixed.

UTC-day grouping persists across infinite-page seams. `digestPage`/`mergeDigestedPages` own recap thresholds; `collapseByCoinClass` merges matching coin/chain/full-type/severity/transition, not different event types. Summary counts describe loaded feed, not the full archive. Freeze recaps separately label gross frozen, released and destroyed USD amounts over those loaded rows, disclose unpriced members as incomplete valuation, and never net them into current exposure. PSI recaps use canonical condition-band ordering, retaining unknown-only labels without ranking them above known bands.

The Currently open strip reads the complete canonical `GET /api/depeg-events?active=true` cohort through `useActiveDepegEvents`, independently of tape severity, type, search, coin and page scope. Canonical numeric event IDs identify incidents; repeated same-coin episodes remain distinct. Published onset, peak and constituent count render directly without fabricating tape provenance, joining by coin or reconstructing constituent IDs. Unmatched historical tape openings are not current-state evidence. Only a complete fresh read claims current activity (OPEN durations, summary open count). A complete cached cohort with an admitted producer clock survives failed, degraded or stale refreshes as “Open at last observation”: original dates, durations frozen at the producer observation (never browser time), no current/active accessible names; only stale health warns, via the shared public gate, and a retained empty cohort renders nothing rather than a current zero. Loading, partial, capped, missing or unknown-clock cohorts withhold OPEN/count claims and fail closed to unavailable activity. Active-source update labels retain their own producer clock and budget, not the tape publication clock. Below public staleness, Updated/source-update tooltips show only the absolute source timestamp (fixed `en-US`/UTC formatting), never delayed/retry/source-advisory copy; stale, missing and failed-without-data states keep their explanation.

Loading layout: before the browser clock exists the route server-renders a shell sharing the mounted summary (two reserved rows), filter and feed slots, never `null`, a build-time time or a fabricated count; data states swap content inside those slots, late open-incident counts trail the stable summary slots, and the feed keeps a static `min-h-[100svh]` floor (minimum, never clipping). CLS is verified in a browser, not jsdom.

Yield-warning events whose new signals are all operational advisories (ADR-42) are projected out by `projectTapeEventsForReader()` before digesting, the homepage strip, coin teasers and the permalink buffer; mixed events are rebuilt from their investment signals and malformed structured signals read "Signal details unavailable.". Raw cursors drive pagination, so a filtered-empty page keeps Load more; visible counts exclude suppressed rows and the visible total stays unknown until the raw traversal ends. A linked event that is suppressed is not reported as missing. First Load more enables sentinel auto-loading; a failed next-page request stops the sentinel until the reader retries. Exhausted cursors get an explicit terminal footer. Empty-state widening takes the smallest applicable step: clear active filters, then lower floor, then all-time. Shared freshness/error notices retain retry and producer clocks; feed availability is an admitted response page, so a successful empty page is observed data (only the empty-filter state, no waiting notice) while a missing response or unknown producer clock stays unavailable. CRT treatment is dark-only presentation, not data state.

## SEO And Crawlability

Noindex is deliberate; do not re-add this client mount to sitemap merely because the shell emits CollectionPage and projector-class ItemList schema. Keep canonical per-class See all on Timeline links on trackers.

## Homepage Integration

The [homepage marquee](./homepage.md) reads the same dataset and ends in one View all events link. Change both owners when severity/class scope or source changes; homepage display caps are not archive statistics.

## Admin

Use `npx tsx worker/scripts/one-shot-backfill.ts backfill-tape --query 'dry-run=true'`. For older history use explicit since/until/maxRows, review dry-run output, then execute with `dry-run=false`. This is operator-only remote-D1 replay, not an HTTP/dashboard action. [Backfill command contract](./runbooks/one-shot-backfills.md#backfill-tape) owns execution details.

## Update Rules

Update source registry/UI class list, tracker deep links and focused projector/grouping/URL tests together. Changes to retention, identity, source clocks, publication proof, replay/repair bounds or rollback acceptance update this contract. API owner remains authoritative for HTTP shape. Keep the single [visual exception](#visual-identity), not an appendix or second aesthetic lock.
