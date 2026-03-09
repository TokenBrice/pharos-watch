---
title: "Audit UI/UX quality: responsive design, accessibility, loading/error/empty states, interaction quality"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every UI/UX quality issue detectable through code analysis — focused on responsive design gaps, accessibility deficiencies, missing loading/error/empty states, and interaction quality problems.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos is a dark-first financial dashboard targeting crypto/DeFi practitioners who value density, precision, and speed-to-insight. The stack is Next.js 16 (static export), React 19, Tailwind CSS v4, shadcn/ui.

**Scope:** All pages in `src/app/`, all components in `src/components/` (excluding `src/components/ui/`).

**Design principles** (from CLAUDE.md — findings should reference violations of these):
1. Data density over decoration
2. Calm authority, not loud urgency
3. Precision as personality (monospace numbers, exact percentages, named bands)
4. Semantic color only (color communicates state, never decoration)
5. DeFi-native, not corporate

**Note:** This audit is code-analysis only. Visual regression testing and pixel-level review require separate browser-based inspection.

## Task

### 1. Responsive Design

Audit every page and major component for mobile/tablet readiness:

- **Missing responsive classes:** Components using fixed widths, `hidden` without responsive breakpoint variants, layouts that won't reflow on narrow screens.
- **Overflow issues:** Horizontal scrolling risks — tables without `overflow-x-auto`, long numbers/addresses without truncation, flex containers without `flex-wrap`.
- **Touch targets:** Interactive elements (buttons, links, toggles) smaller than 44x44px equivalent on mobile.
- **Breakpoint coverage:** Check if major layouts use `sm:`, `md:`, `lg:` breakpoints. Flag layouts that are desktop-only.
- **Navigation:** Is the mobile navigation usable? Does the nav collapse appropriately?

### 2. Accessibility (a11y)

Audit for WCAG 2.1 AA compliance through code analysis:

- **Missing ARIA:** Interactive elements without `aria-label`, `aria-describedby`, or accessible names. Chart components without `aria-label` or `role="img"`.
- **Missing alt text:** Images without `alt` attributes.
- **Keyboard navigation:** Interactive elements that are only mouse-accessible (`onClick` on divs without `role="button"` and `tabIndex`). Missing focus styles.
- **Heading hierarchy:** Pages skipping heading levels (h1 → h3 without h2). Multiple h1 tags on one page.
- **Color contrast concerns:** Text styled with colors that may have insufficient contrast (check Tailwind color classes against dark/light backgrounds). Note: code analysis can flag likely issues; actual contrast ratios need visual verification.
- **Focus management:** Modals/dialogs without focus trap. Missing `aria-expanded`, `aria-controls` on expandable sections.
- **Screen reader support:** Decorative elements not hidden from screen readers (`aria-hidden`). Data-only content without text alternatives.
- **Form labels:** Form inputs without associated labels or `aria-label`.

### 3. Loading States

For every data-dependent component/page:

- **Missing skeletons:** Components that show nothing (blank space) while data loads instead of a skeleton or loading indicator.
- **Inconsistent loading patterns:** Some components use skeletons, others use spinners, others show nothing — flag inconsistencies.
- **Loading indicator placement:** Loading indicators that don't match the size/shape of the content they replace (layout shift risk).
- **Suspense boundaries:** Pages or sections missing React Suspense boundaries where they'd prevent waterfall loading.

### 4. Error States

For every data-dependent component/page:

- **Missing error boundaries:** Pages or major sections without error boundary wrappers. A single failing API call shouldn't crash the entire page.
- **Missing error UI:** Components that swallow errors silently (catch without user feedback). Hooks that return `error` but the consuming component doesn't render an error state.
- **Retry mechanisms:** Error states without a "retry" action when the error is transient (network, API timeout).
- **Error message quality:** User-facing error messages that expose technical details (stack traces, raw API errors) instead of human-readable descriptions.

### 5. Empty States

For every component that renders a list, table, or data collection:

- **Missing empty states:** Components that render an empty table/list body or nothing when data is `[]` or `null`, without a "no data" message or illustration.
- **Null/undefined display:** Components that render `undefined`, `NaN`, `null`, or blank cells when data fields are missing, instead of a dash, "N/A", or appropriate fallback.
- **Zero-data scenarios:** What happens when a stablecoin has no history, no liquidity data, no depeg events? Does each page handle the zero-data case gracefully?

