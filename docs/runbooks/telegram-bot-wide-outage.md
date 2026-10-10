# Telegram Bot-Wide Outage

Use this runbook when Telegram authentication fails, several distinct chats return systemic transport failures, or delivery is intentionally paused during an incident.

`GET|POST /api/admin-telegram-delivery-control` was retired on 2026-08-09. The state it exposed is unchanged: `telegram_transport_circuit` and `telegram_delivery_pauses` still gate every queued delivery path — fresh handoff, pending drain, digest, and admin broadcast. The cron freshness-watchdog operator alert sends outside these controls, so a pause does not silence it; it is delivered to the private `TELEGRAM_OPERATOR_CHAT_ID` chat, not the public channel, and is skipped when that binding is unset. Read-only inspection is available through D1, but there is currently no supported audited pause/resume mutation. Do not substitute an ad hoc direct write: the mutation must preserve generation fencing and write the keep-forever `admin_action_audit` row only when the state change succeeds.

## Inspect

1. Read the [Transport Circuit](./telegram-operator-queries.md#transport-circuit) singleton using the shared [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry).

2. Check `state`, `cause_class`, `cause_scope`, `opened_at`, `next_probe_at`, and any half-open probe owner/expiry.
3. Read [Delivery Pauses](./telegram-operator-queries.md#delivery-pauses). The table is not seeded: an absent `fresh`, `pending`, or `admin` row means that mode is inactive with generation `0`. An existing expired row is also inert but retains its generation.

4. Inspect [pending age](./telegram-operator-queries.md#pending-queue) and [execution-unknown effects](./telegram-operator-queries.md#source-target-planning) before changing controls. A timeout or network error after the send fence is ambiguous and must not be retried as a known rejection.

The controller stores only short-lived distinct-chat observations needed for outage inference. Rows older than five minutes are pruned; raw Telegram response bodies are never stored or added to general logs.

## Pause

Modes are `fresh`, `pending`, and `admin`; pausing admin delivery does not silence webhook replies. The repository currently has no supported operator mutation after the audited endpoint was retired. If an emergency pause is required, restore or add a reviewed Access-protected control/script that calls the existing `setTelegramDeliveryPause()` semantics: exact mode, 60-second-to-24-hour self-expiry, captured generation (`0` for an absent row), conditional state mutation, conditional `telegram-delivery-pause` audit in the same D1 batch, zero-change conflict handling, and post-write readback. Do not run a raw `INSERT` that leaves the permanent operator audit incomplete.

Extending or re-pausing an existing row requires its current captured generation; a successful write increments the generation by one and preserves `created_at`. A generation mismatch must leave both pause state and audit unchanged.

## Recover

1. Correct credentials or wait for Telegram recovery without manually clearing queued rows.
2. Let the circuit reach `next_probe_at`. Exactly one owner may claim a one-to-four-distinct-chat half-open probe; other cron invocations defer.
3. A confirmed reachable response closes the circuit. A single chat-local 429 is inconclusive and cannot establish a bot-wide failure by itself.
4. Resume an operator pause only through the same reviewed control/script, using the current generation and `resumeTelegramDelivery()` semantics so the conditional mutation and `telegram-delivery-resume` audit stay paired. A zero-row result is a conflict, not success; read the row back before retrying.

5. Verify untouched work retained its original priority, expiry, and delivery lifecycle. Reconcile `execution_unknown` rows separately; there is no operator resend path since `POST /api/admin-telegram-resend` was retired on 2026-08-09.

Do not reset the circuit merely to force a large live batch. The half-open bound exists to prevent a bad token or continuing Telegram outage from launching the untouched tail.
