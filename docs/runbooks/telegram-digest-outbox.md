# Telegram Digest Outbox Recovery

Use this runbook when the `telegram-digest-outbox-drain` budget-only status surface is degraded or an edition remains in `execution_unknown` / `failed_permanent`.

## Contract

`telegram_digest_outbox` stores the target channel, exact rendered chunk array, success actions, and accepted-chunk cursor before the first Bot API request.

| State | Meaning | Automatic action |
|---|---|---|
| `pending` | The next chunk is known not to have been accepted yet | Retried by the `*/5` digest-trigger slot after `next_attempt_at` |
| `sending` | An owner/generation has crossed the external-effect boundary | Never taken over while its claim is live |
| `sent` | Every chunk and the post-send appendix actions committed | None; rows are retained for 90 days |
| `execution_unknown` | Telegram may have accepted the chunk, or acceptance could not be durably recorded | None; operator proof is required |
| `failed_permanent` | Telegram explicitly rejected the chunk with a non-retryable response | None; correct the cause before resetting |

An expired `sending` claim becomes `execution_unknown`. It is never returned to `pending` automatically.

## Inspect

Check `/api/status` and locate `budgetOnlySurfaces[]` where `surface == "telegram-digest-outbox-drain"`. `retainedExecutionUnknown` and `retainedFailedPermanent` represent operator backlog; they degrade that surface but do not repeatedly trip the shared Telegram provider circuit when no send was attempted.

List unresolved editions:

```bash
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT edition_key, digest_kind, state, next_chunk_index, json_array_length(payload_chunks_json) AS chunk_count, attempts, last_error_class, last_status_code, updated_at FROM telegram_digest_outbox WHERE state IN ('sending','execution_unknown','failed_permanent') ORDER BY updated_at DESC;"
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

Use `last_status_code` and `last_error_class` to classify the rejection. A confirmed permanent rejection means the chunk was not accepted, so the cursor does not advance. Reset the same edition only after an external/configuration cause such as channel permissions has been corrected. An immutable payload or HTML defect requires a new reviewed edition key; keep the failed row as forensic evidence.

Do not modify `payload_chunks_json`, `success_actions_json`, or `target_chat_id` in place. A changed edition requires a new reviewed edition key; mutation would break exact-payload auditability.

## Verification

After the next five-minute poll:

1. Confirm the edition is `sent` or has a later bounded `next_attempt_at`.
2. Confirm `next_chunk_index <= json_array_length(payload_chunks_json)`.
3. Confirm `telegram-digest-outbox-drain` telemetry reports the attempted outcome.
4. For daily appendices, confirm the cache pointers in `success_actions_json` advanced only after `sent`.
5. For weekly rows, confirm `daily_digest.digest_meta.telegramDelivered` is `true`.

## Rollback

Migration `0184_telegram_digest_outbox.sql` is additive and remains in place during a Worker rollback. Before restoring an older Worker, reconcile all `sending` and `execution_unknown` rows; the legacy sender does not understand this effect fence. Keep terminal rows for forensics rather than deleting them during rollback.
