---
title: "Audit data integrity: validation, error handling, edge cases, data flow correctness"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every data integrity and error handling issue — focused on missing validation, unsafe data transformations, unhandled error paths, and edge cases that could produce incorrect displays or data corruption.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos tracks 156+ stablecoins with data flowing: External APIs → Worker crons → D1 → Worker API → Frontend hooks → Components. Data correctness is critical — users make financial decisions based on what Pharos displays.

**Scope:** The entire data flow pipeline:
- `worker/src/cron/` — data ingestion from external APIs
- `worker/src/api/` — API response construction
- `worker/src/lib/` — data processing helpers
- `shared/lib/` — scoring and classification logic
- `src/hooks/` — data fetching and transformation
- `src/components/` — data display

**Key data integrity rules** (do NOT suggest violating these):
- Supply values from the DL list endpoint are already in USD — do NOT multiply by price
- The DL detail endpoint returns native currency for non-USD pegs — different contract
- No supply overrides — supply comes from DefiLlama only
- Price fallback chain: DL → CG → CMC → DexScreener

## Task

### 1. API Response Validation

- **Missing schema validation:** API handlers returning data without validating the shape from D1 queries. Fields assumed to exist that could be `null` or missing.
- **Type assertions without validation:** `as SomeType` casts on API responses or D1 query results without runtime checks.
- **Unchecked external API responses:** Cron jobs that `fetch()` external APIs and access response fields without checking the response shape. What happens when DefiLlama, CoinGecko, etc. change their API format?

### 2. Numeric Precision & Correctness

- **Division by zero:** Any division operation without a zero-check on the denominator. Particularly in scoring formulas (PSI, PegScore, DEWS, LiquidityScore, Report Cards).
- **NaN propagation:** Arithmetic on potentially `undefined` or `null` values that would produce `NaN`. Check if `NaN` values could propagate to the database or UI.
- **Floating point issues:** Price/supply comparisons using `===` instead of epsilon-based comparison. Accumulated rounding in multi-step calculations.
- **Currency conversion:** Any place where values might be double-converted (multiplied by price when already in USD). Check the DL list vs detail endpoint usage.
- **Integer overflow:** Large supply values that might exceed JavaScript's safe integer range (`Number.MAX_SAFE_INTEGER`). Are BigInt or string representations used where needed?

### 3. Null / Undefined Handling

- **Optional API fields:** Components accessing nested properties on optional fields without null checks (e.g., `data.depeg?.events?.length` vs `data.depeg.events.length`).
- **Missing data fallbacks:** What happens when a stablecoin has no price, no supply, no liquidity data, no depeg history? Does each consuming component handle the absence gracefully?
- **Array method safety:** `.map()`, `.filter()`, `.reduce()` called on values that could be `undefined` or `null` instead of an array.
- **Object destructuring:** Destructuring from potentially undefined objects without defaults.

### 4. Error Handling Coverage

- **Unhandled promise rejections:** `async` functions without try/catch or `.catch()`. Particularly in cron jobs where an unhandled rejection could crash the entire cron run.
- **Partial failure handling:** Cron jobs that process multiple stablecoins — does a failure on one stablecoin abort the entire batch, or is it isolated? Which is correct?
- **Error boundary gaps:** Frontend pages or major sections without error boundaries. A single component failure shouldn't take down the entire page.
- **Retry vs. fail-fast:** Which errors are transient (network, rate limit) and should retry, vs. permanent (bad data, schema change) and should fail fast? Are these handled correctly?
- **Alert/notification gaps:** Cron failures that should trigger alerts but don't. Silent failures that would go unnoticed.

### 5. Data Freshness & Staleness

- **Stale data display:** Components showing old data without any freshness indicator. How does the UI communicate "this data is 4 hours old" vs "this data is from 30 seconds ago"?
- **Cache invalidation:** Worker cache entries that might serve stale data after a cron run updates the underlying D1 data.
- **Race conditions:** Multiple cron jobs writing to the same D1 table. API requests reading while a cron is writing. Are there consistency issues?
- **Clock skew:** Timestamp comparisons that assume the worker clock and external API clocks are synchronized.

### 6. Scoring Edge Cases

For each scoring system, check boundary conditions and edge cases:

