---
title: "Audit cron jobs and data pipeline"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all cron jobs and data pipeline logic for reliability, error handling, and correctness. Produce `FINDINGS-CRON.md` in the worktree root.

## Task

### Scope

All cron job files in `worker/src/cron/` (19 main cron files plus helper/config files and subdirectories like `dex-liquidity/` and `sync-stablecoins/`), supporting library code in `worker/src/lib/`, and related documentation.

### What to check

1. **Error handling**: For each cron job:
   - Does it catch errors at the top level and log/alert on failure?
   - Does it use `ctx.waitUntil()` correctly? (errors inside waitUntil are swallowed — check if they're caught)
   - Does a single-item failure (e.g., one stablecoin's data fetch fails) crash the entire job, or is it isolated?
   - Are network fetch errors handled with retries or graceful degradation?

2. **Connection pool / 6-connection limit**: Workers have a 6-connection limit per cron trigger. Check:
   - Are response bodies consumed (`await res.json()` / `await res.text()`) before starting new fetches?
   - Are there batching patterns that respect the limit?
   - Could concurrent `ctx.waitUntil()` jobs on the same cron slot exhaust the pool?
   - Reference: `docs/worker-and-api-limits.md` for the documented constraints

3. **Timeout risks**: Worker CPU time limit is 30s (paid plan) or 10ms (free). Check:
   - Are there unbounded loops that could hit the time limit?
   - Are large database operations batched?
   - Are external API calls given reasonable timeouts?

4. **Data integrity guardrails**: For crons that write to D1:
   - Do they validate data before inserting (e.g., reject negative supply values, NaN prices)?
   - Do they use `db.batch()` for atomic multi-row operations?
   - Could a partial failure leave the database in an inconsistent state?
   - Are there safeguards against writing stale/duplicate data?

5. **Staleness detection**: Check:
   - Do crons log their completion to `cron_runs` table (via `logCronRun` or similar)?
   - Does the status self-check (`status-self-check.ts`) monitor all crons?
   - Are there crons NOT covered by the self-check?

6. **Rate limiting compliance**: Cross-reference cron fetch patterns with limits in `docs/worker-and-api-limits.md`:
   - CoinGecko: 30 req/min (free) — are crons batching correctly?
   - DefiLlama: no documented limit but courtesy delays needed
   - DexScreener: 300 req/min — check DEX liquidity cron
   - Alchemy/Etherscan: per-key limits — check mint-burn and blacklist crons

7. **Cron scheduling conflicts**: Read `worker/wrangler.toml` or `worker/src/lib/cron-schedule.ts`. Check:
   - Do multiple heavy crons share the same trigger time?
   - Could concurrent execution of same-trigger crons exceed the 6-connection pool?
   - Are there crons that should run sequentially but are scheduled concurrently?

8. **Alert coverage**: Check `worker/src/lib/alerts.ts`:
   - Which cron failures trigger alerts?
   - Are there crons that fail silently (no alert, no status log)?
   - Is the alert channel (Telegram) configured and tested?

### Files to examine

- `worker/src/cron/*.ts` (all 21 files)
- `worker/src/lib/fetch-retry.ts` (retry logic)
- `worker/src/lib/abort.ts` (timeout handling)
- `worker/src/lib/alerts.ts` (alert system)
- `worker/src/lib/circuit-breaker.ts` (circuit breaker pattern)
- `worker/src/lib/rate-limits.ts` (rate limiting)
- `worker/src/lib/cron-schedule.ts` (scheduling)
- `worker/src/lib/db.ts` (database helpers)
- `worker/src/lib/stablecoins-cache.ts` (data cache)
- `worker/src/index.ts` (cron trigger dispatch)
- `docs/worker-infrastructure.md` (cron documentation)
- `docs/worker-and-api-limits.md` (external service limits)
- `docs/data-pipeline.md` (pipeline documentation)

### Output format

Write `FINDINGS-CRON.md` in the worktree root:

```markdown
# FINDINGS: Cron Jobs & Data Pipeline

## Summary
- X cron jobs examined
- Y findings (A critical, B high, C medium, D low)

## Cron Job Inventory
(table: name, schedule, what it does, alert coverage Y/N, self-check coverage Y/N)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Files Examined
(list)
```

Each finding:
```
- [CRON-NNN] **Title** — Description. Cron: `job-name`. File: `path:line`. Risk and fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-CRON.md` exists in the worktree root
- File contains the cron job inventory table
- File contains all four severity sections
- Every finding has a `[CRON-NNN]` ID, cron job reference, and effort tag
- Summary counts match actual findings
