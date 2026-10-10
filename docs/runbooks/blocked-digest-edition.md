# Runbook: Blocked Digest Edition

Use this runbook when a daily or weekly digest is held by the editorial style gate, or when an operator needs to distinguish that hold from a missing digest row, a channel delivery skip, or a watchdog gap.

## Symptom

A style-gate block leaves a `daily_digest` row with `digest_meta.qualityGate = "blocked"`. The row is retained for operator inspection. Public digest reads exclude it. It receives no edition number and no X or Telegram delivery.

The block follows the model response and at most one budget-eligible corrective retry. A style finding identifies the policy rule, field, excerpt, and position. The active gate mode determines whether a hard style finding is advisory telemetry or a publication block.

## Classify the outcome

Use the evidence below before retriggering:

| Case | Evidence | Result |
|---|---|---|
| Style-gate block | A `daily_digest` row exists with `qualityGate = "blocked"`; `input_data.editorialAudit.qualityIssueCodes` includes `editorial-style`, and `digest_meta.editorialStyleGate` contains the bounded findings and retry result. | The copy was generated and held before publication. No channel replay is available for that copy. |
| Missing row | No `daily_digest` row exists for the UTC date, and no blocked row exists. The `daily-digest` or `schedule_key = "digestTriggerPoll"` cron history shows an error, an abandoned slot, a skipped run, or no started child. | Treat this as a generation or scheduled-slot incident. Follow [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) when the history shows slot reconciliation. |
| Delivery skip | A non-blocked digest row exists and the archive projection assigns it a daily or weekly edition number, but channel metadata is `skipped: ...`, `queued: ...`, `outbox-*`, or another non-delivered state. | The edition was published to the archive. Follow [`telegram-digest-outbox.md`](./telegram-digest-outbox.md) for Telegram and inspect the channel delivery metadata for X. |
| Watchdog gap alert | `/api/status` → `crons["cron-sentinel"]` → `lastRun.metadata.sources.duration.metadata` reports `runtimeBreaching` or `slotAbandonmentBreaching`, or a retained sentinel run in `recentRuns` carries those findings; a synthetic `scheduled-slot-abandoned` event is independent slot evidence. | Successful observation is `ok` plus quality; it is not a style finding or a failure of the watchdog. Follow [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) and preserve the underlying schedule/runtime evidence. |

## Inspect

1. Query the digest row for the affected UTC date. Set `DIGEST_DATE` to the real UTC date first; do not run the command with a literal placeholder, because SQLite returns `NULL` for an invalid date and the empty result can look like a missing row.

   ```bash
   cd worker
   DIGEST_DATE=2026-09-01
   case "$DIGEST_DATE" in ????-??-??) ;; *) echo "DIGEST_DATE must be YYYY-MM-DD" >&2; exit 2;; esac
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT id, generated_at, digest_title, json_extract(digest_meta, '\$.qualityGate') AS quality_gate, json_extract(digest_meta, '\$.editorialStyleVersion') AS style_version, json_extract(digest_meta, '\$.editorialStyleHash') AS style_hash, json_extract(digest_meta, '\$.editorialStyleGate.mode') AS gate_mode, json_extract(digest_meta, '\$.editorialStyleGate.retry.outcome') AS retry_outcome, json_extract(input_data, '\$.editorialAudit.qualityIssueCodes') AS quality_issue_codes, json_extract(digest_meta, '\$.editorialStyleGate') AS editorial_style_gate FROM daily_digest WHERE generated_at >= unixepoch('${DIGEST_DATE} 00:00:00') AND generated_at < unixepoch('${DIGEST_DATE} 00:00:00', '+1 day') ORDER BY generated_at DESC;"
   ```

