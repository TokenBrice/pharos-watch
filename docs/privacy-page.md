# Privacy Page

Route contract for `/privacy/`, the longform privacy-policy surface linked from the site footer.

---

## Route Shape

- **Route file:** `src/app/privacy/page.tsx`
- **Shared shell:** `src/components/feature-page-shell.tsx`
- **Primary navigation surface:** `src/components/footer.tsx`

The route is static and frontend-only. It does not call worker APIs.

---

## Metadata Contract

`src/app/privacy/page.tsx` defines:

- title: `Privacy Policy`
- description: `Pharos privacy policy: what data we collect, how we use it, and your choices.`
- canonical: `/privacy/`
- Open Graph image: `/og-card.png`

The page renders through `FeaturePageShell` with:

- `breadcrumbName = "Privacy Policy"`
- `path = "/privacy/"`
- `variant = "longform"`
- `containerClassName = "max-w-2xl"`
- lead copy: `Last updated: May 2026`

---

## Content Contract

The current policy copy covers:

1. optional GA4-based anonymized analytics when `NEXT_PUBLIC_GA_ID` is configured at build time
2. no website accounts or wallet connections
3. GA4 cookies only, and only when analytics is enabled
4. 14-month GA4 retention when GA4 is enabled
5. Cloudflare Pages / Workers hosting and Google Analytics as third-party services
6. support contact via `@PharosWatch` and the About page
7. optional Telegram/X handles submitted through the feedback form appear publicly on the GitHub issue created for your submission
8. Telegram alert subscriptions store chat ID, optional username, followed coins, alert settings, quiet hours, snooze state, and short-lived pending-command or pending-alert metadata; subscriber rows with no follows or pending state and no Telegram activity for 180 days are automatically purged on a weekly cleanup
9. the full enumeration of Telegram-owned D1 tables and their retention windows (see below)
10. the Mini App auth note: `initData` is never persisted — it is only validated (HMAC signature + freshness window); mutations use a 5-minute auth window plus a per-user mutation cooldown, and session reads use a 24-hour read-only window
11. self-serve API key requests store verified email plus optional requester/project/use-case metadata for private operator review; request throttling stores salted hashes of IP address and user-agent data
12. Resend sends API verification emails and necessarily receives the one-time verification URL in the email body; optional GitHub issuance notifications deliberately exclude requester details and plaintext tokens

Portfolio holdings are explicitly described as browser-local only, which matches the `/portfolio/` implementation. The page now also notes that any delegated feedback contact handle will be visible in the GitHub issues that Pharos creates.

### Stablecoin Picker storage

The Stablecoin Picker at `/screener/picker/` uses browser-local storage only for functional UI recovery and dismissal state:

- `pharos.selector.callout.v1` (`localStorage`) — Screener-page callout dismissal state. It survives reloads and clears when the user clears site data.
- `pharos.selector.sessionResult.v1` (`sessionStorage`) — optional last-successful live result recovery after accidental navigation. It clears when the tab/session closes and is not written after explicit reset/clear.

This is functional storage. It does not contain an IP address, a user identifier, or a cross-site beacon. The Picker must not create long-lived localStorage output history.

Snapshot share links (`/screener/picker/?sid={sid}`) reference a server-side KV-backed JSON payload that captures the selector output that was generated. The payload contains the form answers, the resulting shortlist, watch-out/profile-mismatch rows, methodology/version fields, and dataset hash; it does not contain an IP, a browser fingerprint, wallet address, account identifier, or other user identifier. Snapshot identifiers are **content-addressed** — two users who run the Picker with identical answers against an identical dataset produce the same identifier. Anyone with the link can view the frozen artifact. The store is a per-Pages KV namespace (`SELECTOR_SNAPSHOTS`) with a 5-year retention TTL, sized to meet record-keeping minima for adjacent legal frameworks (FINRA 4511, MiCA Art. 66, NYDFS Part 200). Because no personal data is stored, there is no right-to-erasure action a user can take on a specific snapshot.

### Telegram D1 Tables

