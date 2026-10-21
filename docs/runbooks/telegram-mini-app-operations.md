# Runbook: Telegram Mini App Operations

Use this runbook for Mini App signed-session failures and for the BotFather-owned configuration that Worker code does not reconcile. The [Mini App contract](../telegram-mini-app.md) owns launch, payload, auth and client-state behavior.

## Auth Failures

### Symptom

`mini_app_session_invalid` usage events spike in `telegram_usage_daily`, or users report that the Mini App opens but every edit fails with "session expired, please relaunch from Telegram".

- Session reads record `mini_app_session_invalid` with outcomes `stale-auth` (expired but signature-valid) or `rate_limited` (session cooldown exceeded). Stale signed writes record `mini_app_mutation_denied` with failure class `stale-auth` and a normalized `action_detail` (`coin`, `preset`, `quiet_hours`, `chat`, …). Stale-auth events are deduplicated per expired `initData` hash and event type for 7 days, so they count expired launches, not retries; every retry still returns `401 stale-auth`.
- Body-size (`413`), schema (`400 validation-error`), invalid-signature and malformed-auth failures write no usage analytics. Use HTTP status/code and [preauth telemetry](./telegram-webhook.md#preauth-ingress-abuse-controls) for those.
- `mini_app_mutation_denied` with `failure_class = 'rate_limited'` means a user or script exhausted the mutation budget: 12 attempts per Telegram user in a 30-second window anchored to the first admitted write. This is distinct from Bot API rate limits.

### Quick Diagnostic Checklist

1. **Bot token rotation gap?** If `TELEGRAM_BOT_TOKEN` was rotated and `TELEGRAM_BOT_TOKEN_PREVIOUS` is unset or wrong, prior-token `initData` fails signature validation: expect `401` responses but no rise in `mini_app_session_invalid`. Check `cd worker && npx wrangler secret list` and follow [secret rotation](./telegram-webhook.md#secret-rotation).
2. **Stale clients?** A Mini App left open more than 5 minutes keeps its launch `auth_date`; mutations need a fresh launch, while reads stay valid for 24 hours. The age of the alert or deep link is not the session age.
3. **Invalid signatures?** Persistent invalid-signature volume outside a rotation points to malformed launch data, token mismatch or tampering. No mutation reaches D1 before HMAC validation succeeds.
4. **Request path degraded?** Diagnose the session/mutation handlers and the pulse loader independently. Alert delivery health does not authenticate Mini App requests.

### Operator Queries

Per-outcome split:

```sql
SELECT day, outcome, failure_class, SUM(count) AS events
FROM telegram_usage_daily
WHERE event_type = 'mini_app_session_invalid' AND day >= date('now', '-7 days')
GROUP BY day, outcome, failure_class
ORDER BY day DESC, events DESC;
```

Stale-auth mutation denials by operation:

```sql
SELECT day, action_detail, SUM(count) AS denials
FROM telegram_usage_daily
WHERE event_type = 'mini_app_mutation_denied' AND failure_class = 'stale-auth'
  AND day >= date('now', '-7 days')
GROUP BY day, action_detail
ORDER BY day DESC, denials DESC;
```

Mutation-limit ratio before changing the budget:

```sql
SELECT
  SUM(CASE WHEN event_type = 'mini_app_mutation_denied' AND failure_class = 'rate_limited' THEN count ELSE 0 END) AS rate_limited,
  SUM(CASE WHEN (event_type IN ('mini_app_mutation', 'mini_app_recommended_setup', 'mini_app_coin_add',
                                'mini_app_coin_remove', 'mini_app_quiet_hours', 'mini_app_snooze',
                                'mini_app_coin_snooze', 'mini_app_forget')
                 OR (event_type IN ('timezone_change', 'unsubscribe')
                     AND source_category IN ('startapp', 'menu_or_main_app')))
            AND outcome = 'success' THEN count ELSE 0 END) AS successful
FROM telegram_usage_daily
WHERE day >= date('now', '-7 days');
```

### Remediation

1. **Rotation gap.** Set `TELEGRAM_BOT_TOKEN_PREVIOUS` to the prior token and redeploy; sessions signed by either token validate during the overlap.
2. **Stale clients.** No operator action. On `stale-auth` the Mini App stops resending the expired `initData` and shows one "Reopen to edit" state; the MainButton relaunches through a `?startapp=` deep link to the current panel.
3. **Invalid signatures.** Inspect recent launch-link changes and Telegram client reports before changing backend auth rules.

## BotFather Configuration

BotFather owns the Main Mini App URL, profile launch toggle, preview screenshots and loading-screen customization. The Worker reconciles bot name, descriptions, default menu button, allowed updates and the command list ([operational notes](../telegram-alerts.md#operational-notes)). Verify quarterly or after a BotFather UI change.

### Configured State

| Item | Value | Notes |
|---|---|---|
| Bot username | `@PharosWatchBot` | — |
| Main Mini App URL | `https://pharos.watch/pharoswatchbot/app/` | Mirrors `TELEGRAM_MINI_APP_URL` in `worker/src/telegram/common/mini-app-url.ts`. |
| Profile launch ("Launch app") | enabled | Operator toggle; no code path. |
| Default menu button | `Manage Alerts` → `https://pharos.watch/pharoswatchbot/app/` | Reconciled by the Worker (`setChatMenuButton`); listed for completeness. |
| Preview screenshots / video | _operator-captured outside repo_ | Record filenames and SHAs in the quarterly review; update after material UI changes. |
| Loading-screen icon | _operator-captured outside repo_ | Square; match current `public/pharos-mark.png`. |
| Loading background color | _operator-captured outside repo_ | Record the configured hex in the quarterly review. |

Inline Mode is not supported; disabling it through BotFather `/setinline` is optional cleanup. Worker registration excludes inline updates, and unsolicited updates are acknowledged without a reply under the [ingress contract](../telegram-architecture.md#1-ingress).

### Smoke Tests

Run after each Mini App deploy and each BotFather UI change. Each test should land on the named view within three seconds with no console errors.

1. **Menu button**: `@PharosWatchBot` → `Manage Alerts` opens **Home**.
2. **Profile launch**: bot profile → `Launch app` opens **Home**.
3. **Deep links**: each payload in the [payload scheme](../telegram-mini-app.md#payload-scheme) as `https://t.me/PharosWatchBot?startapp=<payload>` lands on its named view (for example `startapp=coin_usdc-circle`).
4. **Unknown payload**: `startapp=zzz-unknown` opens **Home** without mutating state.
5. **Cross-platform**: repeat 1, 2 and one parametric link on Telegram Desktop, iOS and Android; the bridge loads, `initData` is signed, and no frame-denial headers appear.

A failing smoke test is a Mini App release blocker; follow the [debugging workflow](../telegram-mini-app.md#debugging-workflow) before re-running.
