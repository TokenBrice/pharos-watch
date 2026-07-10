# Telegram Bot-Wide Outage

Use this runbook when Telegram authentication fails, several distinct chats return systemic transport failures, or delivery is intentionally paused during an incident.

## Inspect

1. Call `GET /api/admin-telegram-delivery-control` through the authenticated ops origin.
2. Check `circuit.state`, `causeClass`, `causeScope`, `openedAt`, `nextProbeAt`, and any half-open probe owner/expiry.
3. Check all three pause rows. An expired row is inert even though it remains visible.
4. Inspect pending age and execution-unknown counts before changing controls. A timeout or network error after the send fence is ambiguous and must not be retried as a known rejection.

The controller stores only short-lived distinct-chat observations needed for outage inference. Rows older than five minutes are pruned; raw Telegram response bodies are never stored or added to general logs.

## Pause

Pause only the affected delivery mode. Use the generation returned by the latest GET:

```json
{
  "action": "pause",
  "mode": "fresh",
  "expectedGeneration": 0,
  "durationSec": 900,
  "reason": "Telegram authentication incident"
}
```

Modes are `fresh`, `pending`, and `admin`. Pausing admin delivery does not silence webhook replies. Every pause expires automatically within at most 24 hours and is written to `admin_action_audit`.

## Recover

1. Correct credentials or wait for Telegram recovery without manually clearing queued rows.
2. Let the circuit reach `nextProbeAt`. Exactly one owner may claim a one-to-four-distinct-chat half-open probe; other cron invocations defer.
3. A confirmed reachable response closes the circuit. A single chat-local 429 is inconclusive and cannot establish a bot-wide failure by itself.
4. Resume an operator pause with the current generation:

```json
{
  "action": "resume",
  "mode": "fresh",
  "expectedGeneration": 1
}
```

5. Verify untouched work retained its original priority, expiry, and delivery lifecycle. Reconcile `execution_unknown` rows separately before any manual resend.

Do not reset the circuit merely to force a large live batch. The half-open bound exists to prevent a bad token or continuing Telegram outage from launching the untouched tail.
