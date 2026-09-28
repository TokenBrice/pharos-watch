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

Newly enqueued editions render the separate map photo first, followed by the
four-line map summary as the first text section. A chronic `Standing:` line is
an expandable context blockquote, and `New Cemetery Entries` / `Tracking
Changes` remain expandable blockquotes in that same text payload. The optional
recap CTA is authored only when the resolved rollout is `public` and links to
the bot's private chat; a missing policy intentionally suppresses the CTA.
These are payload changes, not in-place migrations:
accepted photos and text chunks from an existing edition are never re-rendered
or resent.

| State | Meaning | Automatic action |
|---|---|---|
| `pending` | The next photo or text effect is known not to have been accepted yet | Retried by the `*/5` digest-trigger slot after `next_attempt_at` |
| `sending` | An owner/generation has crossed the external-effect boundary | Never taken over while its claim is live |
| `sent` | Any photo, every text chunk, and the post-send appendix actions committed | None; rows are retained for 90 days |
| `execution_unknown` | Telegram may have accepted a photo or text chunk, or acceptance could not be durably recorded | None; exact-effect operator proof is required |
| `failed_permanent` | Telegram rejected the effect, or the authored Safety Score identity is stale/legacy-unbound | None; correct the cause or generate a current edition |

An expired `sending` claim becomes `execution_unknown`. It is never returned to `pending` automatically.

## Inspect

Check `/api/status` and locate `budgetOnlySurfaces[]` where `job == "telegram-digest-outbox-drain"`. `retainedExecutionUnknown` and `retainedFailedPermanent` count terminal rows whose `updated_at` falls within the 7-day operator-review window; they represent operator backlog, degrade that surface, and do not repeatedly trip the shared Telegram provider circuit when no send was attempted. The `retainedExecutionUnknownTotal` and `retainedFailedPermanentTotal` metadata fields report the all-time retained counts, so forensic rows older than the review window stay visible without degrading the surface.

List unresolved editions:

```bash
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT edition_key, digest_kind, target_chat_id, state, media_state, map_image_url, map_date, next_chunk_index, json_array_length(payload_chunks_json) AS chunk_count, delivery_generation, delivery_owner, updated_at, json_extract(safety_context_json, '\$.status') AS safety_status, json_extract(safety_context_json, '\$.identity.publicationGenerationId') AS safety_generation, attempts, last_error_class, last_status_code FROM telegram_digest_outbox WHERE state IN ('sending','execution_unknown','failed_permanent') ORDER BY updated_at DESC;"
```

