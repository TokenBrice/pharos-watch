---
title: "Audit worker/src/cron/ for redundancy, shared patterns, and LOC reduction opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in `worker/src/cron/` (~18K LOC, ~60 files) — focused on duplicated fetch/DB patterns, shared logic extraction, and LOC reduction without affecting features.

## Context

This is a read-only research task. You are NOT implementing changes — you are producing a detailed audit report.

The worker is a Cloudflare Worker using D1 (SQLite). Cron jobs sync data from external APIs (DefiLlama, CoinGecko, DexScreener, Alchemy, Etherscan, etc.) into D1 tables.

Key constraints to be aware of (do NOT suggest violating these):
- Workers have a 6-connection limit per cron trigger, shared across all `ctx.waitUntil()` jobs
- D1 does NOT support explicit transactions — `db.batch()` provides atomicity
- D1 per-statement limit is 30 seconds execution time
- Response bodies must be consumed before starting new fetch batches

`worker/src/lib/` contains shared DB helpers and utilities that cron jobs can use.

**Keywords for this audit:** refine, enhance, reduce LOC — without affecting features.

## Task

### 1. Duplicated Fetch Patterns
- Compare how each cron file fetches external APIs. Look for repeated patterns: retry logic, error handling, response parsing, rate limiting, batch chunking.
- Identify which patterns could be consolidated into shared helpers in `worker/src/lib/`.

### 2. Duplicated DB Patterns
- Compare how each cron file writes to D1. Look for repeated INSERT/UPSERT patterns, batch statement construction, error handling.
- Check if existing helpers in `worker/src/lib/` are underused (cron jobs reimplementing what helpers already provide).

### 3. Cross-Cron Shared Logic
- Data transformation patterns used across multiple cron jobs
- Logging/alerting patterns
- Shared timestamp/date handling
- Common data validation logic

### 4. Dead / Unused Code
- Functions defined but never called
- Commented-out code blocks
- Unused imports
- Stale TODO comments referencing completed work
- Code paths that can never execute

### 5. Simplification Opportunities
- Overly complex control flow that could be streamlined
- Verbose patterns where terser equivalents exist
- Unnecessary intermediate variables or transformations
- Deep nesting that could be flattened

### 6. Large File Review
Review each cron file >500 LOC for whether it could be split into smaller modules:
- `sync-yield-data.ts` (971 LOC)
- `sync-blacklist.ts` (739 LOC)
- `dex-liquidity/fetch-primary.ts` (716 LOC)
- `enrich-prices.ts` (708 LOC)
- `sync-mint-burn.ts` (672 LOC)
- `sync-stablecoins.ts` (669 LOC)
- `daily-digest.ts` (621 LOC)

Also audit test files in `worker/src/cron/__tests__/` for redundant test patterns.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# Worker Cron Audit Report

## Summary
- Files audited: N
- Total LOC audited: N
- Estimated LOC reducible: N (X%)
- Findings: N duplicated fetch, N duplicated DB, N shared logic, N dead code, N simplification

## Critical Findings (>50 LOC savings each)
### Finding C1: ...

## Important Findings (10–50 LOC savings each)
### Finding I1: ...

## Minor Findings (<10 LOC savings each)
### Finding M1: ...

## Duplicated Fetch Patterns
[Pattern name] — found in: [file1, file2, ...] — description — suggested shared helper

## Duplicated DB Patterns
[Pattern name] — found in: [file1, file2, ...] — description — suggested shared helper

## Large File Assessments
[file] — [justifiably large / should split] — reasoning

## Underused Existing Helpers
[helper in worker/src/lib/] — [which cron files reimplement it instead of using it]
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `worker/src/cron/` including subdirectories and test files
- Every finding has exact file:line references
- Every finding has a LOC impact estimate
- Cross-cron pattern analysis covers at least the 7 large files listed above
- No code changes were made (read-only audit)
