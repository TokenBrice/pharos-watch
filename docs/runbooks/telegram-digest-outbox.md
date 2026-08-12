# Telegram Digest Outbox Recovery

Use this runbook when the `telegram-digest-outbox-drain` budget-only status surface is degraded or an edition remains in `execution_unknown` / `failed_permanent`.

## Contract

`telegram_digest_outbox` stores the target channel, exact rendered chunk array,
success actions, accepted-chunk cursor, and the digest's authored Safety Score
context before the first Bot API request. A digest with safety content is sent
only while that full publication identity remains active. A digest authored
with an explicitly unavailable safety section may still deliver its unrelated
content only when deterministic copy checks find no Safety Score, report-card,
grade/rating, V9-pillar, or binding-cap claim.

| State | Meaning | Automatic action |
|---|---|---|
| `pending` | The next chunk is known not to have been accepted yet | Retried by the `*/5` digest-trigger slot after `next_attempt_at` |
| `sending` | An owner/generation has crossed the external-effect boundary | Never taken over while its claim is live |
| `sent` | Every chunk and the post-send appendix actions committed | None; rows are retained for 90 days |
| `execution_unknown` | Telegram may have accepted the chunk, or acceptance could not be durably recorded | None; operator proof is required |
| `failed_permanent` | Telegram rejected the chunk, or the authored Safety Score identity is stale/legacy-unbound | None; correct the cause or generate a current edition |

An expired `sending` claim becomes `execution_unknown`. It is never returned to `pending` automatically.

## Inspect

Check `/api/status` and locate `budgetOnlySurfaces[]` where `surface == "telegram-digest-outbox-drain"`. `retainedExecutionUnknown` and `retainedFailedPermanent` represent operator backlog; they degrade that surface but do not repeatedly trip the shared Telegram provider circuit when no send was attempted.

List unresolved editions:

```bash
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT edition_key, digest_kind, state, next_chunk_index, json_array_length(payload_chunks_json) AS chunk_count, json_extract(safety_context_json, '\$.status') AS safety_status, json_extract(safety_context_json, '\$.expectedModel') AS safety_model, json_extract(safety_context_json, '\$.identity.publicationGenerationId') AS safety_generation, attempts, last_error_class, last_status_code, updated_at FROM telegram_digest_outbox WHERE state IN ('sending','execution_unknown','failed_permanent') ORDER BY updated_at DESC;"
```

Inspect the uncertain chunk without editing it:

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT edition_key, next_chunk_index, json_extract(payload_chunks_json, '\$[' || next_chunk_index || ']') AS uncertain_chunk FROM telegram_digest_outbox WHERE edition_key = 'daily:YYYY-MM-DD';"
```

Compare that exact chunk with the configured Telegram channel. `next_chunk_index` points to the first chunk whose acceptance is not durably confirmed.

## Reconcile Ambiguity

Create a D1 Time Travel bookmark before any manual state change.

If the uncertain chunk is proven **not accepted**, preserve the cursor and release the edition:

```sql
UPDATE telegram_digest_outbox
   SET state = 'pending',
       next_attempt_at = unixepoch(),
       delivery_owner = NULL,
       delivery_claim_expires_at = NULL,
       last_error_class = 'operator-confirmed-not-delivered',
       updated_at = unixepoch()
 WHERE edition_key = 'daily:YYYY-MM-DD'
   AND state = 'execution_unknown';
```

If the uncertain chunk is proven **accepted**, advance exactly one chunk and release the remainder:

```sql
UPDATE telegram_digest_outbox
   SET state = 'pending',
       next_chunk_index = next_chunk_index + 1,
       next_attempt_at = unixepoch(),
       delivery_owner = NULL,
       delivery_claim_expires_at = NULL,
       last_error_class = 'operator-confirmed-delivered',
       updated_at = unixepoch()
 WHERE edition_key = 'daily:YYYY-MM-DD'
   AND state = 'execution_unknown'
   AND next_chunk_index < json_array_length(payload_chunks_json);
```

The next poll sends only the remaining chunks. When the cursor already equals the array length, it performs no Bot API call and atomically commits the stored appendix actions with `sent`.

If acceptance remains uncertain, leave the row unchanged. Do not reset it merely to clear status.

## Reconcile Permanent Failure

Use `last_status_code` and `last_error_class` to classify the rejection. A
confirmed permanent Telegram rejection means the chunk was not accepted, so
the cursor does not advance. There is no supported operator reset for a
`failed_permanent` edition. After an external/configuration cause such as
channel permissions has been corrected, use a new reviewed edition key unless
a reviewed recovery script is first added. Such a script must require the exact
edition key, `state = 'failed_permanent'`, the captured delivery generation and
update timestamp, an allowed external-error class, unchanged payload and Safety
identity, a pre-write bookmark, a durable operator-audit row, and post-write
readback. It must return the row to `pending` without changing the chunk cursor.
An immutable payload or HTML defect always requires a new reviewed edition key;
keep the failed row as forensic evidence.

`last_error_class` beginning with `stale_safety_identity:` means the authored
Safety Score identity no longer matches the active publication, or the row
predates identity binding. Do not reset that edition as current. Preserve it
for audit and generate a newly reviewed edition against the active source.

`last_error_class` beginning with `unbound_safety_copy:` means persisted copy
contains a Safety Score or grade claim but the edition has no identified
publication. Treat it like a stale identity: preserve the row and generate a
reviewed, identity-bound edition instead of resetting it.

Do not modify `payload_chunks_json`, `success_actions_json`,
`safety_context_json`, or `target_chat_id` in place. A changed edition requires
a new reviewed edition key; mutation would break exact-payload auditability.
Never reset `stale_safety_identity:*`, `unbound_safety_copy:*`, payload/HTML
defects, or target mismatches that were not actually corrected.

## Verification

After the next five-minute poll:

1. Confirm the edition is `sent` or has a later bounded `next_attempt_at`.
2. Confirm `next_chunk_index <= json_array_length(payload_chunks_json)`.
3. Confirm `telegram-digest-outbox-drain` telemetry reports the attempted outcome.
4. For daily appendices, confirm the cache pointers in `success_actions_json` advanced only after `sent`.
5. For weekly rows, confirm `daily_digest.digest_meta.telegramDelivered` is `true`.

## Rollback

The additive schema introduced historically by `0184_telegram_digest_outbox.sql`
and `0221_telegram_digest_safety_identity.sql` remains in place during a Worker
rollback; those migration files are squashed lineage now absorbed by
`0000_baseline.sql`, not active replay files. Before restoring an older Worker, reconcile all
`sending` and `execution_unknown` rows; the legacy sender does not understand
this effect fence. Keep terminal rows for forensics rather than deleting them
during rollback.
