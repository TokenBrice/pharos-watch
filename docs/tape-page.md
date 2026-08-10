# Timeline Page

Route contract for the public `/timeline/` surface. The codebase term "tape" persists in the internal pipeline (`tape_events` D1 table, `TAPE_PROJECTOR_JOBS`, `src/components/tape/`); only the public URL and user-facing label were renamed. Inbound `/tape/` URLs 301-redirect to `/timeline/` via `public/_redirects` (query string preserved, so `?event=`, `?coin=`, `?type=` permalinks survive).

---

## Purpose

`/timeline/` is the cross-class chronological event feed for tracked stablecoins: depegs, freezes, score changes, DEWS / PSI band shifts, mint/burn, yield, methodology bumps, and lifecycle entries in one digestible view. Reserve, redemption, and liquidity classes are reserved filter-chip slots until their projectors ship.

The dedicated trackers (`/depeg/`, `/freezewatch/`, `/flows/`, `/safety-scores/`) remain the canonical surfaces for any single class. `/timeline/` is the unified view for users who want everything for one coin, everything in one severity tier, or a cross-class read across event classes.

Primary audience:

- end users following the live event stream
- ops and editorial reviewers who need a single browse-and-permalink view
- engineers adding new event classes or projectors

---

## Route Shape

- **Route:** `/timeline/`
- **Server shell:** `src/app/timeline/page.tsx`
- **Client implementation:** `src/app/timeline/client.tsx` (exports `TimelineClient`)
- **Timeline split modules:** `src/app/timeline/timeline-controller.ts`, `src/app/timeline/timeline-feed.tsx`, `src/app/timeline/timeline-feed-helpers.ts`, `src/app/timeline/timeline-feed-sections.tsx`, `src/app/timeline/use-timeline-feed-data.ts`, `src/app/timeline/use-timeline-feed-interactions.ts`, and `src/app/timeline/use-timeline-phosphor.ts`
- **Filter UI:** `src/components/tape/tape-filters.tsx` and `src/components/tape/tape-classes.ts`
- **Event card:** `src/components/tape/event-card.tsx`
- **Digest grouping:** `src/lib/tape-digest.ts` + `src/components/tape/class-digest-row.tsx`
- **Class styling:** `src/lib/tape-class-style.ts` (per-class background tints shared with the homepage marquee)
- **Client helpers:** `src/lib/tape-collapse.ts`, `src/lib/severity-colors.ts`
- **Primary dataset:** D1 table `tape_events` via `GET /api/events`

The page renders through `FeaturePageShell` with `breadcrumbName="Timeline"`, `path="/timeline/"`, title `Timeline`, and the lead paragraph authored in `src/app/timeline/page.tsx`.

Metadata is authored directly in `src/app/timeline/page.tsx` with canonical `/timeline/`, route-specific title and description, static OG image `${SITE_URL}/og-timeline.png`, and the default shared page-metadata helper path. No dynamic `/api/og/timeline` generator exists.

---

## Visual Identity

`/timeline/` is a deliberate **wire-service / terminal stream** carve-out from the standard `pharos-card-shell` analytics aesthetic. It is the wire dispatch sibling to `/digest/`'s broadsheet editorial: both lean on mono typography, but `/tape/` is syslog, not newsprint. The general design ground truth lives in [design-language.md](./design-language.md); this section is the canonical contract for this route, mirrored as `### Tape (Special)` in that doc.

1. **No `pharos-card-shell`** on event rows, day groups, the currently-open band, the pinned linked-event block, or the empty state. The whole stream is a flat typographic surface.
2. **Hairline dividers** (`border-b border-border/30`) between rows — no rounded card boxes.
3. **The core mono stack (JetBrains Mono) is dominant** on the stream. SummaryBand, day separators, event rows, severity tags, time prefixes — all mono. The retained `--font-geist-mono` name is a legacy token, not a Geist webfont. Sans is reserved for the filter row labels, which share control utilities with the rest of the site.
4. **Severity is communicated by text color**, not by card border or background fill. The `severityToAccent` `border-l-[3px]` rail is intentionally dropped from `EventCard`.
5. **Time prefix on every row** — desktop/tablet rows show `HH:MM` in mono `tabular-nums`, rendered in UTC to match the UTC day grouping (a single `All times UTC` label sits atop the feed); mobile rows show compact relative tokens (`5s`, `3m`, `2h`, `4d`) while the absolute time remains in the `<time>` metadata and hover title.
6. **Structured row layout** — `time | severity | logo | ticker (inline ×count) | event.type slug | chain | spacer | copy-permalink | age`. The event title is redundant with these fields for coin events and is replaced by the structured form; the event summary becomes the second line.
7. **Day separator** — full-width mono rule with the date inline (`─── TODAY · MAY 15, 2026 ─────────────`), not a thin underline header.
8. **Currently-open band** — mono uppercase eyebrow (`⚠ CURRENTLY OPEN · N INCIDENTS`) over hairline-divided rows; no rounded shell.
9. **Pinned linked-event block** — mono uppercase label (`PINNED · Linked from URL`) inside the feed above day groups; no shell.
10. **Summary band above filters** — shows loaded count, open-incident count, active window, severity floor, update recency, last-event timestamp, and the dark-mode-only CRT toggle. No event-density histogram is currently rendered.
11. **Filter row is a flat wire-control surface** — it uses hairline `border-y` dividers and shared control primitives, but it does not use `pharos-card-shell`.

