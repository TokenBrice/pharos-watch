# PharosWatchBot Mini App

Runtime reference for the Telegram Mini App control panel that ships alongside PharosWatchBot. This doc covers launch surfaces, the `?startapp=` payload registry, seam rules, auth model, BotFather operator state, debugging, and test fixtures.

For the broader Telegram subsystem behavior (commands, alert pipelines, schema), see [`telegram-alerts.md`](./telegram-alerts.md). For the worker-side seam ownership rules, see [`telegram-architecture.md`](./telegram-architecture.md).

## Overview

The Mini App is the Telegram-native control panel for managing PharosWatchBot subscriptions, quiet hours, snooze state, and delivery health. It is served as a static Next.js route under `/pharoswatchbot/app/` and hosted at `https://pharos.watch/pharoswatchbot/app/`. The route is `noindex`-marked because it is an embedded tool, not SEO content.

Launch is private-chat scoped for the current phase: bot commands and alert delivery continue to work in groups, but Web App launch buttons are attached only to private-chat replies. Group, supergroup, and channel chats remain in command-only mode until a safe numeric `chat_id` mapping and fresh admin verification path exist.

Owned files:

- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/app/types.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `worker/src/api/telegram-mini-app-schemas.ts`
- `worker/src/lib/telegram-mini-app-auth.ts`

## Launch Surfaces

The full inventory of launch entrypoints and their reconciliation paths is documented in [`telegram-alerts.md`](./telegram-alerts.md#mini-app-launch-entrypoints). Summary:

- **Persistent menu button.** The five-minute Telegram reconciliation lane sets the default menu button to `Manage Alerts` with a Web App URL of `/pharoswatchbot/app/` via `setChatMenuButton`. The cache TTL is 15 minutes, so drift heals within one cache cycle.
- **Bot profile Main Mini App.** Configured through BotFather as `Launch app`; preview media and loading-screen customization are BotFather-owned and are not reconciled by Worker code. See [`runbooks/telegram-mini-app-botfather.md`](./runbooks/telegram-mini-app-botfather.md) for the operator-owned state.
- **Private command replies.** `/start`, `/settings`, `/list`, and `/status <ticker>` attach Web App buttons in private chats. Group and supergroup replies keep their existing command and callback keyboards.
- **Direct deep links.** `https://t.me/PharosWatchBot?startapp=<payload>` may open the app with a start parameter. Telegram reports private direct-link launches as `chat_type="sender"`, which the backend treats as the user's private alert settings context.

## Payload Scheme

Mini App launches accept a `?startapp=<payload>` parameter that selects the initial view. Both parsers — the worker `?start=` deep-link parser in `worker/src/api/telegram-webhook-parsing.ts` and the frontend `?startapp=` parser in `src/app/pharoswatchbot/app/client.tsx` — import the same registry from `shared/lib/telegram-mini-app-payloads.ts` so drift between the bot and the Mini App is impossible.

Recognized payloads:

| Payload | Routes to | Notes |
|---|---|---|
| `home` | Home panel | Default if no payload, or used by `/help` and the `/start` skip branch. |
| `settings` | Settings panel | Global alert toggles, depeg step, quiet hours, clear snooze. |
| `watchlist` | Watchlist panel | Per-coin subscriptions and tune controls. |
| `coin_<stablecoinId>` | Watchlist panel scrolled to coin row | Used by per-coin Web App buttons, `/why`, `/coverage`, alert keyboards. |
| `presets` | Presets panel | Followed presets plus available ones. |
| `quiet-hours` | Settings panel (quiet-hours card) | Used by `/mute`, `/unmutehours` private replies. |
| `snooze` | Settings panel (snooze card) | Used by per-coin or chat snooze ack. |
| `health` | Delivery health panel | Used by `/health` private reply. |
| `forget` | Privacy panel | Used by the `/forget` command. |
| `setup_recommended` | Recommended-setup confirmation | Used by the wizard's "Open control panel" button. |

Payload constraints (mirroring `?start=`): max 64 characters, charset `[A-Za-z0-9_-]`, no spaces, lowercase. Unknown payloads fall through to the home panel and emit a `mini_app_unknown_payload` usage event so we can detect drifting links in the wild. The payload is treated as untrusted; authorization for every read and mutation still comes from validated `initData`.

## Seam Rules

The Mini App is its own seam in the Telegram architecture; full definition and `Must NOT` rules are at [`telegram-architecture.md` § 9. Mini App surface](./telegram-architecture.md#9-mini-app-surface).

The load-bearing rules:

- Do not duplicate per-coin or preset write SQL outside the existing State / persistence helpers. If a callback-shaped helper is too narrow, extract the shared D1 mutation into `worker/src/api/telegram-webhook-store.ts` (or the matching settings-mutation layer) and have both callbacks and Mini App call it.
- Do not mutate group, supergroup, or channel chat rows until a safe numeric `chat_id` mapping and fresh admin verification path exists. Direct-link `chat_type="sender"` launches are the user's *private* alert context, not a group surface.
- Do not write analytics or cooldown rows before signed `initData` validation succeeds.
- Do not accept mutation auth older than the 5-minute mutation window.
- Do not use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

The Mini App seam does not receive Telegram webhook updates and does not call the Telegram Bot API. Its only inbound surfaces are `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`.

## Auth Model

HMAC validation is implemented in `worker/src/lib/telegram-mini-app-auth.ts`:

- Parse `URLSearchParams` from raw `initData`.
- Require `hash`, `auth_date`, and `user` for mutations.
- Build the data-check string from all fields except `hash` and `signature`, sorted alphabetically, joined by `\n`.
- Derive the secret key with `HMAC-SHA-256(key="WebAppData", message=TELEGRAM_BOT_TOKEN)`.
- Compare the computed hex HMAC with `hash` using timing-safe comparison.
- Try `TELEGRAM_BOT_TOKEN` first and fall back to `TELEGRAM_BOT_TOKEN_PREVIOUS` when configured, so `initData` signed by either token validates during a bot-token rotation overlap. See [`runbooks/telegram-secret-rotation.md`](./runbooks/telegram-secret-rotation.md) for the rotation contract.

Freshness windows:

- **Session reads (`POST /api/telegram-mini-app/session`):** `auth_date` must be within 24 hours. A 24-hour read window keeps long-lived open Mini Apps usable across the day.
- **Mutations (`POST /api/telegram-mini-app/mutate`):** `auth_date` must be within 5 minutes. Stale-auth rejections emit a `mini_app_session_invalid` usage event; the client should call the session endpoint to obtain a fresh launch and prompt the user to retry.

Replay protection uses a one-shot claim cache keyed on the `initData` hash, so a stolen `initData` cannot be reused even within its freshness window.

Group, supergroup, and channel chat types are read-only in the current phase. The Mini App surfaces an explicit "Use `/settings@PharosWatchBot` in the group for now" affordance instead of failing silently.

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

- `worker/src/lib/__tests__/telegram-mini-app-auth.test.ts` — HMAC validation, freshness windows, replay protection, group/supergroup read-only behavior, bot-token rotation overlap.
- `worker/src/api/__tests__/telegram-mini-app.test.ts` — session and mutation endpoint behavior, state contract, mutation cooldowns, partial-failure rollback.
- `src/app/pharoswatchbot/app/page.test.tsx` — client preview state and post-launch rendering.
