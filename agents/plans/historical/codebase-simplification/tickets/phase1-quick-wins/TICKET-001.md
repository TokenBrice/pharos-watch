---
title: "Remove duplicate SortDirection types and redundant pagination return"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Eliminate 2 redundant `SortDirection` type definitions and 1 redundant return field from table hooks.

## Task

### Part A: Remove duplicate SortDirection types

1. **`src/hooks/use-sorted-table-rows.ts`** (line 6):
   - Delete the local type definition: `type SortDirection = "asc" | "desc";`
   - Add `SortDirection` to the existing import from `@/hooks/use-sort` on line 4
   - Before:
     ```typescript
     import { useSort } from "@/hooks/use-sort";

     type SortDirection = "asc" | "desc";
     ```
   - After:
     ```typescript
     import { useSort, type SortDirection } from "@/hooks/use-sort";
     ```

2. **`src/hooks/use-sorted-paginated-table.ts`** (line 6):
   - Delete the local type definition: `type SortDirection = "asc" | "desc";`
   - Add `SortDirection` to the existing import from `@/hooks/use-sorted-table-rows` on line 3 (which re-exports `TableSortState` that already uses `SortDirection`). Actually, import it from `@/hooks/use-sort` directly since that's where it's canonically defined.
   - Before:
     ```typescript
     import { useSortedTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";
     import { useTablePagination } from "@/hooks/use-table-pagination";

     type SortDirection = "asc" | "desc";
     ```
   - After:
     ```typescript
     import { type SortDirection } from "@/hooks/use-sort";
     import { useSortedTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";
     import { useTablePagination } from "@/hooks/use-table-pagination";
     ```

### Part B: Remove redundant `page` from pagination return

3. **`src/hooks/use-table-pagination.ts`**:
   - In the `UseTablePaginationReturn<T>` interface (line 10-21), remove the `page: number;` field (line 11). Keep `effectivePage: number;` (line 12).
   - In the return statement (lines 113-124), remove `page: effectivePage,` (line 114). Keep `effectivePage,` (line 115).
   - Before (interface):
     ```typescript
     interface UseTablePaginationReturn<T> {
       page: number;
       effectivePage: number;
       totalPages: number;
       ...
     ```
   - After (interface):
     ```typescript
     interface UseTablePaginationReturn<T> {
       effectivePage: number;
       totalPages: number;
       ...
     ```
   - Before (return):
     ```typescript
     return {
       page: effectivePage,
       effectivePage,
       totalPages,
       ...
     ```
   - After (return):
     ```typescript
     return {
       effectivePage,
       totalPages,
       ...
     ```

**Note:** No consumer destructures or accesses `.page` from `useTablePagination` or `useSortedPaginatedTable`. The `src/app/blacklist/page.tsx` file has its own local `FilterState.page` field unrelated to the hook — do NOT modify it.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c "type SortDirection" src/hooks/use-sorted-table-rows.ts` returns 0
- `grep -c "type SortDirection" src/hooks/use-sorted-paginated-table.ts` returns 0
- `grep -c "type SortDirection" src/hooks/use-sort.ts` returns 1
- `grep -c "page: effectivePage" src/hooks/use-table-pagination.ts` returns 0 (the redundant alias is removed)
- `grep -c "page: number" src/hooks/use-table-pagination.ts` returns 1 (only `TablePaginationState.page` remains)
