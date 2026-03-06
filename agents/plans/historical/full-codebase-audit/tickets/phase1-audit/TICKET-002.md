---
title: "Audit frontend UI/UX quality and consistency"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all frontend pages and components for UI/UX quality, consistency, and code health. Produce `FINDINGS-FRONTEND-UX.md` in the worktree root.

## Task

### Scope

All files in `src/app/` (27 pages) and `src/components/` (UI components). Do NOT audit `src/components/ui/` (shadcn primitives — not project-owned).

### What to check

1. **Error states**: Every page and data-fetching component should handle error states gracefully. Look for TanStack Query hooks (`useQuery`, `useSuspenseQuery`) and check that error/loading states are rendered. Flag any component that uses data without checking `isLoading`, `isError`, or `error`.

2. **Loading states**: Every page should show a loading skeleton or spinner while data loads. Look for `Suspense` boundaries or manual loading checks. Flag pages that show nothing or flash empty content.

3. **Empty states**: Tables, lists, and charts should handle empty data (0 items). Look for `.map()` calls on query results — check if there's a fallback when the array is empty.

4. **Design token compliance**: Check that components use Tailwind classes from the project's design system. Look for:
   - Hardcoded color values (`#xxx`, `rgb(...)`) instead of Tailwind tokens
   - Hardcoded spacing (`style={{ margin: ... }}`) instead of Tailwind spacing classes
   - Inconsistent border radius, shadow, or font size usage across similar components
   - Reference: `docs/design-tokens.md` and `docs/design-language.md`

5. **Component patterns**: Check for consistent patterns across pages:
   - Page headers (title + description) — are they consistent?
   - Card layouts — same padding, borders, shadows?
   - Table components — same sorting, filtering, pagination patterns?
   - Chart components — same tooltip format, color scheme, axis labels?

6. **Dead code**: Look for:
   - Unused imports (TypeScript compiler may not catch runtime-only imports)
   - Commented-out code blocks (more than 3 lines)
   - Components that are defined but never imported anywhere
   - Unused CSS classes or Tailwind utilities

7. **Responsive design**: Check that pages work at mobile widths. Look for:
   - Missing responsive breakpoint classes (`sm:`, `md:`, `lg:`)
   - Tables without horizontal scroll wrappers
   - Fixed-width containers that would overflow on mobile
   - Missing `overflow-hidden` or `overflow-x-auto` on data-heavy components

8. **Dynamic Tailwind classes**: Flag any instance of dynamically constructed Tailwind class names (string interpolation in `className`). These break Tailwind's purge. Example of what to flag:
   ```tsx
   // BAD — will be purged
   className={`bg-${color}-500`}
   ```

### Files to examine

- `src/app/**/page.tsx` (all 27 pages)
- `src/app/layout.tsx`
- `src/components/**/*.tsx` (exclude `src/components/ui/`)
- `src/hooks/*.ts` (check how data is consumed)
- `src/lib/chart-colors.ts`, `src/lib/severity-colors.ts` (color definitions)

### Output format

Write `FINDINGS-FRONTEND-UX.md` in the worktree root using this exact structure:

```markdown
# FINDINGS: Frontend UI/UX

## Summary
- X files examined
- Y findings (A critical, B high, C medium, D low)

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
- [UX-NNN] **Title** — Description. File: `path:line`. What's wrong and suggested fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-FRONTEND-UX.md` exists in the worktree root
- File contains all four severity sections
- Every finding has a `[UX-NNN]` ID, file reference, and effort tag
- Summary counts match actual findings
