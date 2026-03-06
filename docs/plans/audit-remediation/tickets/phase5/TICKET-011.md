---
title: "Fix SEO metadata gaps and accessibility semantics"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "high"
done: false
---

## Goal

Fix 6 findings: add og:image to 12 route templates, add og:type across routes, fix status page social metadata, convert command palette to dialog, add accessible labels to forms, and fix homepage h1 on mobile.

## Context

- The shared metadata helper is at `src/lib/page-metadata.ts` — `buildPageMetadata()` function
- The site's OG image is at `/og-card.png` (1200×628)
- The command palette at `src/components/command-palette.tsx` uses a `<div>` overlay with `createPortal()`
- The site uses shadcn/ui components — check if a Dialog primitive exists in `src/components/ui/`

## Task

### Step 1: SEO-001 — Add `og:image` to all route templates

The following route templates are missing `openGraph.images` in their metadata:

1. `src/app/about/page.tsx`
2. `src/app/privacy/page.tsx`
3. `src/app/methodology/changelog-page-utils.ts`
4. `src/app/stablecoin/[id]/page.tsx`
5. `src/app/stablecoins/[peg]/page.tsx`
6. `src/app/digest/[date]/page.tsx`

For each, add to the metadata export:
```typescript
openGraph: {
  // ... existing fields
  images: [{ url: "/og-card.png", width: 1200, height: 628 }],
},
```

Check if `buildPageMetadata()` in `src/lib/page-metadata.ts` already supports an `ogImage` parameter. If so, pass it. If not, add a default:
```typescript
// In buildPageMetadata, add default og:image if not provided
openGraph: {
  ...base,
  images: ogImage ? [{ url: ogImage, width: ogWidth, height: ogHeight }] : [{ url: "/og-card.png", width: 1200, height: 628 }],
}
```

Then pages that call `buildPageMetadata()` automatically get the default OG image. Pages that DON'T use the helper should have the image added manually.

Also add og:image to any other pages in `src/app/*/page.tsx` that export metadata without it. Check all page.tsx files.

### Step 2: SEO-002 — Add `og:type` to routes

In `src/lib/page-metadata.ts`, if `buildPageMetadata()` doesn't set `openGraph.type`, add:
```typescript
openGraph: {
  type: "website",
  // ... rest
}
```

For pages that use `generateMetadata()` instead (like `src/app/stablecoin/[id]/page.tsx`), add `type: "website"` (or `"article"` for content pages like methodology/digest).

### Step 3: SEO-003 — Fix status page social metadata

In `src/app/status/page.tsx`:

Add route-specific OG/Twitter metadata instead of inheriting homepage defaults:
```typescript
export const metadata: Metadata = {
  title: "System Status | Pharos",
  description: "Pharos system health, cron job status, and data freshness.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "System Status | Pharos",
    description: "Pharos system health dashboard.",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};
```

### Step 4: A11Y-001 — Convert command palette to dialog

In `src/components/command-palette.tsx` (line ~262):

1. Check if `src/components/ui/dialog.tsx` exists (shadcn Dialog primitive).
2. If it exists, refactor the command palette to use the Dialog component, which provides proper focus trapping, escape handling, and ARIA semantics.
3. If not, convert the `<div>` overlay to use the native `<dialog>` element:
```tsx
<dialog
  ref={dialogRef}
  className="..."
  onClose={handleClose}
>
  {/* existing content */}
</dialog>
```
And open it with `dialogRef.current?.showModal()`.

4. The key requirements:
   - `role="dialog"` or `<dialog>` element
   - `aria-modal="true"`
   - Focus trapped inside the dialog (Tab cycles within)
   - Escape key closes it
   - Focus returns to trigger element on close

5. **Do not break existing keyboard shortcuts.** The command palette has combobox/listbox ARIA — these should be preserved inside the dialog wrapper.

### Step 5: A11Y-002 — Add accessible labels to form controls

1. **`src/components/status/admin-key-form.tsx`** (line ~41):
Add `aria-label="Admin key"` to the input:
```tsx
<input aria-label="Admin key" placeholder="Admin key" ... />
```

2. **`src/components/digest-archive-client.tsx`** (line ~124):
Add `aria-label="Filter by month"` to the select:
```tsx
<select aria-label="Filter by month" ... >
```

3. **`src/components/coin-selector.tsx`** (line ~169):
Add `aria-label="Search coins"` to the search input:
```tsx
<input aria-label="Search coins" placeholder="Search by name or symbol..." ... />
```

### Step 6: A11Y-006 — Homepage h1 on all viewports

In `src/app/page.tsx` and `src/components/site-header.tsx`:

The `<h1>` in `SiteHeader` is inside a container with `hidden lg:flex`, making it invisible on mobile.

Fix option A: Add a visually-hidden h1 to the homepage for small viewports:
```tsx
// In src/app/page.tsx, at the top of the page content:
<h1 className="sr-only">Pharos — Stablecoin Analytics Dashboard</h1>
```

Fix option B: Make the existing h1 in SiteHeader visible at all sizes (remove the `hidden` class from the container, adjust mobile layout).

**Recommended: Option A** — simplest, doesn't affect layout. The `sr-only` class (from Tailwind) makes it accessible to screen readers without visual disruption.

## Acceptance Criteria

1. `npm run build` passes
2. `npm run lint` passes
3. Verify og:image: `grep -rn "og-card.png" src/app/` should show entries for all page templates
4. Verify og:type: `grep -rn "type.*website\|type.*article" src/app/ src/lib/page-metadata.ts`
5. Command palette uses `<dialog>` element or shadcn Dialog wrapper
6. All 3 form controls have `aria-label` attributes
7. Homepage has an `<h1>` accessible on all viewports
