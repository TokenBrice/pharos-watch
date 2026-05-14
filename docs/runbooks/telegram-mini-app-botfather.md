# Runbook: PharosWatchBot BotFather Configuration

BotFather owns the bot-profile metadata, Main Mini App URL, profile launch toggle, preview screenshots, and loading-screen customization. None of these are reconciled by Worker code (bot name, short/long description, default menu button, allowed updates, and command list **are** reconciled — see [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Webhook and Command Registration"). This runbook captures the operator-owned state and the smoke-test checklist that must pass after each deploy and after each BotFather UI change.

Verify quarterly or after a BotFather UI change.

## Configured State

| Item | Value | Notes |
|---|---|---|
| Bot username | `@PharosWatchBot` | — |
| Main Mini App URL | `https://pharos.watch/pharoswatchbot/app/` | Mirrors `TELEGRAM_MINI_APP_URL` in `worker/src/lib/telegram-webhook-registration.ts`. |
| Profile launch ("Launch app") | enabled | Operator toggles this in BotFather; no code path. |
| Default menu button | `Manage Alerts` → `https://pharos.watch/pharoswatchbot/app/` | Reconciled by the Worker (`setChatMenuButton`); listed here for completeness. |
| Mini App preview screenshots | _to be filled by the operator on next BotFather sync — record current filenames and SHAs._ | Update when the Mini App UI ships a material change. |
| Mini App preview video | _to be filled by the operator on next BotFather sync._ | Optional; omit if no current video. |
| Loading-screen icon | _to be filled by the operator on next BotFather sync — record current filename and SHA._ | Square; should match the Pharos avatar (`public/pharos-icon.png`). |
| Loading background color | `#XXXXXX` | Operator fills with the configured hex on next BotFather sync. |

If a row above shows `_to be filled_` or `#XXXXXX`, the operator should capture the live BotFather value into this file as part of the next quarterly review.

## Smoke Tests

Run after each Mini App deploy and after each BotFather UI change. Each test should open the Mini App and land on the named view inside three seconds; no console errors in DevTools.

1. **Menu button** — Open Telegram → `@PharosWatchBot` → tap the persistent `Manage Alerts` menu button. Mini App loads on the **Home** panel.
2. **Profile launch** — Open the bot's profile in Telegram → tap `Launch app`. Mini App loads on the **Home** panel.
3. **Direct deep link: home** — Tap `https://t.me/PharosWatchBot?startapp=home`. Mini App loads on the **Home** panel.
4. **Direct deep link: settings** — Tap `https://t.me/PharosWatchBot?startapp=settings`. Mini App loads on the **Settings** panel.
5. **Direct deep link: watchlist** — Tap `https://t.me/PharosWatchBot?startapp=watchlist`. Mini App loads on the **Watchlist** panel.
6. **Direct deep link: coin row** — Tap `https://t.me/PharosWatchBot?startapp=coin_usdc-circle`. Mini App loads the **Watchlist** panel scrolled to USDC's row.
7. **Direct deep link: presets** — Tap `https://t.me/PharosWatchBot?startapp=presets`. Mini App loads on the **Presets** panel.
8. **Direct deep link: quiet-hours** — Tap `https://t.me/PharosWatchBot?startapp=quiet-hours`. Mini App loads the **Settings** panel with the quiet-hours card focused.
9. **Direct deep link: snooze** — Tap `https://t.me/PharosWatchBot?startapp=snooze`. Mini App loads the **Settings** panel with the snooze card focused.
10. **Direct deep link: health** — Tap `https://t.me/PharosWatchBot?startapp=health`. Mini App loads the **Delivery health** panel.
11. **Direct deep link: forget** — Tap `https://t.me/PharosWatchBot?startapp=forget`. Mini App loads the **Privacy** panel.
12. **Direct deep link: setup_recommended** — Tap `https://t.me/PharosWatchBot?startapp=setup_recommended`. Mini App loads the **Recommended-setup confirmation** view.
13. **Unknown payload fallback** — Tap `https://t.me/PharosWatchBot?startapp=zzz-unknown`. Mini App loads on the **Home** panel without mutating alert state.
14. **Cross-platform render** — Repeat tests 1, 2, 4, and 6 on Telegram Desktop, iOS, and Android. The Telegram bridge script loads, `initData` is signed, and there are no frame-denial headers.

If any smoke test fails on a deploy, treat the failing payload as a Mini App release blocker and follow [`docs/telegram-mini-app.md`](../telegram-mini-app.md) section "Debugging Workflow" before re-running.

## Cross-References

- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — payload registry, auth model, launch surfaces.
- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Mini App Launch Entrypoints" — Worker-reconciled vs BotFather-owned surfaces.
- [`telegram-mini-app-auth-failures.md`](./telegram-mini-app-auth-failures.md) — when the Mini App loads but auth fails.
- [`telegram-secret-rotation.md`](./telegram-secret-rotation.md) — bot-token and webhook-secret rotation.
