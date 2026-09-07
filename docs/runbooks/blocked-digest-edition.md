# Runbook: Blocked Digest Edition

Use this runbook when a daily or weekly digest is held by the editorial style gate, or when an operator needs to distinguish that hold from a missing digest row, a channel delivery skip, or a watchdog gap.

## Symptom

A style-gate block leaves a `daily_digest` row with `digest_meta.qualityGate = "blocked"`. The row is retained for operator inspection. Public digest reads exclude it. It receives no edition number and no X or Telegram delivery.

The block follows the model response and its corrective retry. A style finding identifies the policy rule, field, excerpt, and position. The active gate mode determines whether a hard style finding is advisory telemetry or a publication block.

## Classify the outcome

Use the evidence below before retriggering:

| Case | Evidence | Result |
|---|---|---|
| Style-gate block | A `daily_digest` row exists with `qualityGate = "blocked"`; `input_data.editorialAudit.qualityIssueCodes` includes `editorial-style`, and `digest_meta.editorialStyleGate` contains the bounded findings and retry result. | The copy was generated and held before publication. No channel replay is available for that copy. |
| Missing row | No `daily_digest` row exists for the UTC date, and no blocked row exists. The `daily-digest` or `schedule_key = "digestTriggerPoll"` cron history shows an error, an abandoned slot, a skipped run, or no started child. | Treat this as a generation or scheduled-slot incident. Follow [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) when the history shows slot reconciliation. |
| Delivery skip | A non-blocked digest row exists and the archive projection assigns it a daily or weekly edition number, but channel metadata is `skipped: ...`, `queued: ...`, `outbox-*`, or another non-delivered state. | The edition was published to the archive. Follow [`telegram-digest-outbox.md`](./telegram-digest-outbox.md) for Telegram and inspect the channel delivery metadata for X. |
| Watchdog gap alert | `/api/status` or `cron-duration-watchdog` metadata reports `runtimeBreaching` or `slotAbandonmentBreaching`, or cron history contains a synthetic `scheduled-slot-abandoned` event. | The alert describes runtime or schedule evidence. It is not a style finding. Follow [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) and preserve the watchdog evidence. |

## Inspect

1. Query the digest row for the affected UTC date. Set `DIGEST_DATE` to the real UTC date first; do not run the command with a literal placeholder, because SQLite returns `NULL` for an invalid date and the empty result can look like a missing row.

   ```bash
   cd worker
   DIGEST_DATE=2026-09-01
   case "$DIGEST_DATE" in ????-??-??) ;; *) echo "DIGEST_DATE must be YYYY-MM-DD" >&2; exit 2;; esac
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT id, generated_at, digest_title, json_extract(digest_meta, '\$.qualityGate') AS quality_gate, json_extract(digest_meta, '\$.editorialStyleVersion') AS style_version, json_extract(digest_meta, '\$.editorialStyleHash') AS style_hash, json_extract(digest_meta, '\$.editorialStyleGate.mode') AS gate_mode, json_extract(digest_meta, '\$.editorialStyleGate.retry.outcome') AS retry_outcome, json_extract(input_data, '\$.editorialAudit.qualityIssueCodes') AS quality_issue_codes, json_extract(digest_meta, '\$.editorialStyleGate') AS editorial_style_gate FROM daily_digest WHERE generated_at >= unixepoch('${DIGEST_DATE} 00:00:00') AND generated_at < unixepoch('${DIGEST_DATE} 00:00:00', '+1 day') ORDER BY generated_at DESC;"
   ```

