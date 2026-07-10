# PharosWatchBot Mini App

Runtime reference for the Telegram Mini App control panel that ships alongside PharosWatchBot. This doc covers launch surfaces, the `?startapp=` payload registry, seam rules, auth model, BotFather operator state, debugging, and test fixtures.

For the broader Telegram subsystem behavior (commands, alert pipelines, schema), see [`telegram-alerts.md`](./telegram-alerts.md). For the worker-side seam ownership rules, see [`telegram-architecture.md`](./telegram-architecture.md).

## Overview

The Mini App is the Telegram-native control panel for managing PharosWatchBot subscriptions, quiet hours, snooze state, and delivery health. It is served as a static Next.js route under `/pharoswatchbot/app/` and hosted at `https://pharos.watch/pharoswatchbot/app/`. The route is marked `noindex,nofollow`, disallowed in `robots.ts`, and omitted from the sitemap because it is an embedded tool, not SEO content.

Launch is private-chat scoped for the current phase: bot commands and alert delivery continue to work in groups, but Web App launch buttons are attached only to private-chat replies. Group, supergroup, and channel chats remain in command-only mode until a fresh admin verification path and group-scoped launch ownership model exist.

Owned files:

- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/components/*`
- `src/app/pharoswatchbot/app/constants.ts`
- `src/app/pharoswatchbot/app/error-messages.ts`
- `src/app/pharoswatchbot/app/format.ts`
- `src/app/pharoswatchbot/app/mini-app-api.ts`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/app/telegram-theme.ts`
- `src/app/pharoswatchbot/app/types.ts`
- `src/app/pharoswatchbot/app/use-mini-app-mutations.ts`
- `src/app/pharoswatchbot/app/use-telegram-bridge.ts`
- `src/app/pharoswatchbot/app/use-telegram-main-button.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-rate-limit.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `worker/src/lib/telegram-mini-app-auth.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `shared/lib/telegram-presets.ts`
- `shared/data/stablecoins/coins.telegram-mini-app.generated.json`

## Launch Surfaces

The full inventory of launch entrypoints and their reconciliation paths is documented in [`telegram-alerts.md`](./telegram-alerts.md#mini-app-launch-entrypoints). Summary:

- **Persistent menu button.** The five-minute Telegram reconciliation lane sets the default menu button to `Manage Alerts` with a Web App URL of `/pharoswatchbot/app/` via `setChatMenuButton`. The cache TTL is 15 minutes, so drift heals within one cache cycle.
- **Bot profile Main Mini App.** Configured through BotFather as `Launch app`; preview media and loading-screen customization are BotFather-owned and are not reconciled by Worker code. See [`runbooks/telegram-mini-app-botfather.md`](./runbooks/telegram-mini-app-botfather.md) for the operator-owned state.
- **Private command replies.** `/start`, `/help`, `/presets`, `/settings`, `/list`, `/status <ticker>`, `/why <ticker>`, `/coverage <ticker>`, `/set`, `/mute`, `/unmutehours`, `/timezone`, `/unsnooze`, `/pause`, `/health`, and `/forget` attach Web App buttons where the reply can open a matching panel. Quick-subscribe confirmations in private chats also attach a per-coin tuning button. Group and supergroup replies keep their existing command and callback keyboards.
- **Direct deep links.** `https://t.me/PharosWatchBot?startapp=<payload>` may open the app with a start parameter. Telegram reports private direct-link launches as `chat_type="sender"`, which the backend treats as the user's private alert settings context.

## Payload Scheme

Mini App launches accept a `?startapp=<payload>` parameter that selects the initial view. The frontend `?startapp=` surface uses the shared parser from `shared/lib/telegram-mini-app-payloads.ts`. The worker `/start <payload>` parser in `worker/src/api/telegram-webhook-parsing.ts` shares the same charset constant but intentionally supports only bot-command payload schemes: `sub_*`, `status_*`, `why_*`, `coverage_*`, `setup`, `sample`, and `app`/`home`.

Recognized payloads:

| Payload | Routes to | Notes |
|---|---|---|
| `home` | Home panel | Default if no payload, or used by the `/start` skip branch. |
| `settings` | Settings panel | Global alert toggles, depeg step, quiet hours, clear snooze; used by `/help` and `/settings`. |
| `watchlist` | Watchlist panel | Per-coin subscriptions and tune controls; used by `/list` and all-stablecoin `/set` confirmations. |
| `coin_<stablecoinId>` | Watchlist panel scrolled to coin row or launch-target card | Used by per-coin Web App buttons, `/status`, quick-subscribe confirmations, alert keyboards, and per-coin `/set` confirmations. If the coin is in the Mini App catalog but not already followed, the Watchlist tab renders a followable Launch target card. |
| `why_<stablecoinId>` | Watchlist panel with an in-app why view | Used by `/why` launch contexts and Mini App coin cards. Shows available Mini App watch context and keeps the existing bot-DM `/why` deep link as the full explainer fallback. |
| `coverage_<stablecoinId>` | Watchlist panel with an in-app coverage view | Used by `/coverage` launch contexts and Mini App coin cards. Shows available Mini App catalog/watch context and keeps the existing bot-DM `/coverage` deep link as the full coverage-card fallback. |
| `presets` | Presets panel | Followed presets plus available ones; used by `/presets`. |
| `quiet-hours` | Settings panel | Used by `/mute`, `/unmutehours`, and `/timezone` private replies. |
| `snooze` | Home panel | Used by per-coin or chat snooze acknowledgements, including `/unsnooze`. |
| `health` | Home panel | Used by `/health` private reply. |
| `forget` | Settings panel | Used by the `/forget` command danger-zone entrypoint. |
| `setup_recommended` | Watchlist panel | Legacy alias retained for older launch buttons. |

`sample` is intentionally **not** a Mini App view token. It is a bot-command `/start sample` payload only (private-chat-only; runs the `/sample` synthetic preview), like `sub_*`/`status_*`. The Home panel surfaces it via a "Send me a sample alert" button that calls `webApp.openTelegramLink("https://t.me/PharosWatchBot?start=sample")` rather than routing inside the app, because the Mini App cannot call the Bot API directly.

Payload constraints: the frontend `?startapp=` parser accepts up to 512 characters (`TELEGRAM_STARTAPP_PAYLOAD_MAX_LENGTH`); the worker `?start=` parser is capped at 64 (`TELEGRAM_START_PAYLOAD_MAX_LENGTH`). Both share the charset `[A-Za-z0-9_-]` (`TELEGRAM_MINI_APP_PAYLOAD_PATTERN`) but not the length constant. In practice every payload we emit stays well under 64. No spaces, lowercase. Unknown payloads fall through to the home panel. Parametric coin payloads whose id is in the Mini App catalog but not already followed render a launch-target card with Follow / Why / Coverage / View actions; ids no longer in the catalog render a read-only no-change fallback. The payload is treated as untrusted; authorization for every read and mutation still comes from validated `initData`. Signed `initData.start_param` values outside the Mini App payload envelope are ignored as `null` rather than rejecting the whole session.

The `recommended-setup` mutation is a single canonical, fail-closed preset: `usd-top25` with `dews` and `depeg`. Its operation schema and type live once in `shared/lib/telegram-mini-app-contract.ts`; broader preset follows use the separate `follow-preset` mutation.

For an already-followed preset, the Presets panel allows DEWS, depeg, and safety-family edits but keeps at least one family enabled. When only one remains, its toggle is disabled and the panel directs the user to **Unfollow** to stop the preset entirely. This keeps the client from offering an all-disabled preset state that the mutation schema rejects.

Per-coin `set-coin` patches treat a non-null `depegStepBps` as an enabling operation unless the same patch explicitly disables `alertTypes.depeg`. The Mini App frontend normally sends `alertTypes.depeg=true` with a step when the visible toggle is off, but the worker owns the semantic guarantee so direct mutation callers cannot store an inactive depeg step.

The `subscriptions[]` state projection includes rows with at least one enabled alert family, plus snooze-only rows. All-disabled rows with no per-coin snooze are hidden so old clear/disable writes do not appear as active watchlist coins.

The reserve-drift family (C123) is exposed as an untunable per-coin and global on/off toggle, like launch. `set-coin` patches carry an optional `reserve: boolean`, the global toggle uses `set-global` with `alertType: "reserve"`, and a coin whose only enabled families are untunable (launch and/or reserve) renders the C115 "on/off only. No tuning." line in `CoinCard`. There is no per-coin tuning surface for reserve.

## Seam Rules

The Mini App is its own seam in the Telegram architecture; full definition and `Must NOT` rules are at [`telegram-architecture.md` § 9. Mini App surface](./telegram-architecture.md#9-mini-app-surface).

The load-bearing rules:

- Do not duplicate per-coin or preset write SQL outside the existing State / persistence helpers. If a callback-shaped helper is too narrow, extract the shared D1 mutation into `worker/src/api/telegram-webhook-store.ts` (or the matching settings-mutation layer) and have both callbacks and Mini App call it.
- Do not mutate group, supergroup, or channel chat rows until a fresh admin verification path and group-scoped launch ownership model exist. Direct-link `chat_type="sender"` launches are the user's *private* alert context, not a group surface.
- Do not write analytics, aggregate counters, or rate-limit rows before signed `initData` validation succeeds. Body-too-large, malformed JSON, and schema-denied requests must fail without D1 writes because the Mini App endpoints are public API-key-exempt surfaces.
- Do not accept mutation auth older than the 5-minute mutation window.
- Do not use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

The Mini App seam does not receive Telegram webhook updates and does not call the Telegram Bot API. Its only inbound surfaces are `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`.

## Contract And Catalog Versioning

`shared/lib/telegram-mini-app-contract.ts` is the single runtime-neutral contract for operation schemas, request and response DTO schemas, error codes, the contract version, the catalog version, and the opaque state revision. Worker handlers and the static client both import it directly; there is no Worker/frontend literal mirror to keep synchronized.

The searchable coin catalog is projected by `scripts/build-data/build-client-registry.mjs` into `shared/data/stablecoins/coins.telegram-mini-app.generated.json`. `shared/lib/telegram-mini-app-catalog.ts` combines that slim asset with the shared preset definitions and derives a content version. The catalog is bundled into the fingerprinted static Mini App JavaScript, so its roughly 42 KB minified payload is cached with the Pages asset instead of being returned by every signed API call.

New clients advertise `mini_app_contract` and `mini_app_catalog` query parameters. A matching Worker returns `{ contractVersion, catalogVersion, stateRevision, state }`; `state` contains only viewer/subscriber/preset/subscription/health data and never the immutable catalog. A request with neither parameter is treated as a legacy client and receives the former full-catalog state shape during the rolling-deploy compatibility window. Conversely, an older Worker ignores the new query parameters and returns its full state, which the new client can still parse. Query negotiation avoids adding custom request headers, so cached new clients remain CORS-compatible with an older Worker.

Version skew returns `409 contract-version-mismatch` or `409 catalog-version-mismatch` before auth cooldown, mutation burst, analytics, or persistence writes. The client does not replay a rejected mutation. It stores only the non-identifying target-version pair in `sessionStorage` and reloads the fingerprinted static bundle at most once for that target; a repeated mismatch asks the user to close and reopen the Mini App.

## Effective Alert Source

Each direct/local coin row's `CoinCard` renders a compact source chip derived purely from already-projected session state (`computeEffectiveSource(coin, globalAlerts, presets)` in `src/app/pharoswatchbot/app/format.ts`), so it adds no extra reads. The session payload includes the five `alertOverrides` markers alongside the five alert flags; the client must use those markers rather than interpreting every zero flag as an opt-out. The helper mirrors the `/list` precedence model (**per-coin > preset > all-stablecoins**, see [`telegram-alerts.md`](./telegram-alerts.md)), while the current chip copy collapses preset/global coverage into inherited-default labels because the session payload does not expand preset membership per coin:

- **Per-coin** — the coin has at least one explicit per-coin alert flag enabled; that lane wins over preset/global.
- **Muted override** — at least one inherited family is off with its matching explicit override marker set, so that family suppresses the preset/global default.
- **All-stablecoins** — fallback chip for displayed snooze-only/off rows that have no enabled per-coin flag and no preset/global coverage.

`computeEffectiveSource` returns the source per alert type; the chip shows the dominant display lane. An unmarked off flag inherits preset/global coverage and never renders as an opt-out. `PresetsPanel` labels preset coverage at the preset level only; it does not expand presets into member coins because preset-to-coin membership is dynamic, absent from the session payload, and authoritative only when resolved against the current cache. Following and unfollowing a preset changes only `telegram_preset_subscriptions`; direct/local coin rows remain unchanged.

## Auth Model

HMAC validation is implemented in `worker/src/lib/telegram-mini-app-auth.ts`:

- Parse `URLSearchParams` from raw `initData`.
- Require `hash`, `auth_date`, and `user` for both Mini App endpoints.
- Build the bot-token HMAC data-check string from all fields except `hash`, sorted alphabetically, joined by `\n`.
- Derive the secret key with `HMAC-SHA-256(key="WebAppData", message=TELEGRAM_BOT_TOKEN)`.
- Compare the computed hex HMAC with `hash` using timing-safe comparison.
- Try `TELEGRAM_BOT_TOKEN` first and fall back to `TELEGRAM_BOT_TOKEN_PREVIOUS` when configured, so `initData` signed by either token validates during a bot-token rotation overlap. See [`runbooks/telegram-secret-rotation.md`](./runbooks/telegram-secret-rotation.md) for the rotation contract.

Freshness windows:

- **Session reads (`POST /api/telegram-mini-app/session`):** `auth_date` must be within 24 hours. A 24-hour read window keeps long-lived open Mini Apps usable across the day.
- **Mutations (`POST /api/telegram-mini-app/mutate`):** `auth_date` must be within 5 minutes. Telegram exposes one signed `initData` value for the launch, so a fresh launch may perform multiple mutations with the same `initData` until the freshness window expires. Stale-auth rejections first pass the signed user through the per-user Mini App cooldown before they can emit a `mini_app_session_invalid` usage event; the client reloads the session endpoint for read-only state, then prompts the user to close and reopen the Mini App before retrying mutations. That stale-auth prompt is rendered by the client shell above every tab panel, not only on Home, because all tabs remain readable while mutations are blocked.

Mutation auth is bounded by the short freshness window plus a per-user burst budget of 12 schema-valid, signature-valid mutation attempts in an anchored 30-second window. The window begins at the first admitted write, so adjacent wall-clock buckets cannot admit a double burst. This budget allows a normal settings pass (all five global toggles plus one quiet-hours save) without delay while bounding scripted state writes. Attempts beyond the budget return HTTP 429 with the same integer `retryAfterSec` in the JSON body and `Retry-After` header. The client disables mutation controls for that interval, renders a visible non-live countdown, announces the start and end once through its polite status channel, keeps session refresh available, and does not automatically replay writes.

The burst counter is independent of operation semantics and webhook replay protection: it does not make `initData` a one-shot credential, and it does not replace `telegram_processed_updates` deduplication for webhook updates. Do not add one-shot `initData` replay claims to the mutation path; they break normal multi-edit Mini App sessions because Telegram does not refresh `initData` between edits. Mini App operations remain set-shaped/idempotent where their domain permits, but the client still requires an explicit user action after a 429 rather than automatically retrying destructive mutations. `/forget` deletes the identity-linked burst key, and the retention cron prunes stale burst keys under the bounded seven-day short-lived-cache policy.

Both Mini App API endpoints reject request bodies above 16 KiB before JSON parsing, schema validation, HMAC validation, analytics, or rate-limit writes. The limit is enforced with `Content-Length` when present and with a bounded stream reader for chunked or incorrect-length bodies. Body-cap, JSON-parse, and schema failures intentionally perform no D1 writes before auth so unauthenticated clients cannot amplify writes or pollute usage counters.

The embedded `/pharoswatchbot/app` route does not bootstrap Google Analytics and does not send Google page views, custom events, or Web Vitals. Its route-specific CSP allows the Telegram bridge but omits Google Analytics and Tag Manager script, image, and connection origins. This exclusion is exact to the Mini App route and descendants; the public `/pharoswatchbot` product page keeps normal site analytics when GA4 is configured. Required adoption and error visibility comes from the existing first-party `telegram_usage_daily` counters after signed `initData` authentication. Those rows contain low-cardinality event, outcome, chat-type, action-detail, and latency buckets, never a chat ID; rejected pre-auth requests write no counters.

Group, supergroup, and channel chat types are read-only in the current phase. The Mini App surfaces an explicit "Use `/settings@PharosWatchBot` in the group for now" affordance instead of failing silently.

The Mini App stylesheet seeds `--telegram-bg`, `--telegram-text`, and `--telegram-color-scheme` from `prefers-color-scheme: dark` when the document contains `.pharos-mini-app`. Once the Telegram bridge is available, `applyTelegramTheme()` is authoritative. `telegram-theme.ts` validates Telegram's hex colors, preserves already-compliant host colors, and minimally mixes hostile values toward black or white before exporting semantic surface, text, muted-text, button, border, and focus variables. Normal text and button labels target WCAG AA `4.5:1`; control fills, borders, and focus rings target `3:1`. Secondary, section, and control surfaces are kept in the host palette but pulled toward the base background when necessary so one readable text hierarchy remains valid across the shell.

`.pharos-mini-app` scopes the Pharos bridge tokens (`--background`, `--card`, `--foreground`, `--muted`, `--border`, `--ring`) to the normalized Telegram palette so internal cards, tabs, selects, and buttons do not mix a dark Telegram shell with light Pharos controls. Invalid or absent theme anchors clear stale inline palette values and leave the existing CSS fallback theme authoritative. Viewport height, safe-area insets, color-scheme handling, and focus offsets are independent of color normalization.

## BotFather Operator Checklist

BotFather-owned items (Main Mini App URL, profile launch toggle, preview screenshots, loading-screen icon, loading background color) are not reconciled by Worker code. The current configured state plus deploy-time smoke tests live in [`runbooks/telegram-mini-app-botfather.md`](./runbooks/telegram-mini-app-botfather.md). Verify quarterly or after a BotFather UI change.

## Debugging Workflow

Real-device inspection paths for triaging Mini App issues:

- **Telegram Desktop Beta** — `Settings → Advanced → Experimental settings → Enable webview inspecting`, then right-click → Inspect inside the Mini App for full Chrome DevTools.
- **Telegram macOS Beta** — 5-tap the Settings icon → Debug Menu → Debug Mini Apps.
- **Android USB** — Telegram Settings → double-long-press the version label → Enable WebView Debug, then attach `chrome://inspect/#devices`.
- **iOS Safari** — cable to a Mac and use Safari's Develop menu → device list.
- **Eruda toggle** — appending `?debug=eruda` to the Mini App URL loads Eruda from CDN when `NODE_ENV !== "production"`. Use this when you need an in-Telegram console without changing code. The toggle is no-op in production builds.

For incident triage, start at the runbooks rather than DevTools:

- [`runbooks/telegram-mini-app-auth-failures.md`](./runbooks/telegram-mini-app-auth-failures.md) — `mini_app_session_invalid` spikes.
- [`runbooks/telegram-preset-resolution-failure.md`](./runbooks/telegram-preset-resolution-failure.md) — `presetQueryFailures` / `presetResolutionFailures` rising.
- [`runbooks/telegram-setup-wizard-stuck.md`](./runbooks/telegram-setup-wizard-stuck.md) — users report the setup wizard not progressing.
- [`runbooks/telegram-group-admin-gating-rollback.md`](./runbooks/telegram-group-admin-gating-rollback.md) — flipping the group admin gate from hard to soft.

## Test Fixtures

- `worker/src/lib/__tests__/telegram-mini-app-auth.test.ts` — HMAC validation, freshness windows, group/supergroup read-only behavior, bot-token rotation overlap.
- `worker/src/api/__tests__/telegram-mini-app.test.ts` — session and mutation endpoint behavior, state contract, burst-limit responses, partial-failure rollback.
- `worker/src/api/__tests__/telegram-mini-app-rate-limit.test.ts` — real-SQLite atomic burst admission, exact retry windows, rollover, D1 failure behavior, `/forget`, and retention cleanup.
- `shared/lib/__tests__/telegram-mini-app-contract.test.ts` — operation parse parity, compact/legacy response schemas, catalog version, and capability compatibility.
- `src/app/pharoswatchbot/app/mini-app-api.test.ts` — compact-state hydration, new-client/old-Worker compatibility, capability parameters, and one-shot version refresh.
- `src/app/pharoswatchbot/app/page.test.tsx` — client preview state and post-launch rendering.
- `src/app/pharoswatchbot/app/telegram-theme.test.ts` / `telegram-sdk.test.ts` — WCAG contrast normalization, hostile light/dark Telegram palettes, CSS variable publication, fallback clearing, viewport, and safe-area behavior.
- `tests/visual/telegram-mini-app-launch.spec.ts` — standalone/signed launch behavior, 320 px control sizing, and an authenticated hostile-theme axe color-contrast fixture.
