# Runbook: Telegram Webhook

## Symptom

Use this procedure when commands/callbacks disappear on webhook retry, setup buttons stall, webhook/Mini App ingress returns body-limit, rate-limit or unavailable-gate responses, a Telegram secret must be rotated, or the group-admin gate refuses real admins. Alert queue silence belongs to [delivery incidents](./telegram-delivery.md); signed Mini App session/token-age failures belong to [Mini App auth failures](./telegram-mini-app-operations.md#auth-failures).

| Evidence | Branch |
| --- | --- |
| Mini App 400/413/429/503, or webhook 400/413, before handler work | [Preauth ingress abuse controls](#preauth-ingress-abuse-controls) |
| Authenticated commands/callbacks receive busy/throttle responses | [Authenticated flood control](#authenticated-flood-control) |
| Callback spinner fails to clear | [Callback acknowledgements](#callback-acknowledgements) |
| Same update returns 503, stays `processing`, or a reply repeated once | [Current dedupe model](#current-dedupe-model) and [checklist](#quick-diagnostic-checklist) |
| Setup or selection buttons answer "out of date" | [Setup state](#setup-state) |
| Planned or leaked secret/token | [Secret rotation](#secret-rotation) |
| Real group admins refused across many groups | [Group admin gate rollback](#group-admin-gate-rollback) |

Sampled HTTP logs establish request timing; chat/update association comes from D1, never custom Telegram logs. Run SQL as in the [read-only incident entry](./telegram-delivery.md#read-only-incident-entry).

## Current Dedupe Model

`telegram_processed_updates` is a plain update-id claim (`worker/src/telegram/store/processed-updates.ts`). The webhook inserts the id as `processing`; when dispatch returns it marks the row `processed` (with an optional `error_class` for handled failures such as a failed callback or command reply). A thrown error deletes the `processing` claim and returns non-2xx, so Telegram's redelivery is processed. A group-to-supergroup migration that hits a transient D1 failure throws for exactly this reason (the batch is idempotent); a deterministic failure such as a constraint conflict is acked as `processed` with `error_class = chat-migration`, so it cannot block later updates. Mark and release only match this request's own claim (`received_at`), so a request that outlives the stale window never touches a redelivery's row.

Processed duplicates return `200 ok`. A duplicate that finds a fresh `processing` claim returns `503 retry` with `Retry-After` (log action `processed-update-dedupe`). A `processing` claim older than `TELEGRAM_PROCESSING_STALE_SEC` (60 s) belongs to a crashed request and is reclaimed by the next delivery, as are legacy `failed` rows and rows left in older effect-fence states such as `planned`.

Replies are not fenced. A crash after a reply but before the processed marker can repeat that reply once on redelivery; this is accepted at the bot's traffic level. Settings and subscription mutations write explicit target values, so a redelivered update reapplies the same state.

Processed rows retain seven days. Daily `telegram-retention-cleanup` owns capped pruning; webhook traffic does not run retention.

## Quick Diagnostic Checklist

1. **Which gate rejected?** For pre-handler 429/503 or body errors, inspect [preauth rejection telemetry](#preauth-ingress-abuse-controls), not D1 command counters. The webhook has no pre-auth limiter; a 401 handler rejection is signed Mini App auth after admission.
2. **Webhook auth valid?** Invalid `X-Telegram-Bot-Api-Secret-Token` intentionally returns `200 ok` without D1 access or side effects. Inspect secret-validation warnings after rotation.
3. **What did the update claim?** Inspect the exact `update_id` (a missing row after a 5xx means the claim was released for redelivery):

   ```sql
   SELECT update_id, received_at, processed_at, update_type, chat_id, status, error_class
   FROM telegram_processed_updates
   WHERE update_id = <update_id>;
   ```

   Status mix and stale claims:

   ```sql
   SELECT status, COUNT(*) AS rows, MIN(received_at) AS oldest_received_at,
          SUM(CASE WHEN status = 'processing' AND received_at < ? - 60 THEN 1 ELSE 0 END) AS stale_processing
   FROM telegram_processed_updates
   GROUP BY status
   ORDER BY rows DESC;
   ```

## Remediation

- Ask the user to resend when appropriate; a resend is a new update and is never deduplicated against the old one.
- A stuck `processing` row needs no manual repair: it is reclaimable after 60 s and pruned after seven days. Never clear the table.
- If a mutation landed twice, repair the affected chat narrowly; broad subscriber resets are not a dedupe fix.
- Binding/config failures require incident handling or matching Worker rollback, not an isolate-local fallback. Admission and auth are independent; raising a Mini App preauth budget must not bypass signed-session freshness or authenticated flood controls.

## Preauth Ingress Abuse Controls

This branch covers exact `POST /api/telegram-webhook`, `/api/telegram-mini-app/session`, and `/api/telegram-mini-app/mutate` paths. Numeric policy/body ceilings are owned by `TELEGRAM_INGRESS_POLICIES` in `worker/src/telegram/webhook/telegram-ingress-abuse.ts` and matching Rate Limiting bindings in `worker/wrangler.toml`; inspect those together when sizing or changing them. The webhook gets the body cap only: its secret header is compared in constant time without D1 before any work, so it has no pre-auth limiter that an unauthenticated flood could exhaust ahead of Telegram's own deliveries. Rate limiting applies to the two Mini App routes. Native Cloudflare Workers Rate Limiting bindings are permissive, eventually consistent, and per-colo, so the guard is not an account-wide exact quota.

`api.pharos.watch` has the canonical route budget. Other Worker hosts share a separate noncanonical-host key per route. Each source key combines route/host lane and the 128-bit HMAC-SHA256 client-IP hash keyed by `SITE_API_SHARED_SECRET`. Raw IPs never enter keys/logs. Missing IPs share `unknown`; a missing hash secret fails closed. Rotating that secret resets source buckets, not aggregate counters.

**Request cost order** (`worker/src/handlers/http/request-dispatch.ts`): after CORS preflight and maintenance mode, but before Access/API-key gates, routing, Telegram auth, D1, attribution, or usage analytics:

1. Match exact pathname/method and choose canonical/noncanonical lane before normal host gating.
2. Reject malformed declared `Content-Length` with 400 and declared oversize with 413.
3. Mini App routes only: charge source binding first, aggregate path binding only if admitted. Exhaustion returns 429; missing/failed binding or hash secret returns fail-closed 503 with `Retry-After: 1`.
4. Read at most the route body cap, including chunked/misdeclared streams.
5. Only then validate the webhook secret or Mini App HMAC, schema-parse, touch D1, and record authenticated usage.

An over-budget request reads no body, performs no HMAC work, touches no D1, and schedules no attribution writes. A source may consume at most half its route budget. Distributed sources may still exhaust the aggregate; this is fairness, not guaranteed admission.

**Edge posture:** there are no active Telegram-specific WAF rules. `scripts/ci/cloudflare-account-state-manifest.json` owns account state; a proposed exact-path rule is not active until the manifest/drift fixtures are reconciled and the read-only account-state check passes.

**Telemetry:** filter Workers Observability for `event=telegram_ingress_rejection`, then group by `route` (`webhook|mini_app_session|mini_app_mutation`), `status`, `metadata.stage`, and closed `metadata.reason`. Early rejections perform no D1 writes. Records contain no IP, headers, body, initData, chat ID, or user ID.

| Response / stage / reason | Interpretation |
| --- | --- |
| 429 / rate_limit / preauth_rate_limited | Worker per-colo ceiling reached |
| 503 / rate_limit / rate_limit_unavailable | Missing/failed binding: deployment/runtime incident; do not fail open |
| 413 / body_header vs body_stream | Declared oversize vs chunked/misdeclared overflow |
| 401 / handler | Mini App signature/freshness rejected after preauth admission |
| 400 / body_header | Malformed declared length |
| 400 / handler | JSON/schema rejected after bounded read |

**Tuning and rollback:** change the policy module, matching `worker/wrangler.toml` bindings, focused tests (`worker/src/telegram/webhook/__tests__/telegram-ingress-abuse.test.ts`, `request-dispatch.test.ts`) and this table together. Roll back to the prior Worker with its matching configuration; never add an isolate-local fallback. Do not generate production traffic to trip a limit merely to test it.

## Authenticated Flood Control

Commands and callbacks share one fixed-window D1 counter per chat (20 actions / 60 s), owned by `enforceIngressFlood` in `worker/src/telegram/webhook/telegram-webhook-ingress-policy.ts`. It runs after the webhook secret check as one conditional `cache` upsert with `RETURNING`, so concurrent deliveries cannot lose increments. A counter failure logs `command-flood` and denies with a best-effort busy reply. The first over-limit action gets one notice; later ones are dropped silently. There are no per-command cooldowns.

## Callback Acknowledgements

`answerCallbackQuery` dismisses the spinner; repeated flood denials after the first notice skip acknowledgement. Non-OK responses are drained and emit one bounded warning with `action=answer-callback-query`, `statusCode` and `errorClass`; they are not retried inline. `rate_limit`/`server_error` usually mean transient Telegram pressure; `auth_error` requires deployed-token inspection; repeated `bad_request` warrants checking callback payload construction and age. A failed acknowledgement alone does not establish that a D1 action failed or authorize replay.

## Setup State

Setup, ticker selection, bulk confirmation and `/forget` confirmation use stateless callback buttons; the webhook keeps no chat text state and ignores non-command text. A button that answers "out of date" belongs to an older message: ask the user to send the command again.

## Secret Rotation

Rotate one secret at a time. The webhook secret supports an overlap window; the previous bot token is accepted for Mini App `initData` only, and outbound Bot API sends always use the current token.

**Webhook secret.**

1. Generate a new high-entropy `TELEGRAM_WEBHOOK_SECRET`.
2. Move the current value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and set the new value as `TELEGRAM_WEBHOOK_SECRET`.
3. Deploy the Worker. During the overlap the webhook accepts either secret, while registration emits only the new one.
4. Verify with `cd worker && npx wrangler tail stablecoin-api --format pretty`, then send a benign command and confirm normal `telegram-webhook` handling. Invalid-secret probes still return `200 ok` with throttled `auth-missing-secret` / `auth-invalid-secret` warnings.
5. After at least one successful webhook delivery with the new secret (and within 24 hours), remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and redeploy.

**Bot token.**

1. Create the replacement token in BotFather. Do not revoke the old token yet.
2. Set `TELEGRAM_BOT_TOKEN_PREVIOUS` to the current token, then set `TELEGRAM_BOT_TOKEN` to the new one.
3. Deploy. Mini App `initData` signed with the old token stays valid within the normal 24-hour read and 5-minute mutation windows.
4. Verify that the five-minute Telegram slot sends, registration reconciliation succeeds (`/api/status` → `.telegramBot`, `budgetOnlySurfaces`), and `POST /api/telegram-mini-app/session` accepts fresh launches.
5. Revoke the old token in BotFather only after verification. Remove `TELEGRAM_BOT_TOKEN_PREVIOUS` after at least 24 hours in a follow-up deploy.

**Rollback.** If sends, registration or Mini App auth fail after token rotation, restore the previous `TELEGRAM_BOT_TOKEN` and redeploy; sessions signed by the failed new token become invalid, so relaunch the Mini App.

## Group Admin Gate Rollback

Group admins alone may run `/subscribe`, `/unsubscribe`, `/pause` (and `/unsnooze`) and the mutating buttons ([contract](../telegram-alerts.md#group-admin-gating)). The mode is a code toggle, `TELEGRAM_GROUP_ADMIN_GATING.mode` in `worker/src/telegram/webhook/telegram-webhook-ingress-policy.ts`, not an env binding. Hard (default) refuses non-admins; soft (emergency rollback) warns but runs the command. The soft toggle relaxes gated commands only: every mutating callback stays hard-gated and needs a separate code change to relax.

Flip to soft only when the fresh `getChatMember` lookup (or Telegram's admin API) is denying real admins across many groups, the fix cannot land in the deploy window, and non-admin mutations are judged cheaper than every gated command failing. Return to hard within one deploy cycle.

1. Patch the mode and release through the protected flow in [deployment-process.md](../deployment-process.md). A Wrangler secret change has no effect.
2. Confirm the split in the audit log; hard emits `outcome = 'denied'`, soft emits `outcome = 'warned'`. `rate_limited` means the per-chat `group-admin-diagnostics` cooldown suppressed diagnostics after a failed lookup; it blocks the command in both modes.

   ```sql
   SELECT day, outcome, SUM(count) AS events
   FROM telegram_usage_daily
   WHERE event_type = 'group_admin_denial' AND day >= date('now', '-7 days')
   GROUP BY day, outcome
   ORDER BY day DESC, outcome ASC;
   ```

3. Restore hard mode through the same flow once the cause is fixed, and confirm the next non-admin gated command produces `denied` and does not run. `telegram_usage_daily` has no chat or user IDs, so per-chat repair needs separately captured incident evidence.

## Cross-References

- [Update deduplication](../telegram-alerts.md#update-deduplication), [group admin gating](../telegram-alerts.md#group-admin-gating) and [setup behavior](../telegram-alerts.md#setup-wizard).
- [Mini App operations](./telegram-mini-app-operations.md) and [Mini App auth model](../telegram-mini-app.md#auth-model).
- [Delivery incidents](./telegram-delivery.md) for queue transport rather than ingress effects.
