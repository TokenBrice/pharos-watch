---
title: "Add warning_signals column to yield_history table"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Add a `warning_signals TEXT` column to the `yield_history` table for historical warning signal tracking.

## Task

1. The latest migration is `0055_digest_meta.sql`. Create `worker/migrations/0056_yield_history_warning_signals.sql`:

2. **Create `worker/migrations/0056_yield_history_warning_signals.sql`:**
   ```sql
   ALTER TABLE yield_history ADD COLUMN warning_signals TEXT;
   ```

3. No index needed — history queries filter by `stablecoin_id + recorded_at`, not by signals.

## Acceptance Criteria

- `test -f worker/migrations/0056_yield_history_warning_signals.sql` returns success
- Note: migration 0033 adds `warning_signals` to `yield_data` (different table). This migration adds it to `yield_history`.
- The SQL file contains exactly `ALTER TABLE yield_history ADD COLUMN warning_signals TEXT;`
- `cd worker && npx tsc --noEmit` exits 0
- `npm run build` exits 0
