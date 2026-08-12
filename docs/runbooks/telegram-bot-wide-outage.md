# Telegram Bot-Wide Outage

Use this runbook when Telegram authentication fails, several distinct chats return systemic transport failures, or delivery is intentionally paused during an incident.

`GET|POST /api/admin-telegram-delivery-control` was retired on 2026-08-09. The state it exposed is unchanged: `telegram_transport_circuit` and `telegram_delivery_pauses` still gate every send. Read-only inspection is available through D1, but there is currently no supported audited pause/resume mutation. Do not substitute an ad hoc direct write: the mutation must preserve generation fencing and write the keep-forever `admin_action_audit` row only when the state change succeeds.

## Inspect

1. Read the transport circuit singleton:

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT state, generation, cause_class, cause_scope, distinct_failure_count, first_failure_at, last_failure_at, last_success_at, opened_at, next_probe_at, probe_owner, probe_generation, probe_expires_at, probe_limit, probe_attempted, updated_at FROM telegram_transport_circuit WHERE singleton_id = 1;"
   ```

2. Check `state`, `cause_class`, `cause_scope`, `opened_at`, `next_probe_at`, and any half-open probe owner/expiry.
3. Check the pause rows. The table is not seeded: an absent `fresh`, `pending`, or `admin` row means that mode is inactive with generation `0`. An existing expired row is also inert but retains its generation.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT mode, generation, expires_at, reason, actor, created_at, updated_at FROM telegram_delivery_pauses ORDER BY mode;"
   ```

4. Inspect pending age and execution-unknown counts before changing controls (see [`telegram-operator-queries.md`](./telegram-operator-queries.md)). A timeout or network error after the send fence is ambiguous and must not be retried as a known rejection.

The controller stores only short-lived distinct-chat observations needed for outage inference. Rows older than five minutes are pruned; raw Telegram response bodies are never stored or added to general logs.

## Pause

Modes are `fresh`, `pending`, and `admin`; pausing admin delivery does not silence webhook replies. The repository currently has no supported operator mutation after the audited endpoint was retired. If an emergency pause is required, restore or add a reviewed Access-protected control/script that calls the existing `setTelegramDeliveryPause()` semantics: exact mode, 60-second-to-24-hour self-expiry, captured generation (`0` for an absent row), conditional state mutation, conditional `telegram-delivery-pause` audit in the same D1 batch, zero-change conflict handling, and post-write readback. Do not run a raw `INSERT` that leaves the permanent operator audit incomplete.

## Recover

1. Correct credentials or wait for Telegram recovery without manually clearing queued rows.
2. Let the circuit reach `next_probe_at`. Exactly one owner may claim a one-to-four-distinct-chat half-open probe; other cron invocations defer.
3. A confirmed reachable response closes the circuit. A single chat-local 429 is inconclusive and cannot establish a bot-wide failure by itself.
4. Resume an operator pause only through the same reviewed control/script, using the current generation and `resumeTelegramDelivery()` semantics so the conditional mutation and `telegram-delivery-resume` audit stay paired. A zero-row result is a conflict, not success; read the row back before retrying.

5. Verify untouched work retained its original priority, expiry, and delivery lifecycle. Reconcile `execution_unknown` rows separately; there is no operator resend path since `POST /api/admin-telegram-resend` was retired on 2026-08-09.

Do not reset the circuit merely to force a large live batch. The half-open bound exists to prevent a bad token or continuing Telegram outage from launching the untouched tail.
