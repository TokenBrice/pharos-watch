# Tape Page

Route contract for the public `/tape/` surface.

---

## Purpose

`/tape/` is the cross-class chronological event feed for tracked stablecoins: depegs, freezes, score changes, methodology bumps, lifecycle entries, and (as new projector classes ship) DEWS / PSI band shifts, mint/burn, reserves, redemption, yield, and liquidity events on one timeline.

The dedicated trackers (`/depeg/`, `/freezewatch/`, `/flows/`, `/safety-scores/`) remain the canonical surfaces for any single class. `/tape/` is the unified view for users who want everything for one coin, everything in one severity tier, or a cross-class read across event classes.

Primary audience:

- end users following the live event stream
- ops and editorial reviewers who need a single browse-and-permalink view
- engineers adding new event classes or projectors

---

## Route Shape

- **Route:** `/tape/`
- **Server shell:** `src/app/tape/page.tsx`
- **Client implementation:** `src/app/tape/client.tsx` (exports `TapeClient`)
- **Filter UI:** `src/components/tape/tape-filters.tsx` and `src/components/tape/tape-classes.ts`
- **Event card:** `src/components/tape/event-card.tsx`
- **Client helpers:** `src/lib/tape-collapse.ts`, `src/lib/severity-colors.ts`
- **Primary dataset:** D1 table `tape_events` via `GET /api/events`

The page renders through `FeaturePageShell` with `breadcrumbName="The Tape"`, `path="/tape/"`, title `The Tape`, a `beta` status badge, and the two-paragraph lead authored in `src/app/tape/page.tsx`.

Metadata is authored directly in `src/app/tape/page.tsx` with canonical `/tape/`, route-specific title and description, and the default shared page-metadata helper path. The OG image falls back to the static `/og-card.png`; a dynamic `/api/og/tape` generator is reserved but not yet shipped.

---

## Visual Identity

`/tape/` is a deliberate **wire-service / terminal stream** carve-out from the standard `pharos-card-shell` analytics aesthetic. It is the wire dispatch sibling to `/digest/`'s broadsheet editorial: both lean on mono typography, but `/tape/` is syslog, not newsprint. The general design ground truth lives in [design-language.md](./design-language.md); this section is the canonical contract for this route, mirrored as `### Tape (Special)` in that doc.

1. **No `pharos-card-shell`** on event rows, day groups, the currently-open band, the linked-event band, or the empty state. The whole stream is a flat typographic surface.
2. **Hairline dividers** (`border-b border-border/30`) between rows — no rounded card boxes.
3. **Geist Mono is the dominant typeface** on the stream. SummaryBand, day separators, event rows, severity tags, time prefixes — all mono. Sans is reserved for the filter row labels, which share control utilities with the rest of the site.
4. **Severity is communicated by text color**, not by card border or background fill. The `severityToAccent` `border-l-[3px]` rail is intentionally dropped from `EventCard`.
5. **Time prefix on every row** — `HH:MM` in mono `tabular-nums` at the start of each event line, syslog-style.
6. **Structured row layout** — `time | logo | ticker | event.type slug | severity | count | chain | spacer | age`. The event title is redundant with these fields for coin events and is replaced by the structured form; the event summary becomes the second line.
7. **Day separator** — full-width mono rule with the date inline (`─── TODAY · MAY 15, 2026 ─────────────`), not a thin underline header.
8. **Currently-open band** — mono uppercase eyebrow (`⚠ CURRENTLY OPEN · N INCIDENTS`) over hairline-divided rows; no rounded shell.
9. **Linked-event band** — mono uppercase eyebrow (`↗ YOU FOLLOWED A LINK TO THIS EVENT`) over a single event row; no shell.
10. **Filter row keeps `pharos-card-shell`** — it is a control surface, not part of the stream.

---

## URL Filter Contract

Filter state is read from URL search params via `useUrlFilters`, parsed in `readTapeFilterState` (`src/components/tape/tape-filters.tsx`):

