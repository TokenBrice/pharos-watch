---
title: "Use existing helpers instead of reimplementing in cron jobs"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Replace manual reimplementations with existing helper calls in cron jobs: `fetchWithRetry` in blacklist cron, `getCache`/`setCache` in price enrichment, centralized `recordOutcome` wrapper, and `shouldSkipFreshCache` extraction.

## Context

The audit found several cron jobs manually reimplementing logic that already exists in `worker/src/lib/`. Using existing helpers reduces LOC and ensures consistent behavior.

## Task

### 1. Replace raw fetch in sync-blacklist with fetchWithRetry

**`worker/src/cron/sync-blacklist.ts`** has 4 locations (~lines 104, 154, 368, 481) where raw `fetch()` calls handle response validation, cancellation, and error handling manually.

The helper `fetchWithRetry` at `worker/src/lib/fetch-retry.ts:11` already provides retry + timeout logic.

Replace each raw fetch pattern with `fetchWithRetry`. The helper signature accepts a URL and options (including timeout, retries). Read the helper first to understand its API, then replace each raw fetch call site.

**Important:** The blacklist cron may have specific headers (API keys) for Etherscan, TronGrid, etc. Preserve those by passing them in the options object. Don't lose any request headers.

### 2. Replace manual cache SQL in enrich-prices with getCache/setCache

**`worker/src/cron/enrich-prices.ts`** at ~lines 334, 535, 592 uses raw SQL to read/write the `cache` table.

Existing helpers at `worker/src/lib/db.ts` (~lines 48, 57): `getCache(db, key)` and `setCache(db, key, value)`.

Replace the raw SQL cache operations with these helper calls. Read the helpers first to confirm their exact signatures.

### 3. Centralize safeRecordOutcome wrapper

**`worker/src/cron/enrich-prices.ts`** (~lines 347-350) and **`worker/src/cron/daily-digest.ts`** (~lines 572-574) both have the same non-blocking try/catch wrapper around `recordOutcome`.

Check if `worker/src/lib/circuit-breaker.ts` already has a safe variant. If not, add a `recordOutcomeSafe(db, source, success)` that wraps the call in a try/catch (non-blocking). Then use it in both cron files.

### 4. Extract shouldSkipFreshCache helper

**`worker/src/cron/sync-bluechip.ts`** (~lines 45-47) and **`worker/src/cron/sync-usds-status.ts`** (~lines 83-85) both implement the same freshness guard: read cache, check timestamp, skip if recent.

Extract a `shouldSkipFreshCache(db: D1Database, key: string, maxAgeSec: number): Promise<boolean>` helper into `worker/src/lib/db.ts` (or a new small file). Then use it in both cron files.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'new Response\|res\.ok\|res\.status' worker/src/cron/sync-blacklist.ts` is reduced (fewer raw response checks)
- `grep -c 'INSERT INTO cache\|SELECT.*FROM cache' worker/src/cron/enrich-prices.ts` returns 0 (using helpers now)
- `grep -c 'shouldSkipFreshCache\|fetchWithRetry' worker/src/cron/sync-bluechip.ts` returns >0
