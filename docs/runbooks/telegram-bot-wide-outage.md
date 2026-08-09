# Telegram Bot-Wide Outage

Use this runbook when Telegram authentication fails, several distinct chats return systemic transport failures, or delivery is intentionally paused during an incident.

`GET|POST /api/admin-telegram-delivery-control` was retired on 2026-08-09. The state it exposed is unchanged: `telegram_transport_circuit` and `telegram_delivery_pauses` are still written by `worker/src/lib/telegram-transport-control.ts` and still gate every send, so inspection and pause/resume are now direct D1 statements.

## Inspect

1. Read the transport circuit singleton:

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT state, generation, cause_class, cause_scope, distinct_failure_count, first_failure_at, last_failure_at, last_success_at, opened_at, next_probe_at, probe_owner, probe_generation, probe_expires_at, probe_limit, probe_attempted, updated_at FROM telegram_transport_circuit WHERE singleton_id = 1;"
   ```

2. Check `state`, `cause_class`, `cause_scope`, `opened_at`, `next_probe_at`, and any half-open probe owner/expiry.
3. Check all three pause rows. An expired row is inert even though it remains visible.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT mode, generation, expires_at, reason, actor, created_at, updated_at FROM telegram_delivery_pauses ORDER BY mode;"
   ```

4. Inspect pending age and execution-unknown counts before changing controls (see [`telegram-operator-queries.md`](./telegram-operator-queries.md)). A timeout or network error after the send fence is ambiguous and must not be retried as a known rejection.

The controller stores only short-lived distinct-chat observations needed for outage inference. Rows older than five minutes are pruned; raw Telegram response bodies are never stored or added to general logs.

## Pause

Pause only the affected delivery mode. Modes are `fresh`, `pending`, and `admin`. Pausing admin delivery does not silence webhook replies. Use the exact `generation` returned by the SELECT above as `<expectedGeneration>`; the write is generation-fenced and changes zero rows if another actor moved the row first.

```sql
INSERT INTO telegram_delivery_pauses
  (mode, generation, expires_at, reason, actor, created_at, updated_at)
SELECT 'fresh', 1, <nowSec + durationSec>, 'Telegram authentication incident', '<operator>', <nowSec>, <nowSec>
 WHERE <expectedGeneration> = 0
ON CONFLICT(mode) DO UPDATE SET
  generation = telegram_delivery_pauses.generation + 1,
  expires_at = excluded.expires_at,
  reason = excluded.reason,
  actor = excluded.actor,
  updated_at = excluded.updated_at
 WHERE telegram_delivery_pauses.generation = <expectedGeneration>;
```

Two guarantees the retired endpoint enforced are now yours to honor by hand: keep `durationSec` between 60 seconds and 24 hours so the pause still self-expires, and record the pause yourself, because the manual write emits no `admin_action_audit` row.

## Recover

1. Correct credentials or wait for Telegram recovery without manually clearing queued rows.
2. Let the circuit reach `next_probe_at`. Exactly one owner may claim a one-to-four-distinct-chat half-open probe; other cron invocations defer.
3. A confirmed reachable response closes the circuit. A single chat-local 429 is inconclusive and cannot establish a bot-wide failure by itself.
4. Resume an operator pause by expiring the row with the current generation. This is exactly what the retired resume action did:

```sql
UPDATE telegram_delivery_pauses
   SET generation = generation + 1,
       expires_at = <nowSec>,
       reason = 'operator resume',
       actor = '<operator>',
       updated_at = <nowSec>
 WHERE mode = 'fresh'
   AND generation = <expectedGeneration>;
```

5. Verify untouched work retained its original priority, expiry, and delivery lifecycle. Reconcile `execution_unknown` rows separately; there is no operator resend path since `POST /api/admin-telegram-resend` was retired on 2026-08-09.

Do not reset the circuit merely to force a large live batch. The half-open bound exists to prevent a bad token or continuing Telegram outage from launching the untouched tail.