### 6. Interaction Quality

- **Missing hover/focus states:** Interactive elements (cards, rows, links) without visual hover feedback.
- **Missing disabled states:** Buttons/controls that should be disabled in certain conditions but aren't.
- **Missing transition/animation:** State changes (expand/collapse, tab switch, tooltip show) that happen instantly without transition, causing jarring UX.
- **Inconsistent click targets:** Clickable cards where only the title is the link vs. the entire card being clickable. Inconsistent patterns across similar components.
- **Scroll behavior:** Long pages without scroll-to-top affordance. Anchored sections without smooth scroll. Tables that scroll but have no scroll indicator.

### 7. Content Handling

- **Text overflow:** Long stablecoin names, chain names, or addresses without `truncate` or `text-ellipsis`. Long numbers without formatting.
- **Dynamic content sizing:** Components that break when content is longer/shorter than expected.
- **Number formatting consistency:** Some numbers with commas, some without. Some percentages with 2 decimals, some with 4. Inconsistent formatting across similar values.
- **Date/time formatting:** Inconsistent date formats across pages. Missing timezone context. Relative time ("2h ago") vs absolute time inconsistency.

### 8. SEO & Discoverability

For a public-facing dashboard, discoverability matters:

- **Page metadata completeness:** Check every page in `src/app/` for proper `metadata` export (title, description, Open Graph tags). Flag pages missing metadata.
- **Sitemap coverage:** Compare pages listed in the sitemap (`src/app/sitemap.ts`) against actual routes. Flag missing pages.
- **Canonical URLs:** Check for consistent canonical URL patterns across pages.
- **Structured data:** Check for JSON-LD usage (`breadcrumb-json-ld.tsx` or similar). Are all relevant pages covered?
- **Security headers:** Review `_headers` or `public/_headers` for CSP, X-Frame-Options, etc. Flag overly permissive policies (e.g., `unsafe-inline` in CSP).

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R3: UI/UX Quality Audit Report

## Summary
- Pages audited: N
- Components audited: N
- Findings by severity: N critical, N important, N minor
- Findings by category: N responsive, N a11y, N loading, N error, N empty, N interaction, N content, N SEO

## Critical Findings (high user impact — broken or inaccessible)

### Finding C1: [Short description]
- **Category:** [Responsive | Accessibility | Loading State | Error State | Empty State | Interaction | Content | SEO]
- **Files:** `path:line` — `path:line`
- **Pages affected:** [which routes are impacted]
- **Description:** [What the issue is and how it affects users]
- **Suggested fix:** [Concrete description]
- **Effort:** [Low | Medium | High]
- **Risk:** [Low — additive change | Medium — modifies existing behavior]

## Important Findings (degraded experience — noticeable but not blocking)
### Finding I1: ...

## Minor Findings (polish — nice to have)
### Finding M1: ...

## Responsive Design Coverage Matrix
| Page | Mobile | Tablet | Desktop | Issues |
|------|--------|--------|---------|--------|
| / (homepage) | [OK | Partial | None] | ... | ... |
| /stablecoin/[id] | ... | ... | ... | ... |
| ... | ... | ... | ... | ... |

## Accessibility Checklist
| Criterion | Status | Notes |
|-----------|--------|-------|
| All interactive elements keyboard-accessible | [Pass | Fail | Partial] | ... |
| All images have alt text | ... | ... |
| Heading hierarchy valid on all pages | ... | ... |
| ARIA labels on charts and data viz | ... | ... |
| Focus trapping in modals | ... | ... |
| Form inputs labeled | ... | ... |

## Loading/Error/Empty State Coverage
| Component/Page | Loading state | Error state | Empty state |
|---------------|---------------|-------------|-------------|
| [component] | [Skeleton | Spinner | None] | [Boundary | Inline | None] | [Message | None] |
| ... | ... | ... | ... |
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all pages in `src/app/` and all components in `src/components/` (except `ui/`)
- Every finding has exact `file:line` references
- Every finding has an effort estimate (Low/Medium/High) and risk level
- Responsive coverage matrix covers all pages
- Accessibility checklist covers WCAG 2.1 AA criteria
- Loading/error/empty state coverage table is complete
- No code changes were made (read-only audit)
