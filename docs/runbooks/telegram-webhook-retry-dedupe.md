# Runbook: Telegram Ingress, Retries and Setup Incidents

## Symptom

Use this procedure when commands/callbacks disappear on webhook retry, setup state stalls, or webhook/Mini App ingress returns body-limit, rate-limit, or unavailable-gate responses. Alert queue silence belongs to [delivery incidents](./telegram-no-delivery.md); signed Mini App session/token-age failures belong to [Mini App auth failures](./telegram-mini-app-auth-failures.md).

| Evidence | Branch |
| --- | --- |
| Webhook or Mini App 400/413/429/503 before handler work | [Preauth ingress abuse controls](#preauth-ingress-abuse-controls) |
| Authenticated commands/callbacks receive busy/throttle responses | [Authenticated flood control](#authenticated-flood-control) |
| Callback spinner fails to clear | [Callback acknowledgements](#callback-acknowledgements) |
| Same update is processing/failed, retry returns 503, mutation missing | [Current dedupe model](#current-dedupe-model) and [checklist](#quick-diagnostic-checklist) |
| Setup branch re-renders intro, expires, or appears to own later input | [Setup state](#setup-state) |

Start with the [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry). Sampled HTTP logs establish request timing; chat/update association comes from D1, never custom Telegram logs.

## Current Dedupe Model

`telegram_processed_updates` stores owner/generation claims and versioned normalized intents. Replay-safe D1 mutation and the `telegram_webhook_operation_mutations` proof commit in one batch. Stale `unstarted` claims may reparse input; planned takeover uses stored normalized parameters rather than mutable/deleted pending state. Applied mutation recovery skips domain writes and resumes its original acknowledgement.

`effect_state='started'` is crossed only immediately before an irreversible Bot API call. Post-fence uncertainty becomes `execution_unknown`, never automatic replay. Processed duplicates return `200 ok`; fresh `processing` duplicates return `503 retry` plus `Retry-After` (log action `processed-update-dedupe`) to keep Telegram retry alive if the original invocation dies. Stale started/unknown work is acknowledged without repeating the effect. There is no global update high-watermark drop.

Ordinary processed rows retain seven days; started/unknown evidence retains 90 days. Daily `telegram-retention-cleanup` owns capped pruning; webhook traffic does not run retention.

## Quick Diagnostic Checklist

1. **Which gate rejected?** For pre-handler 429/503 or body errors, inspect [preauth rejection telemetry](#preauth-ingress-abuse-controls), not D1 command counters. A 401 handler rejection is signed Mini App auth after admission.
2. **Webhook auth valid?** Invalid `X-Telegram-Bot-Api-Secret-Token` intentionally returns `200 ok` without side effects. Inspect secret-validation warnings after rotation; [rotation](./telegram-secret-rotation.md) owns credential repair.
3. **What did the update claim?** Use [Processed Update](./telegram-operator-queries.md#processed-update) for the exact `update_id`, retaining normalized intent, mutation marker, effect kind/ordinal, owner, and generation. The [effect lifecycle queries](./telegram-operator-queries.md#webhook-status-and-effects) distinguish claim from irreversible effect.
4. **What pending state owns this chat?** Use [Pending Command State](./telegram-operator-queries.md#pending-command-state); no per-chat admin HTTP diagnostic endpoint exists. For `setup-step`, follow [Setup state](#setup-state), not generic claim repair.
5. **Is takeover safe?** A failed unstarted/planned claim is reclaimable on redelivery; a still-processing claim only after the five-minute stale window. Planned work resumes its stored intent. Never force-retry started/unknown evidence; reconcile exact intent/mutation and Telegram-visible state first.

## Remediation

- Ask the user to resend when appropriate so the operation has concrete current input; do not make an ambiguous old update replayable. Check whether a repeated command would create a new user-visible effect before advising it.
- Prefer stale takeover for failed-before-terminal unstarted/planned claims. Only fail/delete that **one** claim if no effect started has been proven. Never clear the table or alter started/unknown evidence to replay it.
- Clear pending state only after identifying exact chat, action type, ownership, and expiry. The [setup branch](#setup-state) below authorizes only expired setup rows beyond cleanup grace, not broad subscriber or processed-update deletion.
- If duplicate effects occur, preserve the exact evidence and repair affected chat state narrowly; broad subscriber resets are not a dedupe fix.
- Binding/config failures require incident handling or matching Worker rollback, not an isolate-local fallback. Admission and auth are independent; increasing a preauth budget must not bypass signed-session freshness or authenticated flood controls.

## Preauth Ingress Abuse Controls

This branch covers exact `POST /api/telegram-webhook`, `/api/telegram-mini-app/session`, and `/api/telegram-mini-app/mutate` paths. Numeric policy/body ceilings are owned by `TELEGRAM_INGRESS_POLICIES` in `worker/src/handlers/http/telegram-ingress-abuse.ts` and matching Rate Limiting bindings in `worker/wrangler.toml`; inspect those together when sizing or changing them. The guard is not an account-wide exact quota: native Cloudflare Workers Rate Limiting bindings are permissive, eventually consistent, and per-colo.

`api.pharos.watch` has the canonical route budget. Other Worker hosts share a separate noncanonical-host key per route, so preview/site-data/ops-origin requests cannot spend the public API budget but still face preauth limits. Each source key combines route/host lane and the existing 128-bit HMAC-SHA256 client-IP hash keyed by `SITE_API_SHARED_SECRET`. Raw IPs never enter keys/logs. Missing IPs share `unknown`; a missing hash secret fails closed. Rotating that secret resets source buckets, not aggregate counters.

**Request cost order** (`worker/src/handlers/http/request-dispatch.ts`): after CORS preflight and maintenance mode, but before Access/API-key gates, routing, Telegram auth, D1, attribution, or usage analytics:

1. Match exact pathname/method and choose canonical/noncanonical lane before normal host gating.
2. Reject malformed declared `Content-Length` with 400 and declared oversize with 413.
3. Charge source binding first, aggregate path binding only if admitted. Exhaustion returns 429; missing/failed binding or hash secret returns fail-closed 503 with `Retry-After: 1`.
4. Read at most the route body cap, including chunked/misdeclared streams. Rebuild from bounded bytes without stale `Content-Length`/`Transfer-Encoding`.
5. Only then schema-parse, validate webhook secret or Mini App HMAC, touch D1, and record authenticated usage.

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

The same-origin CTA counter is separate: Pages `POST /pharoswatchbot-adoption` forwards to `/api/telegram-adoption`. Pages buffers at most **512 bytes**, with a **five-second read deadline**. Declared/chunked/understated overflow and unreadable/timed-out bodies return empty **400**, not 413, matching Worker validation status. Empty bodies, malformed JSON, and wrong content types within the cap remain Worker-validated; Worker independently retains its 512-byte cap.

### Tuning and Rollback

Preserve reviewed launch/mutation headroom. Change the policy module, matching `worker/wrangler.toml` bindings, focused tests, and this interpretation together. Roll back to the prior Worker with its matching configuration; never add an isolate-local fallback map for a failed binding. Future edge rules need rollback instructions against the then-current account manifest.

Focused policy checks for the verifier are `worker/src/handlers/http/__tests__/telegram-ingress-abuse.test.ts` and `request-dispatch.test.ts`; they cover exact host/path/method, cost order, bounded streams, fail-closed behavior, launch bursts, isolation, telemetry, and binding budgets. After rollout verify one ordinary launch/mutation and unexpected 429/503 trends. Do not generate production traffic sufficient to trip a limit merely to test it.

## Authenticated Flood Control

Commands, callbacks, and pending-selection replies share fixed-window D1 counters. Private chats have one chat scope. Groups with actor ID evaluate both actor and higher chat-wide ceilings; without actor ID they use a private-sized chat cap. `worker/src/api/telegram-webhook-ingress-policy.ts` owns policy; this is downstream of preauth binding admission.

Each evaluated scope uses one conditional `cache` upsert with `RETURNING`, incrementing the window or beginning a new one at the exact expiry boundary. Concurrent webhook deliveries must not lose increments. An execution/invalid-count failure logs `command-flood`.

Admission requires **at least one successfully evaluated scope and no evaluated scope blocking**. One failed group scope still admits when its other scope allows. All scopes failing denies with a best-effort busy reply; a private chat's only scope failing therefore denies. Do not diagnose a denied update as a processed-update replay failure before checking these counters. Command cooldown remains a separate gate from this aggregate flood cap.

## Callback Acknowledgements

`answerCallbackQuery` dismisses the spinner; repeated flood denials after the first notice skip acknowledgement. Non-OK responses are drained and emit one bounded warning with `action=answer-callback-query`, `statusCode`, and `errorClass`. They are not retried inline. No callback/chat/user/token/response-body data appears in the log.

Group by status and error class: `rate_limit`/`server_error` usually mean transient Telegram pressure; `auth_error` requires deployed-token inspection; repeated `bad_request` warrants checking callback payload construction and age. A failed spinner acknowledgement alone does not establish that a D1 action failed or authorize replay.

## Setup State

The wizard stores `action_type='setup-step'` in `telegram_pending_disambiguation` with **five-minute TTL**. Ingress ignores expired rows; `telegram-disambiguation-cleanup` retains an extra **600-second grace** before deleting so slow users do not race cleanup. Read `crons["telegram-disambiguation-cleanup"].runs[0]` for the latest attempt and the Access-protected `GET /api/status-cron-detail?job=telegram-disambiguation-cleanup` -> `cron.runs[0].metadata.disambiguationRowsCleaned`; a recent five-minute-slot run and cleanup count are the operational readback.

Distinguish active ownership from stale rows:

- `/start` by the pending row's initiator clears it and reissues intro. A different user's `/start` while it is live receives the ownership-conflict reply and leaves it untouched.
- Any initiator slash command normally clears the wizard; only `/cancel` sends explicit “Setup cancelled.” On **awaiting-ticker**, a single-token slash reply such as `/USDC` **or `/help`** is consumed as ticker input and leaves the row. `/cancel` and `/start` remain command escapes.
- A live row may legitimately own the flow; expiry is not permission to remove another chat's or another action type's pending state.

Find cleanup candidates (authorized primary D1 read):

```sql
SELECT chat_id, action_type, expires_at, action_payload
FROM telegram_pending_disambiguation
WHERE action_type = 'setup-step'
  AND expires_at < unixepoch() - 600
ORDER BY expires_at ASC;
```

For an inspected affected chat **only**, the scheduled-cleanup-equivalent, idempotent remediation is:

```sql
DELETE FROM telegram_pending_disambiguation
WHERE chat_id = '<chat_id>'
  AND action_type = 'setup-step'
  AND expires_at < unixepoch() - 600;
```

Use authorized D1 binding access and substitute the confirmed chat, never a broad delete. The user's next `/start` issues fresh intro. Check the row and cleanup metadata afterward. If multiple chats are affected and cleanup is error/stale, restore the cron lane and let its next tick sweep; no separate setup admin endpoint exists. [Delivery triage](./telegram-no-delivery.md) covers cron/D1 health.

If a per-chat lockup has **no stale row**, suspect wizard dispatch instead of cleanup. Before clearing anything, preserve chat ID, exact `action_payload` JSON, and a failing-webhook tail snippet in the restricted incident record; general logs must stay identifier-free. Inspect `sendWizardIntro` and branch/target/confirm paths in `worker/src/api/telegram-webhook-setup.ts` and capture reproducible bug evidence rather than reset unrelated data.

## Cross-References

- [Update deduplication](../telegram-alerts.md#update-deduplication) and [setup behavior](../telegram-alerts.md#setup-wizard).
- [Reusable webhook queries](./telegram-operator-queries.md#webhook-dedupe).
- [Mini App auth](./telegram-mini-app-auth-failures.md) and [Mini App contract](../telegram-mini-app.md#auth-model).
- [Delivery incidents](./telegram-no-delivery.md) for queue transport rather than ingress effects.