---

## URL Filter Contract

Filter state is read from URL search params via `useUrlFilters`, parsed in `readTapeFilterState` (`src/components/tape/tape-filters.tsx`):

| Param      | Values                                                                                | Default  | Notes                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `type`     | comma-joined slugs; exact (`depeg.opened`) or prefix wildcard (`depeg.*`)             | empty    | Class chips in the UI emit the wildcard form                                           |
| `severity` | `info`, `notice`, `warning`, `severe`, `critical`                                     | `notice` | `info` drops the floor entirely; default keeps routine info-tier events out of view    |
| `coin`     | canonical ticker-issuer id                                                            | empty    | Forwarded to `/api/events?coin=`                                                       |
| `peg`      | `all` or one of the entries in `PEG_FILTER_OPTIONS` from `@shared/lib/classification` | `all`    | Forwarded to `/api/events?pegCurrency=` and filtered server-side (mirrors the `pegCurrency` API param)  |
| `chain`    | `all` or any id present in `CHAIN_META` from `@shared/lib/chains`                     | `all`    | Forwarded to `/api/events?chain=`                                                      |
| `window`   | `24h`, `7d`, `30d`, `90d`, `alltime`                                                   | `7d`     | Converted to `since=<epoch_ms>` by `tapeWindowSince(...)`; parser also accepts legacy `all`, but the UI emits `alltime` |
| `q`        | free-text                                                                             | empty    | Debounced 200 ms in the client, then forwarded to `/api/events?q=` for server-side search |
| `event`    | event id (`${ts_ms}-${type}-${hash8}`)                                                | empty    | Permalink target; resolved through a 200-row latest-events buffer when out of view     |

`severity`, `peg`, `chain`, and `window` are always set; clearing them returns to the defaults shown above. The all-time empty-state CTA writes `window=alltime`.

---

## API Contract

The route is a thin client over `GET /api/events` (handler `worker/src/api/events.ts`, route key `events` in `shared/lib/api-endpoints/definitions.ts`).

- **Pagination:** opaque cursor (base64url-encoded `{v:1, ts, id}`); page size is 500 (also the API max).
- **Severity floor expansion:** server expands `severityFloor=<level>` into the inclusive set at or above that rank using `SEVERITY_RANK` from `@shared/types/tape-event`.
- **Type filters:** `type=foo` matches exactly; `type=foo.*` matches all subtypes; `class=foo` is a shortcut for `type=foo.*`. Both can be passed multiple times.
- **Freshness:** the response Cache-Control is the `realtime` profile (`public, s-maxage=60, max-age=10`); the freshness budget (`FRESHNESS_MAX_AGE_SEC = 600`, 10 minutes) instead drives `_meta` `{updatedAt, ageSeconds, status}`. The `project-tape` cron lane runs every 30 minutes, so `Warning: 110` fires after roughly 80 minutes absent.
- **Hook:** `useEvents()` in `src/hooks/use-events.ts` wraps the infinite-query path; `useLatestEvents()` wraps the single-page latest-N path used by the homepage tape marquee and the permalink buffer.

`/api/events` is allowlisted on the same-origin site-data lane, so the page reads it through `/_site-data/events` from the browser.

---

## Backing Pipeline

The feed is a materialized projection of existing producer tables. The `project-tape` cron job (`worker/src/cron/project-tape.ts`) runs on the DEWS/PSI `26,56 * * * *` DB-only lane and is idempotent on `(source_table, source_row_id, transition)` so re-runs are no-ops. The projector adds zero outbound connection budget — it is purely D1-bound.

DEWS band projection requires durable publication proof. Both the forward `stress_signals` scan and its prior-band seed join `surface_publication_generations` at `surface = "dews"` and `state = "published"`. A partially written generation that fails DEWS row-count validation therefore emits no Tape event and cannot advance either DEWS projector watermark; a later published generation diffs against the last published band rather than the failed intermediate row. The DEWS cache pointer and ledger row commit atomically, while migration `0182` plus runtime pointer reconciliation bootstrap the publication that predates this contract.

Current projector roster (from `TAPE_PROJECTOR_JOBS` in `worker/src/cron/project-tape.ts`):