The visible policy must enumerate every Telegram-owned D1 table, its purpose, and its retention. Canonical schema descriptions live in [`telegram-alerts.md` § D1 Schema](./telegram-alerts.md#d1-schema); retention sources are `worker/src/cron/telegram-retention-cleanup.ts`, `worker/src/cron/telegram-inactive-cleanup.ts`, `worker/src/lib/telegram-constants.ts`, and `worker/src/api/telegram-webhook-store.ts`.

| Table | Purpose | Retention |
|-------|---------|-----------|
| `telegram_subscribers` | Per-chat state (chat ID, optional username, default flags, quiet hours, snooze, `last_active_at`) | 180-day inactive prune via daily `telegram-inactive-cleanup` |
| `telegram_subscriptions` | Per-chat per-coin alert preferences | Kept while subscriber exists; cleared by `/unsubscribe all` or inactivity prune |
| `telegram_preset_subscriptions` | Persistent dynamic preset follows resolved at dispatch | Kept while subscriber exists; cleared by `/unsubscribe all` or inactivity prune |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies, setup wizard, bulk confirms | 5-minute TTL (`DISAMBIGUATION_TTL_SEC`); swept ≥10 min after expiry |
| `telegram_pending_alerts` | Overflow and retry delivery queue | Severity-based TTL: 1 h for depeg/dews/safety/legacy, 30 min for launch and admin broadcasts |
| `telegram_alert_jobs` / `telegram_alert_job_targets` | Durable discovery manifests and per-target delivery audit | 90-day audit retention |
| `telegram_alert_dead_letters` | Expired or permanently failed pending-send audit trail | 90-day audit retention |
| `telegram_processed_updates` | Retry-safe webhook idempotency claims (`update_id`, status, error class) | 7-day prune |
| `telegram_usage_daily` | Privacy-preserving daily command/setup/action aggregates; no `chat_id` is stored | 400-day aggregate retention |
| `telegram_watcher_lifecycle_daily` | Daily active-watcher snapshots for public pulse history | Aggregate (no per-chat detail); not pruned automatically |
| `telegram_chat_delivery_diagnostics` | Per-chat delivery diagnostics used by `/health` | Kept while subscriber exists; 90-day stale prune |

### Mini App `initData`

The `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate` endpoints validate signed Telegram `initData` but never persist it — neither the raw `initData` nor its hash is written to the `cache` table or any other store. Mutation requests are bounded by a short freshness window plus a per-user mutation cooldown rather than a one-shot replay claim: Telegram exposes a single `initData` value per launch, so reusing it across several edits inside the window is expected. The mutation freshness window is 5 minutes (`TELEGRAM_MINI_APP_MUTATION_AUTH_MAX_AGE_SEC`); session reads accept `auth_date` within the last 24 hours (`TELEGRAM_MINI_APP_SESSION_AUTH_MAX_AGE_SEC`).

### Telemetry Contract

- `src/app/layout.tsx` injects the GA4 script only when `NEXT_PUBLIC_GA_ID` is set. When that env var is unset, Pharos does not load Google Analytics and `src/lib/analytics.ts` becomes a no-op wrapper around `window.gtag`.
- `src/lib/analytics.ts` is the typed event catalog for custom telemetry. Current events cover feature adoption (`stress_test_run`, `comparison_*`), engagement (`search_performed`, `filter_applied`, `time_range_changed`, `sort_changed`, `contract_copied`), portfolio actions, and UI toggles (`theme_toggled`, `panel_toggled`).
- The policy page is static and frontend-only, but its analytics claims must stay aligned with both `src/app/layout.tsx` and `src/lib/analytics.ts`.

---

## Navigation And Discoverability

- Footer links point to `/privacy/` from both desktop and mobile footer layouts in `src/components/footer.tsx`.
- The route is included in `src/app/sitemap.ts`.
- The design-language doc treats this page as a constrained longform layout (`max-w-2xl`).

---

## Update Rules

When editing privacy-policy copy, keep these surfaces aligned:

1. `src/app/privacy/page.tsx` for the visible policy text and metadata
2. this document for route-level behavior and integration notes
3. any footer-navigation changes in `src/components/footer.tsx`

If the policy date changes, update the visible `Last updated:` line in the page component in the same change.

---

## File Index

| File | Role |
|------|------|
| `src/app/privacy/page.tsx` | Longform privacy policy route and metadata |
| `src/components/feature-page-shell.tsx` | Shared longform shell used by the route |
| `src/components/footer.tsx` | Footer links to `/privacy/` |
| `src/app/sitemap.ts` | Includes `/privacy/` in sitemap output |
| `docs/design-language.md` | Layout token reference for the page width constraint |