- **PSI (Pharos Stability Index)** — `worker/src/lib/stability-index.ts`: What happens at supply = 0? At exactly band boundaries? With missing components?
- **PegScore** — `shared/lib/peg-score.ts`: What happens with no price history? With extreme deviations? With exactly 1.00 price?
- **DEWS** — `worker/src/lib/dews.ts`: What happens when sub-signals are all zero? All maximum? When some data sources are unavailable?
- **LiquidityScore** — `worker/src/lib/dex-liquidity.ts`: What happens with zero liquidity? With only one pool? With negative quality multipliers?
- **Report Cards** — `shared/lib/report-cards.ts`: What happens when prerequisite data (supply, price, liquidity) is missing for grading?

### 7. Data Pipeline Integrity

- **Partial writes:** Cron jobs that write to multiple D1 tables in sequence. If the job fails midway, is the data left in an inconsistent state? (Remember: D1 has no transactions, only `db.batch()` atomicity.)
- **Idempotency:** Cron jobs that run twice in the same window — do they produce the same result, or do they double-count/corrupt data?
- **Backfill safety:** Backfill endpoints — can they safely be run multiple times? Do they handle existing data correctly (upsert vs. duplicate insert)?
- **Data dependency chains:** Cron jobs that depend on other cron jobs having run first. Is the scheduling order correct? What happens if a dependency job fails?

### 8. D1 Migration Health

- **Migration numbering:** Check `worker/migrations/` for sequential numbering consistency. Flag duplicates or gaps.
- **Missing indexes:** Check query patterns in API handlers and cron jobs against D1 schema. Flag N+1 patterns or queries on large tables (`mint_burn_events` ~1M rows, `mint_burn_hourly` ~630K, `supply_history` ~225K) without supporting indexes.
- **Idempotency:** Can migrations be safely re-run? Check for `CREATE TABLE IF NOT EXISTS` vs bare `CREATE TABLE`.
- **Schema documentation:** Do migration files match what's documented in feature docs?

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R5: Data Integrity & Error Handling Audit Report

## Summary
- Files audited: N
- Findings by severity: N critical, N important, N minor
- Findings by category: N validation, N numeric, N null-safety, N error-handling, N freshness, N scoring, N pipeline, N migration

## Critical Findings (could cause incorrect data display or data corruption)

### Finding C1: [Short description]
- **Category:** [Validation | Numeric | Null Safety | Error Handling | Freshness | Scoring | Pipeline | Migration]
- **Files:** `path:line` — `path:line`
- **Data flow stage:** [Ingestion | Processing | Storage | API | Frontend]
- **Description:** [What could go wrong and under what conditions]
- **Impact:** [What users would see or what data would be corrupted]
- **Suggested fix:** [Concrete description]
- **Effort:** [Low | Medium | High]
- **Risk:** [Low | Medium | High]

## Important Findings (could cause degraded experience)
### Finding I1: ...

## Minor Findings (edge cases unlikely to trigger)
### Finding M1: ...

## Scoring System Edge Case Matrix
| System | Supply=0 | No history | Missing component | Band boundary | All zero | All max |
|--------|----------|------------|-------------------|---------------|----------|---------|
| PSI    | [OK | Issue] | ... | ... | ... | ... | ... |
| PegScore | ... | ... | ... | ... | ... | ... |
| DEWS   | ... | ... | ... | ... | ... | ... |
| LiqScore | ... | ... | ... | ... | ... | ... |
| Report Card | ... | ... | ... | ... | ... | ... |

## Error Handling Coverage
| Cron Job / Handler | Try-catch | Partial failure isolation | Alert on failure | Retry logic |
|--------------------|-----------|--------------------------|-----------------|-------------|
| [job] | [Yes | No | Partial] | ... | ... | ... |

## Data Pipeline Dependency Map
[List cron job dependencies and identify any ordering risks]
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers the full data pipeline: cron → D1 → API → hooks → components
- Every finding has exact `file:line` references
- Every finding has an effort estimate (Low/Medium/High) and risk level
- Every finding describes the **conditions under which the issue triggers**
- Scoring edge case matrix covers all 5 scoring systems
- Error handling coverage table covers all cron jobs and major API handlers
- No code changes were made (read-only audit)