| Projector                       | Source                                                  | Emits                                                                |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `depeg.opened` / `.resolved` / `.peak_worsened` | `depeg_events`                          | Confirmed peg deviations, recovery-backed resolutions, and peak transitions |
| `freeze.blocked` / `.unblocked` / `.destroyed`  | `blacklist_events`                      | Issuer freeze, unblock, and fund-destroy actions                     |
| `score.upgraded` / `.downgraded`                | `safety_score_history_v2` plus unmatched legacy `safety_grade_history` rows | Organic stablecoin Safety Score grade transitions; methodology-boundary, rollback, and restoration baselines are excluded |
| `psi.band_changed`                              | `stability_index_samples`               | PSI regime-band transitions                                          |
| `dews.band_transitions` (emits `.escalated` / `.deescalated`) | `stress_signals`                        | DEWS stress-level changes                                            |
| `mint_burn.large_flow` (emits `.large_mint` / `.large_burn`)          | `mint_burn_events`                      | Large single-transaction mint or burn flows (one event per direction) |
| `yield.warning_emitted` / `.pys_dropped`        | `yield_history` (warning_emitted) / `yield_source_decisions` (pys_dropped) | Yield-risk warnings and PYS drops                                    |
| `methodology.bumped` (emits `:<domain>`)                   | `shared/lib/*-version` modules          | Methodology version bumps (first-observation pattern)                |
| `cemetery.entry.added`                          | `shared/lib/cemetery-merged.ts`         | Newly added cemetery entries                                         |
| `lifecycle.tracked.frozen`                      | `shared/lib/stablecoins/` (frozen status)| Tracked coin frozen-lifecycle entries                                |

`TAPE_CLASSES` (`src/components/tape/tape-classes.ts`) carries exactly the classes with a live projector — one entry per row in the table above. The three reserved chip slots (`reserve`, `redemption`, `liquidity`) and the `hasProjector` flag that subdued them were deleted on 2026-08-09: a class earns a chip when its projector ships. `TAPE_CLASS_LABEL` in `src/lib/tape-class-style.ts` is derived from this list rather than re-authored.

`tape_events` schema lives in `worker/migrations/0000_baseline.sql`, which absorbed the pre-squash `0129_tape_events.sql`. The wire `event_id` is `${ts_ms}-${type}-${hash8}` and is reused as the `?event=<id>` permalink.

Retention policy: `tape_events` is a product timeline archive kept forever. The page can bound reads by filters, windows, cursors, and severity, but all-time browsing, permalinks, homepage event reads, and DDRR review evidence depend on historical projected events remaining available.

---

## Behavior

- **Severity-floor default:** the page opens at `notice+`. Lower-priority chip ("All") drops the floor.
- **Summary band:** visible result sets render a summary band above filters and data-status notices. It reports loaded count, open-incident count, active window, severity floor, update recency, last-event timestamp, and the dark-mode-only CRT toggle.
- **Day grouping:** events are bucketed by UTC day; today and yesterday get `Today` / `Yesterday` primary labels. The day separator carries a per-day counter (`N events · M classes`) so users can decide whether to scan a day before scrolling. Quiet days with `≤ 3` events render as a collapsed day-level `<details>` summary listing class/ticker tokens before the underlying class groups.
- **Digest grouping:** within each day, events are partitioned by class by `digestPage(...)` and `mergeDigestedPages(...)` in `src/lib/tape-digest.ts`. Classes with `≥ 3` events render as a collapsible `<details>` recap row carrying a class background tint, count, top tickers, and class-specific aggregate stats (`worst N bps`, `$X frozen`, `N upgrades · M downgrades`, `max <severity>`). Classes with `< 3` events render inline unless the whole day is using the quiet-day wrapper. The recap line stays visible when closed; clicking reveals the underlying `EventCard` rows. Severity above the notice floor is communicated via the colored `max <severity>` chip in the recap and via the per-event severity text in the open state.
- **Page-seam merging:** `digestPage(...)` digests each infinite-query page independently and `mergeDigestedPages(...)` re-merges adjacent pages that share a UTC day, preserving day grouping across pagination seams.
- **Collapse-by-coin-class:** within an expanded digest, events sharing the same coin/chain attribution, full event type, severity, and transition further collapse (regardless of adjacency) into a single card with a count badge via `collapseByCoinClass(...)`; different types within one class (e.g. `depeg.opened` vs `depeg.resolved`) stay separate.
- **Per-class tints:** every `EventCard` and digest recap row carries a class background tint (`bg-{rose|cyan|indigo|…}-500/[0.08]` for rows; `/10` for marquee chips). The tint scheme is `src/lib/tape-class-style.ts` and is shared with `src/components/homepage-tape.tsx`. Class is signaled by hue; severity stays text-color (Aesthetic Lock).
- **Open incidents banner:** active `depeg.opened` events whose `sourceRowId` has not yet been seen as recovery-backed `depeg.resolved` in the visible window render in a separate amber band above the day groups. Deduped per coin.
- **`?event=<id>` permalink:** if the linked event isn't in the current filter window, a 200-row latest buffer (`useLatestEvents({ limit: 200 })`) is queried in parallel and the event is rendered as a pinned block inside `#tape-feed`, above the day groups. Resolved permalinks scroll into view and pulse-highlight for `HIGHLIGHT_DURATION_MS` (2000 ms).
- **Infinite scroll:** the first `Load more` click flips a sentinel `IntersectionObserver` on, after which subsequent pages auto-load.
- **End-of-feed footer:** when the cursor is exhausted, the page prints a mono terminal footer (`END OF TAPE · N EVT · WINDOW ... · CURSOR: NULL · LAST FILE: ...`) instead of a generic sentence.
- **Empty state:** if filters return nothing, the CTA resets filters or widens the window to `alltime` (whichever applies).
- **Stale data banner + retry:** the feed is wrapped by `QueryFreshnessNotices` (the shared freshness/error banner).