| Param      | Values                                                                                | Default  | Notes                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `type`     | comma-joined slugs; exact (`depeg.opened`) or prefix wildcard (`depeg.*`)             | empty    | Class chips in the UI emit the wildcard form                                           |
| `severity` | `info`, `notice`, `warning`, `severe`, `critical`                                     | `notice` | `info` drops the floor entirely; default keeps routine info-tier events out of view    |
| `coin`     | canonical ticker-issuer id                                                            | empty    | Forwarded to `/api/events?coin=`                                                       |
| `peg`      | `all` or one of the entries in `PEG_FILTER_OPTIONS` from `@shared/lib/classification` | `all`    | Applied client-side after the API response (mirrors `pegCurrency` API param when set)  |
| `chain`    | `all` or any id present in `CHAIN_META` from `@shared/lib/chains`                     | `all`    | Forwarded to `/api/events?chain=`                                                      |
| `window`   | `24h`, `7d`, `30d`, `90d`, `all`                                                      | `7d`     | Converted to `since=<epoch_ms>` by `tapeWindowSince(...)`                              |
| `q`        | free-text                                                                             | empty    | Client-side fuzzy match against title, summary, and `coinId`                           |
| `event`    | event id (`${ts_ms}-${type}-${hash8}`)                                                | empty    | Permalink target; resolved through a 200-row latest-events buffer when out of view     |

`severity`, `peg`, `chain`, and `window` are always set; clearing them returns to the defaults shown above.

---

## API Contract

The route is a thin client over `GET /api/events` (handler `worker/src/api/events.ts`, route key `events` in `shared/lib/api-endpoints/definitions.ts`).

- **Pagination:** opaque cursor (base64url-encoded `{v:1, ts, id}`); page size is 50, max 500.
- **Severity floor expansion:** server expands `severityFloor=<level>` into the inclusive set at or above that rank using `SEVERITY_RANK` from `@shared/types/tape-event`.
- **Type filters:** `type=foo` matches exactly; `type=foo.*` matches all subtypes; `class=foo` is a shortcut for `type=foo.*`. Both can be passed multiple times.
- **Freshness:** `_meta.maxAge = 600` (10 minutes). The `project-tape` cron lane runs every 30 minutes, so `Warning: 110` fires after roughly 80 minutes absent.
- **Hook:** `useEvents()` in `src/hooks/use-events.ts` wraps the infinite-query path; `useLatestEvents()` wraps the single-page latest-N path used by the homepage tape marquee and the permalink buffer.

`/api/events` is allowlisted on the same-origin site-data lane, so the page reads it through `/_site-data/events` from the browser.

---

## Backing Pipeline

The feed is a materialized projection of existing producer tables. The `project-tape` cron job (`worker/src/cron/project-tape.ts`) runs on the DEWS/PSI `26,56 * * * *` DB-only lane and is idempotent on `(source_table, source_row_id, transition)` so re-runs are no-ops. The projector adds zero outbound connection budget — it is purely D1-bound.

v1 projector roster (from `TAPE_PROJECTOR_JOBS` in `worker/src/cron/project-tape.ts`):

| Projector                       | Source                                                  | Emits                                                                |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `depeg.opened` / `.resolved` / `.peak_worsened` | `depeg_events`                          | Confirmed peg deviations and their resolution / peak transitions     |
| `freeze.blocked` / `.unblocked` / `.destroyed`  | `blacklist_events`                      | Issuer freeze, unblock, and fund-destroy actions                     |
| `score.upgraded` / `.downgraded`                | `safety_grade_history`                  | Stablecoin Safety Score grade transitions                            |
| `methodology.bumped:<domain>`                   | `shared/lib/*-version` modules          | Methodology version bumps (first-observation pattern)                |
| `cemetery.entry.added`                          | `shared/lib/cemetery-merged.ts`         | Newly added cemetery entries                                         |
| `lifecycle.tracked.frozen`                      | `shared/lib/stablecoins/` (frozen status)| Tracked coin frozen-lifecycle entries                                |

Future projectors (`dews`, `psi`, `mint_burn`, `reserve`, `redemption`, `yield`, `liquidity`) are listed in `TAPE_CLASSES` (`src/components/tape/tape-classes.ts`) for the filter chip set and `ItemList` JSON-LD; their projector implementations land as those source pipelines mature.