Inspect and capture the exact uncertain effect and reconciliation fence without editing it:

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT edition_key, target_chat_id, state, media_state, map_image_url, map_date, next_chunk_index, delivery_generation, delivery_owner, updated_at, payload_chunks_json, success_actions_json, safety_context_json, json_extract(payload_chunks_json, '\$[' || next_chunk_index || ']') AS next_text_chunk FROM telegram_digest_outbox WHERE edition_key = 'daily:YYYY-MM-DD';"
```

`next_chunk_index` is a **text-only** cursor. When `media_state = 'pending'`, the photo at `map_image_url` with caption `<b>Safety Score map · {map_date}</b>` precedes text; the candidate uncertain effect is that photo, not chunk zero. Require cursor zero and non-null map identity. When media is `none` or `sent`, inspect the text at the cursor. Establish which request actually crossed the send boundary using the captured attempt and exact target/payload evidence; the cursor alone is not proof that a request was attempted.

## Reconcile Ambiguity

Create a D1 Time Travel bookmark and retain the inspected row, operator identity, incident reason, and exact-effect proof before any manual state change. The SQL below is a parameterized reconciliation recipe, not an installed operator endpoint or CLI. Execute only through a separately reviewed, authorized binding of the captured values; never substitute guessed state or use a broad reset.

Resolve the photo and text cases independently:

| Proven uncertain effect | Proven outcome | Required current media/cursor | Mutation and next poll |
|---|---|---|---|
| Photo identified by exact target, URL, map date/caption and attempt | Accepted | `pending`, cursor `0` | Mark media `sent`; leave cursor `0`. Next poll starts text chunk zero without resending the photo. |
| Same photo | Not accepted | `pending`, cursor `0` | Keep media `pending` and cursor `0`. Next poll retries the photo before any text. |
| Exact text chunk at the captured index in the exact target | Accepted | `none` or `sent`, cursor inside array | Advance exactly one text chunk; preserve media. Next poll sends only the remaining text. |
| Same text chunk | Not accepted | `none` or `sent`, cursor inside array | Preserve cursor and media. Next poll retries that text chunk, never a resolved photo. |

Positive evidence must establish acceptance or non-acceptance of **that effect**. A missing text chunk does not prove the earlier photo was not accepted; a timeout, incomplete channel inspection, or absence of a durable checkpoint does not prove non-acceptance. If the effect or outcome remains uncertain, leave the row unchanged. A cursor at array length has no text effect to reconcile; do not advance it. Resolve finalization-only ambiguity separately.

Bind `:effect` to `photo` or `text` and `:outcome` to `accepted` or `not_accepted` only after that proof. Every `:expected_*` parameter is the corresponding value from the captured row (including exact serialized JSON and nulls); `:now` is the reconciliation Unix timestamp:

```sql
UPDATE telegram_digest_outbox
   SET state = 'pending',
       media_state = CASE
         WHEN :effect = 'photo' AND :outcome = 'accepted' THEN 'sent'
         ELSE media_state END,
       next_chunk_index = next_chunk_index + CASE
         WHEN :effect = 'text' AND :outcome = 'accepted' THEN 1
         ELSE 0 END,
       next_attempt_at = :now,
       delivery_owner = NULL,
       delivery_claim_expires_at = NULL,
       last_error_class = 'operator-confirmed-' || :effect || '-' || :outcome,
       updated_at = :now
 WHERE edition_key = :expected_edition_key
   AND state = 'execution_unknown'
   AND delivery_generation = :expected_delivery_generation
   AND delivery_owner IS :expected_delivery_owner
   AND updated_at = :expected_updated_at
   AND media_state = :expected_media_state
   AND next_chunk_index = :expected_next_chunk_index
   AND target_chat_id = :expected_target_chat_id
   AND map_image_url IS :expected_map_image_url
   AND map_date IS :expected_map_date
   AND payload_chunks_json = :expected_payload_chunks_json
   AND success_actions_json = :expected_success_actions_json
   AND safety_context_json = :expected_safety_context_json
   AND :outcome IN ('accepted', 'not_accepted')
   AND (
     (:effect = 'photo' AND media_state = 'pending'
       AND next_chunk_index = 0 AND map_image_url IS NOT NULL AND map_date IS NOT NULL)
     OR
     (:effect = 'text' AND media_state IN ('none', 'sent')
       AND next_chunk_index >= 0
       AND next_chunk_index < json_array_length(payload_chunks_json))
   );
```

Require exactly one changed row and authoritative post-write readback matching the selected matrix row; retain both in the incident record. Zero changes means stale state or an invalid effect/outcome, not success: stop and re-inspect/re-prove rather than weakening the fence. Do not execute both outcomes. Repeating a reconciliation with the old capture is a no-op.

After the final accepted text chunk, the next poll makes no Bot API call and commits the stored appendix actions with `sent`, subject to the normal publication-identity and delivery controls. Never set `sent` manually to bypass those actions.

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

Terminal rows preserved for audit stop degrading the `telegram-digest-outbox-drain`
surface once their `updated_at` is older than the 7-day operator-review window
(`TELEGRAM_DIGEST_OUTBOX_TERMINAL_REVIEW_SEC` in
`worker/src/lib/telegram/digest-outbox.ts`); they remain in the table and in the
drain summary's `retained*Total` counts. The review window bounds status
classification only — it never deletes, resets, or mutates a row.

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