2. Query the related cron history. Include `daily-digest`, `cron-duration-watchdog`, and rows with `schedule_key = "digestTriggerPoll"` so a missing row and a watchdog event are visible beside a style block.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT job, schedule_key, status, started_at, duration_ms, error, substr(metadata, 1, 6000) AS metadata FROM cron_runs WHERE (job IN ('daily-digest', 'weekly-recap', 'cron-duration-watchdog') OR schedule_key = 'digestTriggerPoll') AND started_at >= unixepoch('${DIGEST_DATE} 00:00:00') ORDER BY started_at DESC LIMIT 50;"
   ```

3. Read the relevant `daily-digest` or `weekly-recap` completion metadata. Confirm the gate mode, first-pass findings, rule ids, fields, excerpts, and hard or advisory severity. A row in shadow mode can carry style findings while remaining publishable.

4. Read the retry details. Confirm whether the corrective retry was eligible, whether it ran, whether it resolved the finding, its latency, and its output-token use. A retry can be skipped after the first pass crosses the elapsed-time threshold or when the output-token budget cannot reserve another request.

5. Check `/api/status` for `crons["daily-digest"]`, `crons["weekly-recap"]`, `crons["digestTriggerPoll"]`, and `crons["cron-duration-watchdog"]`. Check `/api/digest-archive` only after confirming that the row is not blocked. Public reads omit blocked rows by design.

## Retrigger

1. Review the rule findings and confirm that the deployed prompt and editorial policy are current. Do not edit the blocked row or insert a replacement row by hand.

2. Use the normal Access-authenticated operator action. The service-token variables are provisioned as described in [`operator-origin-access.md`](../operator-origin-access.md#pages---ops-api-service-token). This command preserves both current style modes because the body does not supply `styleGateMode`:

   ```bash
   curl -fsS -X POST "https://ops-api.pharos.watch/api/trigger-digest" \
     -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
     -H "X-Pharos-Admin: 1" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: trigger-digest-$(date -u +%Y%m%dT%H%M%SZ)" \
     --data '{}'
   ```

   The endpoint writes a bounded force-run intent to `digest:force-run-request` and returns `202 Accepted` with a `requestId` and the full effective `styleGateMode: {daily, weekly}` state. It does not hold the HTTP request open for model generation.

3. Wait for the next `digestTriggerPoll` tick. The poll runs every five minutes, executes the leased `daily-digest` job, and records the result in `digest:last-trigger-result` and cron history. Inspect the request id, outcome, state, attempt count, and error before issuing another trigger.

4. If the retrigger produces another style block while enforcement is active, use the rollback procedure below before trying again. If the trigger has no corresponding poll result, classify the incident as a missing or scheduled-slot problem and use the appropriate runbook.

## Late publication and edition numbers

A retrigger may publish when the new response passes the active gate and the channel paths are available. Generation uses the current UTC date. A trigger that runs after the date has rolled publishes a current-date edition; it does not backfill the missed date.

Blocked rows never consume an edition number. A successful daily or weekly row receives the next number calculated from non-blocked rows. If the retrigger runs during the original UTC date, the successful row can use that date and the next available number. A late current-date edition does not renumber earlier editions.

## Subscriber-facing gap

A blocked edition produces no X post and no Telegram edition. The public latest and archive reads continue to show the newest non-blocked edition, so subscribers see a date gap. The blocked model output is not sent later as a channel replay.

A successful retrigger sends the new immutable edition through the normal channel paths. When the UTC date has rolled, that delivery covers the new date and leaves the missed date absent from both subscriber channels. Use a separate operator announcement only when the incident response requires one.

## Read shadow telemetry

Each edition stores `digest_meta.editorialStyleGate`, and the same bounded object is copied into completion `cron_runs.metadata`. It contains:

- `mode`
- `firstPassWouldBlock`, calculated from the uncapped first-pass hard findings
- `firstPassFindings[]` as `{ruleId, field, excerpt, originalSeverity}` plus the uncapped count and a truncation flag
- `retry` as `{eligible, attempted, outcome}`; outcomes distinguish shadow observation, time/token-budget skips, resolution, and unresolved findings
- `finalUnresolvedFindings[]` plus the uncapped count and a truncation flag

Each findings array is capped at 12 entries and each excerpt at 160 characters. `firstPassWouldBlock` remains safe for the flip metric even if details were truncated; `retry.eligible` separately records whether time and token budgets allowed a corrective generation. LLM attempts, latency, token use, `editorialStyleVersion`, and `editorialStyleHash` remain adjacent fields in `digest_meta` and cron metadata rather than being duplicated inside the bounded gate object.

For daily enforcement, count each edition with a first-pass hard finding as one `would-block` event. Advisory findings never enter the blocking count. The daily hard-flip criterion is at most one would-block in a 30-edition window. Weekly enforcement flips after seven consecutive clean daily editions have fed the weekly profile. Keep daily and weekly windows separate.

This query reports the measurable first-pass would-block edition count for the latest 30 stored editions of each type. It uses the uncapped `firstPassWouldBlock` boolean and excludes pre-policy rows:

```bash
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "WITH ranked AS (SELECT CASE WHEN json_extract(digest_meta, '\$.type') = 'weekly' THEN 'weekly' ELSE 'daily' END AS edition_type, generated_at, COALESCE(json_extract(digest_meta, '\$.editorialStyleGate.firstPassWouldBlock'), 0) AS would_block, ROW_NUMBER() OVER (PARTITION BY CASE WHEN json_extract(digest_meta, '\$.type') = 'weekly' THEN 'weekly' ELSE 'daily' END ORDER BY generated_at DESC) AS edition_rank FROM daily_digest WHERE json_type(digest_meta, '\$.editorialStyleGate') = 'object') SELECT edition_type, COUNT(*) AS editions_observed, SUM(would_block) AS first_pass_would_block_editions, MIN(generated_at) AS window_start, MAX(generated_at) AS window_end FROM ranked WHERE edition_rank <= 30 GROUP BY edition_type ORDER BY edition_type;"
```

## Promote or roll back enforcement

Daily and weekly use independent D1-backed controls at `digest:style-gate-mode:daily` and `digest:style-gate-mode:weekly`. A kind reads only its own key; a missing or invalid value fails safe to `shadow`. Daily can therefore promote as soon as its 30-edition criterion passes while weekly remains in shadow, and weekly can promote later without changing daily. For each kind, that one value also controls the U+2012 through U+2015 compatibility repair: shadow enables the post-scan repair, while enforce disables it and activates hard blocking.

Promote daily:

```bash
curl -fsS -X POST "https://ops-api.pharos.watch/api/trigger-digest" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: digest-style-daily-enforce-$(date -u +%Y%m%dT%H%M%SZ)" \
  --data '{"styleGateMode":{"daily":"enforce"}}'