`tape_events` schema lives in `worker/migrations/0129_tape_events.sql`. The wire `event_id` is `${ts_ms}-${type}-${hash8}` and is reused as the `?event=<id>` permalink.

---

## Behavior

- **Severity-floor default:** the page opens at `notice+`. Lower-priority chip ("All") drops the floor.
- **Day grouping:** events are bucketed by UTC day; today and yesterday get `Today` / `Yesterday` primary labels.
- **Collapse-by-coin-class:** consecutive events of the same `(coin, class)` within a day collapse into a single card with a count badge via `collapseByCoinClass(...)`.
- **Open incidents banner:** active `depeg.opened` events whose `sourceRowId` has not yet been seen as `depeg.resolved` in the visible window render in a separate amber band above the day groups. Deduped per coin.
- **`?event=<id>` permalink:** if the linked event isn't in the current filter window, a 200-row latest buffer (`useLatestEvents({ limit: 200 })`) is queried in parallel and the event is rendered above the day stream. Resolved permalinks scroll into view and pulse-highlight for `HIGHLIGHT_DURATION_MS` (2000 ms).
- **Infinite scroll:** the first `Load more` click flips a sentinel `IntersectionObserver` on, after which subsequent pages auto-load.
- **Empty state:** if filters return nothing, the CTA resets filters or widens the window to `all` (whichever applies).
- **Stale data banner + retry:** standard `StaleDataBanner` and `QueryErrorNotice` wrap the feed.

---

## SEO And Crawlability

- The route is indexable. `src/app/sitemap.ts` includes `${SITE_URL}/tape/`.
- `src/app/tape/page.tsx` emits two JSON-LD blocks:
  - `CollectionPage` with `@id=${TAPE_URL}#collection`, `isPartOf` the site `WebSite` node
  - `ItemList` of the 12 tape classes from `TAPE_CLASSES`, each linking to `?type=<slug>.*`
- Per-class deep-links into `/tape/` (e.g., `/tape/?type=depeg.*`) are the canonical "See all on Tape" targets used from `/depeg/`, `/freezewatch/`, and `/flows/`.

---

## Homepage Integration

The homepage marquee in `src/components/homepage-tape.tsx` consumes the same backing data via `useLatestEvents()` and terminates with a single `View all events →` cell that links to `/tape/`. Update homepage and tape together if the marquee's severity or class scope changes — see [homepage.md](./homepage.md).

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
- the `?event=` permalink resolution path (buffer size, scroll behavior)
- the JSON-LD shape emitted by `src/app/tape/page.tsx`

If a new projector class ships, also update:

1. `TAPE_CLASSES` in `src/components/tape/tape-classes.ts`
2. the projector roster in `worker/src/cron/project-tape.ts` (`TAPE_PROJECTOR_JOBS`)
3. this document
4. the per-class deep-link footer on the source tracker page (`/depeg/`, `/freezewatch/`, `/flows/`, etc.)

If the homepage marquee's data source or severity floor changes, also update [homepage.md](./homepage.md).

If you find yourself wrapping event rows in `pharos-card-shell`, rounding corners, or replacing the mono typography with sans, stop and re-read the [Aesthetic Lock](#aesthetic-lock).

---

## Aesthetic Lock

**Do not harmonize `/tape/` with the standard `pharos-card-shell` / rounded-card analytics surface.** The wire-service treatment described under [Visual Identity](#visual-identity) is intentional and load-bearing for this route's identity. The matching carve-out lives in [design-language.md](./design-language.md) under `### Tape (Special)`; the lock holds from either entry point.

Specifically:

- The absence of `pharos-card-shell` on event rows, day groups, the currently-open band, the linked-event band, and the empty state is by design, not an oversight.
- Geist Mono as the dominant stream typeface is a third deliberate carve-out alongside Digest (Newsreader + Courier) and the detail-page `AiSummary` (Georgia).
- Severity-as-text-color (no left rail, no fill) is part of the wire-service identity. Restoring the `border-l-[3px]` rail regresses the design.

Future "harmonize /tape with the rest of the site" suggestions should be rejected unless the user explicitly asks to retire the wire-service treatment.
