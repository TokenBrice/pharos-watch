---
title: "Audit database schema and data integrity"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit the D1 database schema, migrations, and data integrity patterns. Produce `FINDINGS-SCHEMA.md` in the worktree root.

## Task

### Scope

All migration files in `worker/migrations/` (50 files, including out-of-sequence `0031a_mint_burn_v2.sql` and duplicate-numbered `0046_mint_burn_bridge_classification.sql`), database helper code, and type definitions that bridge DB to API to frontend.

### What to check

1. **Migration sequence integrity**: Read all 50 migration files in order:
   - Are there gaps or out-of-order migrations? (Note: `0031a_mint_burn_v2.sql` is out of normal sequence — check if this is intentional)
   - Are there migrations that could conflict with each other?
   - Do later migrations assume tables/columns created by earlier ones?
   - Are there migrations that are purely destructive (DROP without CREATE)?

2. **Index coverage**: From the migrations, build a picture of all tables and their indexes. Flag:
   - Tables with frequent query patterns (based on API handlers) but no supporting index
   - Large tables (`mint_burn_events` ~1M rows, `mint_burn_hourly` ~630K, `supply_history` ~225K) — are their common query patterns indexed?
   - Composite indexes that may not match actual query patterns (wrong column order)
   - Missing UNIQUE constraints where data should be unique

3. **Type consistency DB-to-API-to-frontend**: Trace key data types through the stack:
   - `stablecoin_id`: What's the column type in each table? Is it consistently TEXT?
   - Numeric values (supply, price, score): Are they stored as REAL or TEXT? Are they parsed consistently in API handlers?
   - Dates/timestamps: Consistent format (ISO 8601? Unix epoch?)?
   - Check `worker/src/lib/env.ts` for the `Env` interface — does it match `wrangler.toml` bindings?

4. **Schema-code drift**: Compare the schema implied by migrations with how code actually queries:
   - Read `worker/src/lib/db.ts` and API handlers for SQL queries
   - Flag queries that reference columns/tables not defined in migrations
   - Flag columns defined in migrations but never queried (dead columns)

5. **Data integrity risks**: Check for:
   - INSERT/UPDATE statements without WHERE clauses (accidental full-table updates)
   - DELETE statements without proper scoping
   - Missing NOT NULL constraints on columns that should never be null
   - Missing DEFAULT values on columns that need them
   - Foreign key-like relationships without enforcement (D1 supports FK but they may not be used)

6. **Query safety patterns**: Check all SQL in the codebase for:
   - SQL injection risks (string interpolation in SQL — should use parameterized queries)
   - Unbounded SELECTs (missing LIMIT on queries that could return large result sets)
   - N+1 query patterns (loop of individual queries instead of batch)

7. **Batch operation safety**: Check `db.batch()` usage:
   - Are batch sizes bounded? (D1 has limits on batch size)
   - Are large operations broken into manageable batches?

### Files to examine

- `worker/migrations/*.sql` (all 48 files)
- `worker/src/lib/db.ts` (database helpers)
- `worker/src/lib/env.ts` (Env interface with D1 bindings)
- `worker/src/api/*.ts` (SQL queries in API handlers)
- `worker/src/cron/*.ts` (SQL queries in cron jobs)
- `worker/wrangler.toml` (D1 binding configuration)
- `shared/lib/*.ts` (shared types that bridge to DB data)

### Output format

Write `FINDINGS-SCHEMA.md` in the worktree root:

```markdown
# FINDINGS: Schema & Data Integrity

## Summary
- X migration files examined
- Y source files with SQL examined
- Z findings (A critical, B high, C medium, D low)

## Table Inventory
(table: name, created in migration #, row estimate if known, index count)

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
- [SCHEMA-NNN] **Title** — Description. Table: `table_name`. File: `path:line`. Issue and fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-SCHEMA.md` exists in the worktree root
- File contains the table inventory
- File contains all four severity sections
- Every finding has a `[SCHEMA-NNN]` ID, table/file reference, and effort tag
- Summary counts match actual findings