---

## SEO And Crawlability

- The route is indexable. `src/app/sitemap.ts` includes `${SITE_URL}/timeline/`.
- `src/app/timeline/page.tsx` emits two JSON-LD blocks:
  - `CollectionPage` with `@id=${TIMELINE_URL}#collection`, `isPartOf` the site `WebSite` node
  - `ItemList` of every entry in `TAPE_CLASSES` (all projector-backed by construction), each linking to `?type=<slug>.*`
- Per-class deep-links into `/timeline/` (e.g., `/timeline/?type=depeg.*`) are the canonical "See all on Timeline" targets used from `/depeg/`, `/freezewatch/`, and `/flows/`.

---

## Homepage Integration

The homepage marquee in `src/components/homepage-tape.tsx` consumes the same backing data via `useLatestEvents()` and terminates with a single `View all events →` cell that links to `/timeline/`. Update homepage and Timeline together if the marquee's severity or class scope changes — see [homepage.md](./homepage.md).

---

## Admin

- `POST /api/backfill-tape` (`worker/src/api/backfill-tape.ts`, route key `backfill-tape` in `shared/lib/api-endpoints/definitions.ts`) — admin-only, mutating. Re-runs the projector roster with operator-supplied overrides; supports `?dryRun=true` and is exposed as a status-page action labeled "Backfill Tape".

---

## Update Rules

Update this doc when any of these contracts change:

- the URL filter set, default severity floor, or window options
- the projector roster in `TAPE_PROJECTOR_JOBS`
- the `tape_events` schema, the event-id format, or the cursor encoding
- the `GET /api/events` query params, freshness budget, or pagination cap
- the summary band, quiet-day collapse, infinite-scroll digestion, or `?event=` permalink resolution path (buffer size, scroll behavior)
- the JSON-LD shape emitted by `src/app/timeline/page.tsx`

If a new projector class ships, also update:

1. `TAPE_CLASSES` in `src/components/tape/tape-classes.ts`
2. the projector roster in `worker/src/cron/project-tape.ts` (`TAPE_PROJECTOR_JOBS`)
3. this document
4. the per-class deep-link footer on the source tracker page (`/depeg/`, `/freezewatch/`, `/flows/`, etc.)

If the homepage marquee's data source or severity floor changes, also update [homepage.md](./homepage.md).

If you find yourself wrapping event rows in `pharos-card-shell`, rounding corners, or replacing the mono typography with sans, stop and re-read the [Aesthetic Lock](#aesthetic-lock).

---

## Aesthetic Lock

**Do not harmonize `/timeline/` with the standard `pharos-card-shell` / rounded-card analytics surface.** The wire-service treatment described under [Visual Identity](#visual-identity) is intentional and load-bearing for this route's identity. Per-class background tints applied to event rows and digest recaps (`src/lib/tape-class-style.ts`) are part of that treatment, not a violation — they signal class via hue while severity remains text-color. The matching carve-out lives in [design-language.md](./design-language.md) under `### Tape (Special)`; the lock holds from either entry point.

Specifically:

- The absence of `pharos-card-shell` on event rows, day groups, the currently-open band, the pinned linked-event block, and the empty state is by design, not an oversight.
- The JetBrains Mono/core mono stack as the dominant stream typeface is a third deliberate carve-out alongside Digest (Newsreader + Courier) and the detail-page `AiSummary` (Georgia).
- Severity-as-text-color (no left rail, no fill) is part of the wire-service identity. Restoring the `border-l-[3px]` rail regresses the design.

Future "harmonize /timeline with the rest of the site" suggestions should be rejected unless the user explicitly asks to retire the wire-service treatment.
