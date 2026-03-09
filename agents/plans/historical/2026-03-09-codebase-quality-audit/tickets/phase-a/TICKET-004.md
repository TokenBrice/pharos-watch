---
title: "Add missing SEO metadata and accessibility fixes to frontend"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Fix SEO gaps (missing homepage metadata, incomplete sitemap) and accessibility issues (missing alt text, unlabeled hydration placeholder). All changes are additive — no existing behavior modified.

## Context

**Research findings addressed:**
- R3 Finding I1: Homepage lacks page-level metadata
- R3 Finding I2: Sitemap omits key public routes
- R3 Finding I5: Sidebar brand image missing alt text
- R3 Finding M1: Theme toggle placeholder renders unlabeled button during hydration

## Task

### 1. Add homepage metadata

In `src/app/page.tsx`, add a `metadata` export with homepage-specific title, description, and Open Graph tags. Follow the pattern used by other pages (e.g., `src/app/about/page.tsx` or `src/app/depeg/page.tsx`). Use a title like "Pharos - Stablecoin Analytics Dashboard" and description summarizing what Pharos does.

### 2. Add missing routes to sitemap

In `src/app/sitemap.ts`, add the following routes to the `staticPages` array (or equivalent):
- `/portfolio/`
- `/telegram/`

Also verify that `/stablecoins/backing/*` and `/stablecoins/governance/*` taxonomy pages are covered by the dynamic sitemap generation. If not, add them.

### 3. Fix sidebar brand alt text

In `src/components/sidebar.tsx` (~line 211-219), the `<Image>` component for the brand logo has `alt=""`. Change to `alt="Pharos"` since the image is part of a functional link (home navigation), not decorative.

### 4. Fix theme toggle hydration placeholder

In `src/components/theme-toggle.tsx` (~line 15-17), the placeholder button rendered while waiting for `mounted` state lacks accessible text. Add a `<span className="sr-only">Toggle theme</span>` inside the placeholder button, or add `aria-label="Toggle theme"` to the button element.

## Files Modified

- `src/app/page.tsx`
- `src/app/sitemap.ts`
- `src/components/sidebar.tsx`
- `src/components/theme-toggle.tsx`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -A5 'export const metadata' src/app/page.tsx` shows metadata with title and description
- `grep 'portfolio' src/app/sitemap.ts` shows the route is included
- `grep 'telegram' src/app/sitemap.ts` shows the route is included
- `grep "alt=" src/components/sidebar.tsx | grep -i pharos` shows non-empty alt text
- `grep -i 'aria-label\|sr-only' src/components/theme-toggle.tsx` shows accessible label on placeholder
