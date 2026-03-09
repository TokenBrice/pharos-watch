---
title: "Update yield-history API to return warning_signals"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Include `warningSignals` in each data point returned by `GET /api/yield-history`.

## Task

1. **Read `worker/src/api/yield-history.ts`** (~49 lines).

2. **Add `warning_signals` to the SELECT query:**
   - Find the SQL query string. Add `warning_signals` to the selected columns.

3. **Add `warningSignals` to the row mapping:**
   - In the function that maps DB rows to response objects, add:
     ```ts
     warningSignals: row.warning_signals ? JSON.parse(row.warning_signals as string) : [],
     ```
   - Place it after the existing field mappings.

## Acceptance Criteria

- `grep -c "warning_signals" worker/src/api/yield-history.ts` returns >= 1
- `grep -c "warningSignals" worker/src/api/yield-history.ts` returns >= 1
- `cd worker && npx tsc --noEmit` exits 0
- `npm run build` exits 0
