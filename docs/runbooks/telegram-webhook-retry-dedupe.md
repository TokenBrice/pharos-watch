# Runbook: Telegram Ingress, Retries and Setup Incidents

## Symptom

Use this procedure when commands/callbacks disappear on webhook retry, setup state stalls, or webhook/Mini App ingress returns body-limit, rate-limit, or unavailable-gate responses. Alert queue silence belongs to [delivery incidents](./telegram-no-delivery.md); signed Mini App session/token-age failures belong to [Mini App auth failures](./telegram-mini-app-auth-failures.md).

| Evidence | Branch |
| --- | --- |
| Mini App 400/413/429/503, or webhook 400/413, before handler work | [Preauth ingress abuse controls](#preauth-ingress-abuse-controls) |
| Authenticated commands/callbacks receive busy/throttle responses | [Authenticated flood control](#authenticated-flood-control) |
| Callback spinner fails to clear | [Callback acknowledgements](#callback-acknowledgements) |
| Same update returns 503, stays `processing`, or a reply repeated once | [Current dedupe model](#current-dedupe-model) and [checklist](#quick-diagnostic-checklist) |
| Setup or selection buttons answer "out of date" | [Setup state](#setup-state) |

Start with the [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry). Sampled HTTP logs establish request timing; chat/update association comes from D1, never custom Telegram logs.

## Current Dedupe Model

`telegram_processed_updates` is a plain update-id claim (`worker/src/telegram/store/processed-updates.ts`). The webhook inserts the id as `processing`; when dispatch returns it marks the row `processed` (with an optional `error_class` for handled failures such as a failed callback or command reply). A thrown error deletes the `processing` claim and returns non-2xx, so Telegram's redelivery is processed. A group-to-supergroup migration that hits a transient D1 failure throws for exactly this reason (the batch is idempotent); a deterministic failure such as a constraint conflict is acked as `processed` with `error_class = chat-migration`, so it cannot block later updates, and delivery migrates the chat on `migrate_to_chat_id`. Mark and release only match this request's own claim (`received_at`), so a request that outlives the stale window never touches a redelivery's row.

Processed duplicates return `200 ok`. A duplicate that finds a fresh `processing` claim returns `503 retry` with `Retry-After` (log action `processed-update-dedupe`). A `processing` claim older than `TELEGRAM_PROCESSING_STALE_SEC` (60 s) belongs to a crashed request and is reclaimed by the next delivery, as are legacy `failed` rows and rows left in effect-fence states such as `planned`; no row can block an update for longer than that window.

Replies are not fenced. A crash after a reply but before the processed marker, or a failed marker, can repeat that reply once on redelivery; this is accepted at the bot's traffic level (owner decision, 2026-10-21). Settings and subscription mutations write explicit target values, so a redelivered update reapplies the same state. Intent columns and `telegram_webhook_operation_mutations` are no longer written; the table drop ships separately.

Processed rows retain seven days. Daily `telegram-retention-cleanup` owns capped pruning; webhook traffic does not run retention.

## Quick Diagnostic Checklist

1. **Which gate rejected?** For pre-handler 429/503 or body errors, inspect [preauth rejection telemetry](#preauth-ingress-abuse-controls), not D1 command counters. The webhook has no pre-auth limiter; a 401 handler rejection is signed Mini App auth after admission.
2. **Webhook auth valid?** Invalid `X-Telegram-Bot-Api-Secret-Token` intentionally returns `200 ok` without D1 access or side effects. Inspect secret-validation warnings after rotation; [rotation](./telegram-secret-rotation.md) owns credential repair.
3. **What did the update claim?** Use [Processed Update](./telegram-operator-queries.md#processed-update) for the exact `update_id`: `status`, `received_at`, `processed_at` and `error_class`. A missing row after a 5xx means the claim was released for redelivery.

## Remediation

- Ask the user to resend when appropriate; a resend is a new update and is never deduplicated against the old one.
- A stuck `processing` row needs no manual repair: it is reclaimable after 60 s and pruned after seven days. Never clear the table.
- If a mutation landed twice, repair the affected chat narrowly; broad subscriber resets are not a dedupe fix.
- Binding/config failures require incident handling or matching Worker rollback, not an isolate-local fallback. Admission and auth are independent; increasing a Mini App preauth budget must not bypass signed-session freshness or authenticated flood controls.

## Preauth Ingress Abuse Controls

This branch covers exact `POST /api/telegram-webhook`, `/api/telegram-mini-app/session`, and `/api/telegram-mini-app/mutate` paths. Numeric policy/body ceilings are owned by `TELEGRAM_INGRESS_POLICIES` in `worker/src/telegram/webhook/telegram-ingress-abuse.ts` and matching Rate Limiting bindings in `worker/wrangler.toml`; inspect those together when sizing or changing them. The webhook gets the body cap only: its secret header is compared in constant time without D1 before any work, so it has no pre-auth limiter that an unauthenticated flood could exhaust ahead of Telegram's own deliveries. Rate limiting below applies to the two Mini App routes. The guard is not an account-wide exact quota: native Cloudflare Workers Rate Limiting bindings are permissive, eventually consistent, and per-colo.

`api.pharos.watch` has the canonical route budget. Other Worker hosts share a separate noncanonical-host key per route, so preview/site-data/ops-origin requests cannot spend the public API budget but still face preauth limits. Each source key combines route/host lane and the existing 128-bit HMAC-SHA256 client-IP hash keyed by `SITE_API_SHARED_SECRET`. Raw IPs never enter keys/logs. Missing IPs share `unknown`; a missing hash secret fails closed. Rotating that secret resets source buckets, not aggregate counters.

**Request cost order** (`worker/src/handlers/http/request-dispatch.ts`): after CORS preflight and maintenance mode, but before Access/API-key gates, routing, Telegram auth, D1, attribution, or usage analytics:

1. Match exact pathname/method and choose canonical/noncanonical lane before normal host gating.
2. Reject malformed declared `Content-Length` with 400 and declared oversize with 413.
3. Mini App routes only: charge source binding first, aggregate path binding only if admitted. Exhaustion returns 429; missing/failed binding or hash secret returns fail-closed 503 with `Retry-After: 1`.
4. Read at most the route body cap, including chunked/misdeclared streams. Rebuild from bounded bytes without stale `Content-Length`/`Transfer-Encoding`.
5. Only then validate the webhook secret or Mini App HMAC, schema-parse, touch D1, and record authenticated usage.

An over-budget request reads no body, performs no Telegram HMAC work, touches no D1, and schedules no attribution writes. A source may consume at most half its route budget; rejected repeats cannot spend aggregate headroom. Distributed sources may still exhaust the aggregate; shared NAT/Telegram egress shares a source ceiling. This is fairness, not guaranteed admission under distributed abuse.

**Edge posture:** there are no active Telegram-specific WAF rules. `scripts/ci/cloudflare-account-state-manifest.json` owns account state and records the deliberately disabled broad API rule; `wrangler deploy` installs Worker bindings only. A proposed exact-path rule is not active until the manifest/drift fixtures are reconciled and the read-only account-state check passes. Check plan capacity before proposing it.

**Telemetry:** filter Workers Observability for `event=telegram_ingress_rejection`, then group by `route` (`webhook|mini_app_session|mini_app_mutation`), `status`, `metadata.stage`, and closed `metadata.reason` from the policy module. Early rejections deliberately perform no D1 telemetry writes. Records contain no IP, headers, query/body, initData, chat ID, or user ID.

| Response / stage / reason | Interpretation |
| --- | --- |
| 429 / rate_limit / preauth_rate_limited | Worker per-colo ceiling reached; WAF Security Events matter only if an edge rule has since been activated |
| 503 / rate_limit / rate_limit_unavailable | Missing/failed binding: deployment/runtime incident; do not fail open |
| 413 / body_header vs body_stream | Declared oversize vs chunked/misdeclared overflow |
| 401 / handler | Mini App signature/freshness rejected after preauth admission |
| 400 / body_header | Malformed declared length |
| 400 / handler | JSON/schema rejected after bounded read |


### Tuning and Rollback

Preserve reviewed launch/mutation headroom. Change the policy module, matching `worker/wrangler.toml` bindings, focused tests, and this interpretation together. Roll back to the prior Worker with its matching configuration; never add an isolate-local fallback map for a failed binding. Future edge rules need rollback instructions against the then-current account manifest.

Focused policy checks for the verifier are `worker/src/telegram/webhook/__tests__/telegram-ingress-abuse.test.ts` and `request-dispatch.test.ts`; they cover exact host/path/method, cost order, bounded streams, fail-closed behavior, launch bursts, isolation, telemetry, and binding budgets. After rollout verify one ordinary launch/mutation and unexpected 429/503 trends. Do not generate production traffic sufficient to trip a limit merely to test it.

## Authenticated Flood Control

Commands, callbacks, and pending-selection replies share one fixed-window D1 counter per chat (20 actions / 60 s), owned by `enforceIngressFlood` in `worker/src/telegram/webhook/telegram-webhook-ingress-policy.ts`. It runs after the webhook secret check. The counter is one conditional `cache` upsert with `RETURNING`, so concurrent deliveries cannot lose increments. A counter failure logs `command-flood` and denies with a best-effort busy reply. The first over-limit action gets one notice; later ones are dropped silently. There are no per-command cooldowns.

## Callback Acknowledgements

`answerCallbackQuery` dismisses the spinner; repeated flood denials after the first notice skip acknowledgement. Non-OK responses are drained and emit one bounded warning with `action=answer-callback-query`, `statusCode`, and `errorClass`. They are not retried inline. No callback/chat/user/token/response-body data appears in the log.

Group by status and error class: `rate_limit`/`server_error` usually mean transient Telegram pressure; `auth_error` requires deployed-token inspection; repeated `bad_request` warrants checking callback payload construction and age. A failed spinner acknowledgement alone does not establish that a D1 action failed or authorize replay.

## Setup State

Setup, ticker selection, bulk confirmation and `/forget` confirmation use stateless callback buttons; the webhook keeps no chat text state and ignores non-command text. A button that answers "out of date" belongs to an older message: ask the user to send the command again. `telegram_pending_disambiguation` has no writer or reader; only the five-minute `telegram-disambiguation-cleanup` pass still deletes expired legacy rows until the table drop.

## Cross-References

- [Update deduplication](../telegram-alerts.md#update-deduplication) and [setup behavior](../telegram-alerts.md#setup-wizard).
- [Reusable webhook queries](./telegram-operator-queries.md#webhook-dedupe).
- [Mini App auth](./telegram-mini-app-auth-failures.md) and [Mini App contract](../telegram-mini-app.md#auth-model).
- [Delivery incidents](./telegram-no-delivery.md) for queue transport rather than ingress effects.