```

Promote weekly after its separate readiness criterion passes:

```bash
curl -fsS -X POST "https://ops-api.pharos.watch/api/trigger-digest" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: digest-style-weekly-enforce-$(date -u +%Y%m%dT%H%M%SZ)" \
  --data '{"styleGateMode":{"weekly":"enforce"}}'
```

If enforcement blocks valid daily copy or a release produces unexpected daily blocks, roll back daily only:

```bash
curl -fsS -X POST "https://ops-api.pharos.watch/api/trigger-digest" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: digest-style-daily-shadow-$(date -u +%Y%m%dT%H%M%SZ)" \
  --data '{"styleGateMode":{"daily":"shadow"}}'
```

Roll back weekly without changing daily:

```bash
curl -fsS -X POST "https://ops-api.pharos.watch/api/trigger-digest" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "X-Pharos-Admin: 1" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: digest-style-weekly-shadow-$(date -u +%Y%m%dT%H%M%SZ)" \
  --data '{"styleGateMode":{"weekly":"shadow"}}'
```

The response returns both effective modes and queues the normal digest force-run intent. Confirm the targeted value changed and the other kind remained unchanged. A weekly mode update applies to the next eligible weekly generation or recovery; it does not force an out-of-slot weekly recap.

After changing the mode:

1. Confirm the next edition of the targeted kind has matching `digest_meta.styleGateMode` and `digest_meta.editorialStyleGate.mode` values. For rollback, both metadata fields must report `shadow`.
2. Confirm behavior matches the targeted mode: shadow records hard findings without blocking, while enforce blocks an unresolved hard finding after at most one corrective retry.
3. Preserve existing blocked rows and their metadata. Do not retag or rewrite archived editions.
4. Retrigger one reviewed edition and verify its row, edition number, channel statuses, and style telemetry.

The kill switch changes editorial style enforcement only. Existing hard content checks, channel safety checks, and delivery controls remain active.

## Verification

After the next poll or scheduled generation:

1. Confirm `digest:last-trigger-result` has the expected `requestId` and terminal outcome.
2. Confirm a successful row appears in the relevant public read path and carries its edition number and style provenance.
3. Confirm X and Telegram statuses match the intended delivery outcome. A channel-local failure does not require another model call.
4. Confirm the blocked row remains retained for inspection and absent from public reads when the block remains unresolved.
5. Confirm watchdog metadata is clear or has its own tracked incident when the original event involved a schedule gap.

## Related

- [`digest-pipeline.md`](../digest-pipeline.md) for generation, style-gate, storage, and delivery contracts.
- [`editorial-style.md`](../editorial-style.md) for the policy authority and register definitions.
- [`telegram-digest-outbox.md`](./telegram-digest-outbox.md) for durable Telegram delivery recovery.
- [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) for schedule abandonment and watchdog evidence.
