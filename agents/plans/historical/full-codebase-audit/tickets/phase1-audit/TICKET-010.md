---
title: "Audit status page and observability"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit the status page, self-check system, and observability coverage. Produce `FINDINGS-STATUS.md` in the worktree root.

## Task

### Scope

The `/status` page (frontend and API), the status self-check cron, the alert system, and monitoring coverage.

### What to check

1. **Status API completeness** (`worker/src/api/status.ts`):
   - What data does the status endpoint return?
   - Does it cover ALL cron jobs? Cross-reference with the full cron list in `worker/src/cron/`
   - Does it cover ALL API endpoints (at least the critical ones)?
   - Does it include database health checks?
   - Does it report data freshness (when was each data source last updated)?

2. **Self-check cron** (`worker/src/cron/status-self-check.ts`):
   - What does it check?
   - Does it cover all data sources?
   - Does it detect stale data (e.g., supply data older than expected cron interval)?
   - Does it verify data quality (e.g., no negative values, no NaN)?
   - What happens when a check fails — is it logged, alerted, or silently ignored?

3. **Status reliability tracking** (`worker/src/lib/status-reliability.ts`):
   - How is reliability calculated?
   - Does it account for known maintenance windows?
   - Is historical reliability data stored and queryable?
   - Does `worker/src/api/status-history.ts` expose this data correctly?

4. **Alert system** (`worker/src/lib/alerts.ts`):
   - What triggers alerts? List all alert conditions.
   - Where do alerts go? (Telegram, etc.)
   - Are alerts deduplicated (no spam on repeated failures)?
   - Is there an alert for "alert system itself is broken"?
   - Are there failure modes that don't trigger any alert?

5. **Status frontend** (`src/app/status/page.tsx`):
   - Does the page accurately display all status data from the API?
   - Does it show historical trends?
   - Is admin authentication handled correctly (does it gate admin actions)?
   - Does it handle API errors gracefully?

6. **Monitoring blind spots**: Cross-reference all system components against status/alert coverage:
   - Cron jobs without status tracking
   - API endpoints without health checks
   - External service dependencies without monitoring (CoinGecko down, DexScreener down, etc.)
   - Database size/growth without monitoring
   - Worker resource usage (CPU, memory) without tracking

7. **Status thresholds** (`worker/src/lib/status-thresholds.ts`):
   - Are staleness thresholds aligned with cron intervals?
   - Are data quality thresholds reasonable?
   - Could threshold misalignment cause false positives or missed alerts?

8. **Live probes** (attempt these):
   ```bash
   curl -s https://api.pharos.watch/api/status | python3 -m json.tool | head -50
   curl -s https://api.pharos.watch/api/status-history?days=7 | python3 -m json.tool | head -30
   curl -s -o /dev/null -w '%{http_code}' https://pharos.watch/status
   ```
   If curl is unavailable, note "Live probes not executed" and continue.

### Files to examine

- `worker/src/api/status.ts` (status API)
- `worker/src/api/status-history.ts` (historical status)
- `worker/src/cron/status-self-check.ts` (self-check cron)
- `worker/src/lib/alerts.ts` (alert system)
- `worker/src/lib/status-reliability.ts` (reliability tracking)
- `worker/src/lib/status-thresholds.ts` (threshold config)
- `src/app/status/page.tsx` (status frontend)
- `docs/status-dashboard.md` (documentation)
- `docs/worker-infrastructure.md` (cron scheduling reference)

### Output format

Write `FINDINGS-STATUS.md` in the worktree root:

```markdown
# FINDINGS: Status & Observability

## Summary
- X components examined
- Y findings (A critical, B high, C medium, D low)
- Live probes: executed / not executed

## Monitoring Coverage Matrix
(table: component → status tracked Y/N, alert on failure Y/N, data freshness check Y/N)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Live Probe Results
(output or "Not executed")

## Files Examined
(list)
```

Each finding:
```
- [STATUS-NNN] **Title** — Description. Component: `name`. File: `path:line`. Gap and fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-STATUS.md` exists in the worktree root
- File contains the monitoring coverage matrix
- File contains all four severity sections
- Every finding has a `[STATUS-NNN]` ID, component reference, and effort tag
- Summary counts match actual findings
