# Privacy Page

Route contract for `/privacy/`, the public privacy-policy surface linked from the footer.

## Route Shape

- Route: `src/app/privacy/page.tsx`
- Shared shell: `src/components/feature-page-shell.tsx`
- Footer link: `src/components/footer.tsx`
- Sitemap owner: `src/app/sitemap.ts`

The route is statically rendered and does not fetch private data. Its copy describes storage and processing performed elsewhere in the product.

## Metadata

`src/app/privacy/page.tsx` owns the title, description, canonical `/privacy/`, and visible `Last updated` date; the social image falls back to the shared `buildPageMetadata` default. Keep the date in step with substantive policy changes.

The page uses the longform shell with a constrained reading measure. It remains public, indexable, and linked from the footer.

## Data Categories

Keep the visible policy organized around user-understandable categories rather than copying a table-by-table database inventory.

### Website analytics

Analytics loads only when `NEXT_PUBLIC_GA_ID` is configured and the browser uses the public production hostname `pharos.watch`. Operator routes (`/admin/`, `/admin-api/` and descendants), operator hosts, Pages preview hosts, and the embedded Telegram Mini App are excluded from GA4 bootstrap, page views, custom events, and Web Vitals. The shared gate in `src/lib/analytics.ts` checks the browser location again when custom events fire, including delayed callbacks after a route change.

The shared liquidity/compliance search hook (`src/hooks/use-url-search-sync.ts`) schedules `search_performed` only from manual input, not initial URL queries or browser history changes. Analytics receives the page label and query length, never the raw query in that custom event; clearing input cancels the pending search event. URL synchronization retains its own debounce, while search analytics uses the shared one-second debounce and route-navigation cleanup. This custom-event restriction does not strip query strings from page-view URLs.

`WebVitalsReporter` keeps its reporting callback identity stable across route rerenders, preventing Next.js from registering additional metric observers for the same mounted reporter. It reads the latest pathname for the public-route guard and existing `page_path` attribution; this does not turn document-lifetime Web Vitals into per-client-navigation measurements.

Deliberate local test exception: `localhost`, `127.0.0.1`, and `[::1]` retain analytics support when a measurement ID is explicitly configured, so the existing local `SMOKE_UI_EXPECT_GA_ID` smoke check remains usable. Use a test measurement ID for these runs; they are not public-production traffic. No other host suffix or preview domain is allowed. The page explains cookies, retention, hosting providers, and the typed event catalog without promising telemetry that the runtime does not collect.

Authoritative sources:

- `src/app/layout.tsx`
- `src/components/google-analytics.tsx`
- `src/components/web-vitals-reporter.tsx`
- `src/lib/analytics.ts`
- `shared/lib/site-csp.ts`

### Browser-local preferences

Pharos has no website account or wallet connection. Browser-local functional state includes:

- homepage shortcut hrefs in `localStorage` under `pharos-shortcuts`
- portfolio holdings in `localStorage` under `pharos:portfolio`
- the user-authored watchlist in `localStorage` under `pharos-watchlist-v1`
- Picker callout dismissal in `localStorage` under `pharos.selector.callout.v1`
- optional live Picker result recovery in `sessionStorage` under `pharos.selector.sessionResult.v1`
- presentation preferences such as table columns, show-your-work mode, command history, motion, and timeline display settings

Portfolio and shortcut state is not sent to the API. Picker snapshot sharing is a separate server-side feature described below.

### Feedback and API access

Feedback contact handles may be included in the public GitHub issue created from a submission. Self-serve API access requests use private operator storage for verified email and optional request metadata; verification mail is delivered through Resend. Request-abuse controls use salted or keyed pseudonymous values rather than storing raw IP addresses in the application tables.

Authoritative sources:

- `worker/src/api/feedback.ts`
- `worker/src/api/api-key-requests.ts`
- `worker/src/api/api-key-requests/`
- relevant migrations in `worker/migrations/`

### Stablecoin Picker snapshots

Picker share links point to Pages KV snapshots recomputed from submitted answers and canonical site data. The artifact contains the normalized input, stablecoin output fields, methodology/version binding, dataset hash, and provenance; it does not contain an account, wallet address, raw IP address, or browser fingerprint. Anyone with the URL can view it.

Unread snapshots expire after 90 days. The first successful read extends retention to five years; a snapshot that is never opened does not receive that long retention.

Snapshot write quotas use a keyed IP-derived value in the short-lived limiter and D1 quota table. The Pages Function, shared snapshot schema, and migration are authoritative for payload, expiry, and quota behavior:

- `functions/selector-snapshot/[[path]].ts`
- `functions/lib/selector-canonical-snapshot.ts`
- `shared/lib/selector/snapshot.ts`
- `worker/migrations/`
- [screener-picker-page.md](./screener-picker-page.md)

### Telegram alerts and Mini App

Telegram processing includes subscriber identity and settings, followed coins and presets, quiet hours and snooze state, short-lived command state, queued delivery work, delivery/audit outcomes, personalized recap preferences and targets, authenticated diagnostics, and identifier-free aggregate adoption/usage counters.

Do not maintain an allegedly exhaustive Telegram table roster here. The schema and retention model evolves through migrations and owning runtime modules. Use these authoritative sources:

- `worker/migrations/0000_baseline.sql` plus later `worker/migrations/*.sql`
- [telegram-alerts.md](./telegram-alerts.md) for the maintained schema and user-facing behavior
- [telegram-architecture.md](./telegram-architecture.md) for storage and dispatch ownership
- `worker/src/cron/telegram-retention-cleanup.ts`
- `worker/src/cron/telegram-inactive-cleanup.ts`
- `worker/src/api/telegram-store/forget.ts`
- `shared/lib/telegram-recap-policy.ts`

Durable follows and enabled recap preferences remain while configured; empty inactive profiles can be pruned under the runtime policy. Short-lived state and operational/audit records use category-specific retention. Personalized recap pending deliveries expire after the shared six-hour `TELEGRAM_RECAP_TTL_SEC`; recap target outcomes have their own retention windows.

Telegram Mini App endpoints validate signed `initData` but do not persist the raw value or a hash. Mutation freshness, read/session portability, cooldown, and aggregate telemetry rules live in the endpoint/auth modules and [telegram-mini-app.md](./telegram-mini-app.md). The visible policy must remain aligned with those sources.

Custom Telegram Worker logs use the allowlisted low-cardinality boundary in `worker/src/lib/telegram/log.ts`. Chat-specific investigation belongs in authenticated D1/admin diagnostics rather than raw identifiers in general logs.

## Update Rules

Update `src/app/privacy/page.tsx` and this contract together when data handling changes. Also update the closest feature doc when the change belongs to Telegram, Picker snapshots, portfolio, feedback, or API access.

For database details, cite the owning migration and runtime cleanup/store module instead of copying an exhaustive roster into this page. Run the verified-doc link and source-path checks after changing references.
