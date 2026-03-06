---
title: "Audit frontend accessibility"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all frontend pages and components for accessibility (a11y) compliance. Produce `FINDINGS-ACCESSIBILITY.md` in the worktree root.

## Task

### Scope

All files in `src/app/` (27 pages) and `src/components/` (excluding `src/components/ui/` — shadcn primitives are assumed compliant).

**Note:** TICKET-002 (Frontend UI/UX) audits the same files from a UX perspective. Focus here on accessibility-specific issues (ARIA, keyboard, contrast, screen readers). If a component has both a UX issue and an accessibility issue, report only the accessibility aspect here — the UX aspect belongs in TICKET-002's findings.

### What to check

1. **ARIA attributes**:
   - Interactive elements (buttons, links, toggles) have accessible labels (`aria-label`, `aria-labelledby`, or visible text content)
   - Dynamic content areas use `aria-live` regions for screen reader announcements
   - Modal/dialog components use `role="dialog"` and `aria-modal="true"`
   - Tab components use proper `role="tablist"`, `role="tab"`, `role="tabpanel"` structure
   - Expandable sections use `aria-expanded`

2. **Keyboard navigation**:
   - All interactive elements are reachable via Tab key (no `tabIndex="-1"` on interactive elements unless intentional)
   - Custom click handlers on non-button elements (`<div onClick>`, `<span onClick>`) — these need `role="button"`, `tabIndex="0"`, and `onKeyDown` handlers
   - Dropdown menus and modals trap focus appropriately
   - Escape key dismisses modals/popups

3. **Heading hierarchy**:
   - Each page has exactly one `<h1>`
   - Heading levels don't skip (e.g., `<h1>` followed by `<h3>` with no `<h2>`)
   - Heading text is descriptive (not empty or generic like "Data")

4. **Form inputs**:
   - Every `<input>`, `<select>`, `<textarea>` has an associated `<label>` (via `htmlFor` or wrapping)
   - Search inputs have `type="search"` and accessible label
   - Error messages are associated with inputs via `aria-describedby`

5. **Images and icons**:
   - All `<img>` elements have `alt` attributes (empty `alt=""` is OK for decorative images)
   - Icon-only buttons have `aria-label` or `sr-only` text
   - SVG icons used inline have `aria-hidden="true"` when decorative

6. **Color and contrast**:
   - Information is not conveyed by color alone (e.g., status indicators should also have text labels or icons)
   - Check for low-contrast text patterns: light gray on white, dark gray on dark backgrounds
   - Charts and graphs — do they have non-color ways to distinguish data series (patterns, labels)?

7. **Tables**:
   - Data tables use `<table>`, `<thead>`, `<tbody>`, `<th>` with `scope` attributes
   - Tables have `aria-label` or `<caption>` describing the data
   - Sortable columns indicate sort state with `aria-sort`

8. **Skip navigation**: Check if there's a "skip to main content" link for keyboard users.

### Files to examine

- `src/app/**/page.tsx` (all 27 pages)
- `src/app/layout.tsx` (skip nav, landmark roles)
- `src/components/**/*.tsx` (exclude `src/components/ui/`)

### Output format

Write `FINDINGS-ACCESSIBILITY.md` in the worktree root:

```markdown
# FINDINGS: Accessibility

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
- [A11Y-NNN] **Title** — Description. File: `path:line`. WCAG criterion violated (e.g., 1.1.1 Non-text Content). Suggested fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-ACCESSIBILITY.md` exists in the worktree root
- File contains all four severity sections
- Every finding has an `[A11Y-NNN]` ID, file reference, WCAG reference where applicable, and effort tag
- Summary counts match actual findings
