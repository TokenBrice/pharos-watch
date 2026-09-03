# Runbook: PharosWatchBot BotFather Configuration

BotFather owns the bot-profile metadata, Main Mini App URL, profile launch toggle, preview screenshots, and loading-screen customization. None of these are reconciled by Worker code (bot name, short/long description, default menu button, allowed updates, and command list **are** reconciled — see [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Operational Notes"). This runbook captures the operator-owned fields that must be checked, including placeholders for BotFather-only assets that are not observable from the repo, plus the smoke-test checklist that must pass after each deploy and after each BotFather UI change.

Verify quarterly or after a BotFather UI change.

## Configured State

| Item | Value | Notes |
|---|---|---|
| Bot username | `@PharosWatchBot` | — |
| Main Mini App URL | `https://pharos.watch/pharoswatchbot/app/` | Mirrors `TELEGRAM_MINI_APP_URL` in `worker/src/lib/telegram/webhook-registration.ts`. |
| Profile launch ("Launch app") | enabled | Operator toggles this in BotFather; no code path. |
| Default menu button | `Manage Alerts` → `https://pharos.watch/pharoswatchbot/app/` | Reconciled by the Worker (`setChatMenuButton`); listed here for completeness. |
| Mini App preview screenshots | _operator-captured outside repo_ | Record current filenames and SHAs during quarterly BotFather review; update when the Mini App UI ships a material change. |
| Mini App preview video | _operator-captured outside repo_ | Optional; omit if no current video. |
| Loading-screen icon | _operator-captured outside repo_ | Record current filename and SHA during quarterly BotFather review. Square; should match the Pharos avatar (`public/pharos-mark.png`). Brand mark refreshed 2026-07-31 — re-upload. |
| Loading background color | _operator-captured outside repo_ | Record the configured hex during quarterly BotFather review. |

Rows marked `operator-captured outside repo` are not source-controlled assets today. Capture their live BotFather values in the quarterly review note or update this runbook when the assets become repo-owned.

## Smoke Tests

Run after each Mini App deploy and after each BotFather UI change. Each test should open the Mini App and land on the named view inside three seconds; no console errors in DevTools.

1. **Menu button** — Open Telegram → `@PharosWatchBot` → tap the persistent `Manage Alerts` menu button. Mini App loads on the **Home** panel.
2. **Profile launch** — Open the bot's profile in Telegram → tap `Launch app`. Mini App loads on the **Home** panel.
3. **Deep-link spot check** — Exercise each payload in [`docs/telegram-mini-app.md`](../telegram-mini-app.md#payload-scheme) as `https://t.me/PharosWatchBot?startapp=<payload>` and confirm each lands on the panel that table names. Parametric payloads (`coin_`, `why_`, `coverage_`) take a tracked stablecoin id, for example `startapp=coin_usdc-circle`.
4. **Unknown payload fallback** — Tap `https://t.me/PharosWatchBot?startapp=zzz-unknown`. Mini App loads on the **Home** panel without mutating alert state.
5. **Cross-platform render** — Repeat tests 1, 2, and a parametric deep link such as `startapp=coin_usdc-circle` on Telegram Desktop, iOS, and Android. The Telegram bridge script loads, `initData` is signed, and there are no frame-denial headers.

If any smoke test fails on a deploy, treat the failing payload as a Mini App release blocker and follow [`docs/telegram-mini-app.md`](../telegram-mini-app.md) section "Debugging Workflow" before re-running.

## Cross-References

- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — payload registry, auth model, launch surfaces.
- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Mini App Launch Entrypoints" — Worker-reconciled vs BotFather-owned surfaces.
- [`telegram-mini-app-auth-failures.md`](./telegram-mini-app-auth-failures.md) — when the Mini App loads but auth fails.
- [`telegram-secret-rotation.md`](./telegram-secret-rotation.md) — bot-token and webhook-secret rotation.