2. Query the related cron history. Include `daily-digest`, `cron-sentinel`, and rows with `schedule_key = "digestTriggerPoll"` so a missing row and a watchdog finding are visible beside a style block. Inspect sentinel `metadata.sources.duration.metadata` and `metadata.sources["digest-publication"].metadata`; standalone duration rows are retired.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT job, schedule_key, status, started_at, duration_ms, error, substr(metadata, 1, 6000) AS metadata FROM cron_runs WHERE (job IN ('daily-digest', 'weekly-recap', 'cron-sentinel') OR schedule_key = 'digestTriggerPoll') AND started_at >= unixepoch('${DIGEST_DATE} 00:00:00') ORDER BY started_at DESC LIMIT 50;"
   ```

3. Read the relevant `daily-digest` or `weekly-recap` completion metadata. Confirm the gate mode, first-pass findings, rule ids, fields, excerpts, and hard or advisory severity. A row in shadow mode can carry style findings while remaining publishable.

4. Read the retry details. Confirm whether the corrective retry was eligible, whether it ran, whether it resolved the finding, its latency, and its output-token use. A retry can be skipped after the first pass crosses the elapsed-time threshold or when the output-token budget cannot reserve another request.

5. Check `/api/status` for `crons["daily-digest"]`, `crons["weekly-recap"]`, and `crons["cron-sentinel"]` (`lastRun.metadata` / `recentRuns` for duration and digest-publication findings). The poll is a schedule key, not a `crons` job: inspect its clock in `schedulerLiveness.lanes` and its diagnostic `digest-trigger-poll` entry in `budgetOnlySurfaces`. Check `/api/digest-archive` only after confirming that the row is not blocked. Public reads omit blocked rows by design.

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

For daily enforcement, count each distinct scheduled edition with a first-pass hard finding as one `would-block` event. Advisory findings never enter the blocking count. The daily criterion is at most one event in the latest 30 distinct scheduled daily editions, with complete boolean telemetry. The ratified weekly criterion is **eight consecutive distinct scheduled weekly editions after the cleft prompt cutover, complete boolean telemetry, and zero first-pass hard events**. Keep kinds separate; seven clean daily inputs and the five old-prompt weekly samples do not qualify weekly readiness.

Select the editions before inspecting telemetry. Include blocked and missing-policy rows; exclude only internal sentinel artifacts. Missing or non-boolean `firstPassWouldBlock` is a metadata gap, not a clean observation. Set explicit observation bounds covering the required scheduled window (the dates below are an example), inspect at most 200 rows, and widen/review separately if the cap is reached. Reconcile duplicate UTC dates against scheduled invocation evidence rather than counting retriggers as new scheduled editions. Check expected daily dates/Mondays for absent editions as well as the reported per-row gaps.

```bash
cd worker
WINDOW_START=2026-09-01
WINDOW_END=2026-10-08
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "SELECT id, generated_at, CASE WHEN json_extract(digest_meta, '\$.type') = 'weekly' THEN 'weekly' ELSE 'daily' END AS edition_type, date(generated_at, 'unixepoch') AS edition_date, json_extract(digest_meta, '\$.qualityGate') AS quality_gate, json_extract(digest_meta, '\$.editorialStyleVersion') AS style_version, json_extract(digest_meta, '\$.editorialStyleHash') AS style_hash, json_type(digest_meta, '\$.editorialStyleGate.firstPassWouldBlock') AS would_block_type, CASE WHEN json_type(digest_meta, '\$.editorialStyleGate.firstPassWouldBlock') IN ('true', 'false') THEN 0 ELSE 1 END AS metadata_gap, json_extract(digest_meta, '\$.editorialStyleGate.firstPassWouldBlock') AS would_block, json_extract(digest_meta, '\$.editorialStyleGate') AS style_gate, json_extract(digest_meta, '\$.llm') AS llm FROM daily_digest WHERE generated_at >= unixepoch('${WINDOW_START} 00:00:00') AND generated_at < unixepoch('${WINDOW_END} 00:00:00') AND (digest_meta IS NULL OR json_extract(digest_meta, '\$.internal') IS NULL OR json_extract(digest_meta, '\$.internal') NOT IN (1, 'true')) ORDER BY generated_at DESC, id DESC LIMIT 200;"
```

Record edition IDs, schedule/invocation identities, observation bounds, policy version/hash, rendered prompt and generation configuration, and requested/served model and effort from LLM provenance. Review raw copy and findings for omissions and known false positives; a detail truncation flag cannot certify per-rule incidence. Relevant prompt/model changes restart continuity unless the readiness owner records an explicit exception. After each failed readiness window, the owner records an explicit reject/retry decision; there is no automatic cancellation policy.

## Promote or roll back enforcement

Daily and weekly use independent D1-backed controls at `digest:style-gate-mode:daily` and `digest:style-gate-mode:weekly`. A kind reads only its own key; a missing or invalid value fails safe to `shadow`, but a D1 read error propagates and is not evidence of shadow. Daily enforcement is approved conditional on the mode-only control and focused checks; weekly remains shadow until its ratified packet and separate approval pass. For each kind, that one value also controls the U+2012 through U+2015 compatibility repair: shadow enables the post-scan repair, while enforce disables it and activates hard blocking.

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

These mode-only actions return both effective modes and write only the targeted mode key. They do **not** write `digest:force-run-request`, alter an existing force intent, or queue any additional daily/weekly generation. Confirm the other kind remained unchanged. The first enforced observation is the next scheduled edition of that kind; weekly mode changes never force an out-of-slot recap. An explicit separate empty-body/`{}` trigger is the only way to request a daily force-run.

A mode write can commit before an effective-mode read or response fails. Treat an errored/ambiguous action as a potential partial commit: inspect both exact mode keys and the original idempotency record before any new mutation, following ADR-27. Do not assume HTTP failure rolled back the key or blindly issue a new force-run. Reconcile an existing force intent separately if one was explicitly requested.

After changing the mode:

1. Confirm the next edition of the targeted kind has matching `digest_meta.styleGateMode` and `digest_meta.editorialStyleGate.mode` values. For rollback, both metadata fields must report `shadow`.
2. Confirm behavior matches the targeted mode: shadow records hard findings without blocking, while enforce blocks an unresolved hard finding after at most one corrective retry.
3. Preserve existing blocked rows and their metadata. Do not retag or rewrite archived editions.
4. For daily promotion, inspect the first enforced scheduled edition and seven subsequent daily editions before the approved cleft detector/prompt retirement. Prompt retirement is a separate cutover; review seven subsequent daily copies and begin the fresh eight-weekly readiness window there. After weekly promotion, inspect two naturally scheduled enforced weekly generations and ordinary recovery. Capture row/edition number, both stored mode fields, retry/budget/quality results, and channel outcomes without manufacturing editions.

The kill switch changes editorial style enforcement only. Existing hard content checks, channel safety checks, and delivery controls remain active.

## Verification

After an explicit trigger or a scheduled generation:

1. For an explicit force-run only, confirm `digest:last-trigger-result` has the expected `requestId` and terminal outcome. A mode-only update produces no force request ID or poll result.
2. Confirm a successful row appears in the relevant public read path and carries its edition number and style provenance.
3. Confirm X and Telegram statuses match the intended delivery outcome. A channel-local failure does not require another model call.
4. Confirm the blocked row remains retained for inspection and absent from public reads when the block remains unresolved.
5. Confirm watchdog metadata is clear or has its own tracked incident when the original event involved a schedule gap.

## Related

- [`digest-pipeline.md`](../digest-pipeline.md) for generation, style-gate, storage, and delivery contracts.
- [`editorial-style.md`](../editorial-style.md) for the policy authority and register definitions.
- [`telegram-digest-outbox.md`](./telegram-digest-outbox.md) for durable Telegram delivery recovery.
- [`cron-slot-abandonment.md`](./cron-slot-abandonment.md) for schedule abandonment and watchdog evidence.
