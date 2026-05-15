# D1 Off-Cloudflare Backup Plan

Planning doc for adding a weekly off-Cloudflare logical backup of the production D1 database. Today the only recovery path is Cloudflare D1 Time Travel; this doc proposes a second, independent path with longer retention.

## Current state

- Production rollback depends entirely on **Cloudflare D1 Time Travel**, as documented in `worker/migrations/MANIFEST.md` ("Rollback Procedure"). The MANIFEST notes retention is account-plan dependent and must be verified against Cloudflare before relying on a bookmark.
- No off-Cloudflare snapshot of D1 contents exists. Migration files in `worker/migrations/` reproduce schema only — they contain no row data beyond the small seed set in the baseline.

## Risk

- If an incident requires going back **further than Time Travel retention**, recovery degrades to manual replay from the migration tree, which restores schema but loses all collected telemetry (blacklist events, depeg events, cron history, telegram subscribers, mint/burn events, supply history, etc.).
- Single-provider dependency: a Cloudflare-side outage or account compromise that affects D1 also affects Time Travel and R2.

## Proposal

Add a **weekly logical export** of critical D1 tables to durable storage outside Cloudflare's data plane.

### Critical tables (load-bearing for recovery)

Approximately the ten highest-value tables for incident recovery and operator continuity:

1. `telegram_subscribers` — chat-level subscription state (cannot be reconstructed from any external source)
2. `telegram_subscriptions` — per-coin follow records and snooze state
3. `blacklist_events` — historical blacklist ledger (expensive to re-sync from chain)
4. `blacklist_sync_state` / `blacklist_current_balances` — cursors and current balance cache
5. `depeg_events` / `depeg_event_provenance` — historical depeg incident record
6. `mint_burn_events` — mint/burn ledger (expensive multi-chain re-sync)
7. `supply_history` / `chain_supply_history` — supply timeseries
8. `cron_runs` / `cron_slot_executions` / `cron_leases` — scheduled-job ledger and fencing state
9. `api_keys` / `api_key_audit_log` — issued keys and audit trail
10. `feedback_submissions` — operator-collected feedback (no external source)

The exact list is encoded in the export Worker, not in this doc.

### Export format

**Newline-delimited JSON** per table. Each line is one row serialized as a JSON object keyed by column name. Rationale:

- Tolerates schema additions (new columns appear in newer files without invalidating older ones).
- Streams cleanly from the D1 bulk-query API and writes incrementally to the destination.
- Restoring into a scratch D1 is a straightforward `INSERT` loop using the manifest to map JSON keys to columns.

A small **schema manifest** (`schema.json`) sits beside the row files and captures column lists per table from `sqlite_master`, so a restore knows exactly which columns existed at the time of the snapshot.

### Destination

Target a storage destination **on a separate provider** from Cloudflare. Candidates in order of preference: AWS S3, Backblaze B2, or a self-hosted S3-compatible endpoint. R2 is acceptable as a fallback but does not fully eliminate single-provider risk and should not be the primary destination.

Final destination choice is an open question for the operator (see below).

### Frequency

- **Weekly minimum.** A weekly snapshot bounds maximum data loss to ~7 days in the worst case, beyond Time Travel retention.
- **Daily preferred** for the critical-tables subset if storage cost permits. Daily snapshots add no meaningful additional implementation work since the export Worker is the same code path.

### Retention

- **90 days rolling.** Older snapshots are deleted by lifecycle policy on the destination bucket. 90 days covers most "found the corruption weeks later" recovery scenarios and keeps storage cost bounded.

### Encryption

- **At rest with a key not stored in Cloudflare.** The export Worker encrypts each file before upload using a key supplied via a non-Cloudflare secret store. The decryption key never touches the Worker's environment in a way that would couple key access to Cloudflare account access.

## Implementation sketch

A new scheduled handler under `worker/src/handlers/scheduled/` (peer of `daily-0300.ts`, `hourly-blacklist.ts`, etc.), wired to a new cron trigger — e.g. **weekly Sunday 03:00 UTC** — and registered through `worker/src/handlers/scheduled/context.ts` plus `shared/lib/cron-jobs.ts`.

The handler iterates the critical-tables list, runs paginated `SELECT *` reads via the D1 binding, streams each row out as NDJSON, encrypts, and uploads to the destination via the bucket's S3-compatible API. The cron-trigger budget policy in `docs/process/cron-trigger-policy.md` applies — if a fresh trigger expression cannot be justified, the export can share an existing low-utilization daily slot.

Restore path is a one-off Worker script (or local `wrangler d1 execute` driver) that reads a snapshot manifest, decrypts, and replays inserts in dependency order into a scratch D1 database.

## Verification step

**Quarterly recovery rehearsal.** On a scheduled cadence:

1. Pick a recent snapshot at random.
2. Provision a scratch D1 database.
3. Apply the current migration tree to set up schema.
4. Replay the snapshot into the scratch DB.
5. Run a smoke query set (row counts per table, a couple of API endpoints pointed at the scratch DB) and confirm the data shape matches.
6. Tear down the scratch DB.

Rehearsal results are recorded in an operator log entry. A failed rehearsal blocks future snapshots from being trusted as recovery evidence until the failure is diagnosed.

## Settled decisions (2026-05-15)

- **Storage destination:** **Backblaze B2** (S3-compatible API). Truly off-Cloudflare, cheapest option for the critical-tables footprint. Falls in the "kilobytes to low megabytes per snapshot" range; B2's free tier easily covers the rolling 90-day retention.
- **Key custody:** **Operator's personal password manager (1Password / Bitwarden)**. Key never enters the Worker environment; encryption happens with a key fetched at upload time via a Cloudflare secret that's rotated independently of the password-manager record. Restore requires a human operator to retrieve the key — acceptable for the quarterly rehearsal cadence.
- **Cost ownership:** **Personal (TokenBrice) billing**. Storage cost is low single-digit USD/month and is handled outside the public funding wallet to keep the donations ledger focused on Pharos-the-product line items.
- **When to enable:** **ASAP**. Backup is independently valuable and accumulates snapshots before the next baseline squash. Not coupled to the squash schedule — the squash will simply benefit from whatever backup state exists at that point.
- **Pause behavior:** **Self-pause after 3 consecutive upload failures**, with a Telegram-alert ping to the operator. Matches the existing scheduled-runner retry conventions; avoids spamming the dead-letter path on transient destination outages.
