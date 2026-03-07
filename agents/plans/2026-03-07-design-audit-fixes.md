# Design Audit Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 24 design audit issues identified in the comprehensive website design audit, organized into 6 batches by impeccable command type.

**Architecture:** Each batch corresponds to one impeccable command category (`/normalize`, `/harden`, `/optimize`, `/adapt`, `/bolder`, `/polish`). Tasks within each batch are independent edits to specific files. Build verification runs after each batch.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind CSS v4, OKLch design tokens, Recharts, shadcn/ui

**Key references:**
- `docs/design-tokens.md` — 3-layer token architecture
- `docs/design-language.md` — Live UI baseline
- `src/styles/tokens/primitives.css` — Raw color scales
- `src/styles/tokens/semantic.css` — Semantic + component tokens
- `src/app/globals.css` — Bridge layer + utilities
- `src/lib/chart-colors.ts` — JS chart color token map

---

## Batch 1: `/normalize` — Token & Theming Consistency

**Fixes:** C1, H2, M3, M9, M10, L2 (6 issues, 9 files)

### Task 1.1: Fix MELTDOWN band dark mode visibility (C1)

**Files:**
- Modify: `src/app/stability-index/client.tsx:453`

**Step 1: Fix the class**

Change line 453 from:
```tsx
<td className="py-2 pr-4 font-medium text-red-800">MELTDOWN</td>
```
to:
```tsx
<td className="py-2 pr-4 font-medium text-red-800 dark:text-red-300">MELTDOWN</td>
```

This follows the project's `text-*-700 dark:text-*-400` pattern (using 800/300 for extra emphasis on the most critical band, matching CRISIS at 700/400).

**Step 2: Verify no other missing dark variants in the same table**

Search the same file for `text-*-800` or `text-*-900` without a `dark:` companion. Fix any found the same way.

### Task 1.2: Migrate scroll-shadow `rgba()` to theme-aware values (H2 partial)

**Files:**
- Modify: `src/app/globals.css:239-245`

**Step 1: Add a dark-mode scroll-shadow variant**

Current code uses `rgba(0,0,0,.15)` for both themes. Replace the `.scroll-shadow` utility:

```css
.scroll-shadow {
  background:
    linear-gradient(to right, var(--background) 30%, transparent) left center,
    linear-gradient(to left, var(--background) 30%, transparent) right center,
    radial-gradient(farthest-side at 0 50%, oklch(0 0 0 / 0.15), transparent) left center,
    radial-gradient(farthest-side at 100% 50%, oklch(0 0 0 / 0.15), transparent) right center;
  background-repeat: no-repeat;
  background-size: 40px 100%, 40px 100%, 14px 100%, 14px 100%;
  background-attachment: local, local, scroll, scroll;
}
.dark .scroll-shadow {
  background:
    linear-gradient(to right, var(--background) 30%, transparent) left center,
    linear-gradient(to left, var(--background) 30%, transparent) right center,
    radial-gradient(farthest-side at 0 50%, oklch(1 0 0 / 0.12), transparent) left center,
    radial-gradient(farthest-side at 100% 50%, oklch(1 0 0 / 0.12), transparent) right center;
  background-repeat: no-repeat;
  background-size: 40px 100%, 40px 100%, 14px 100%, 14px 100%;
  background-attachment: local, local, scroll, scroll;
}
```

### Task 1.3: Migrate DEWS radar `rgba()` to `oklch()` in semantic tokens (L2)

**Files:**
- Modify: `src/styles/tokens/semantic.css:164-169`

**Step 1: Replace dark-mode DEWS radar values**

Change:
```css
--dews-radar-spoke:              rgba(255, 255, 255, 0.12);
--dews-radar-calm-boundary:      rgba(255, 255, 255, 0.16);
--dews-radar-calm-dot-bloom:     rgba(255, 255, 255, 0.06);
--dews-radar-calm-dot-core:      rgba(255, 255, 255, 0.28);
```
to:
```css
--dews-radar-spoke:              oklch(1 0 0 / 0.12);
--dews-radar-calm-boundary:      oklch(1 0 0 / 0.16);
--dews-radar-calm-dot-bloom:     oklch(1 0 0 / 0.06);
--dews-radar-calm-dot-core:      oklch(1 0 0 / 0.28);
```

These are perceptually equivalent but keep the token file consistent with the OKLch convention used everywhere else.

### Task 1.4: Import chart colors from centralized token map (M9)

**Files:**
- Modify: `src/app/stability-index/client.tsx:1-47`

**Step 1: Add imports from chart-colors**

Add to the import block:
```tsx
import { CHART_BLUE, CHART_GREEN } from "@/lib/chart-colors";
```

**Step 2: Replace hardcoded COMPONENT_COLORS**

The `TOKEN` map in `chart-colors.ts` already has all needed values. Check if `CHART_ORANGE` and `CHART_CYAN` exports exist; if not, add them to `chart-colors.ts`:

```tsx
// In src/lib/chart-colors.ts, after existing exports:
export const CHART_ORANGE = TOKEN.orange;
export const CHART_CYAN   = TOKEN.cyan;
```

Then in `stability-index/client.tsx`, replace:
```tsx
const COMPONENT_COLORS = {
  severity: "#f97316",
  breadth: "#3b82f6",
  stressBreadth: "#06b6d4",
  trend: "#22c55e",
};
```
with:
```tsx
import { CHART_BLUE, CHART_GREEN, CHART_ORANGE, CHART_CYAN } from "@/lib/chart-colors";

const COMPONENT_COLORS = {
  severity: CHART_ORANGE,
  breadth: CHART_BLUE,
  stressBreadth: CHART_CYAN,
  trend: CHART_GREEN,
};
```

### Task 1.5: Fix portfolio badge dark mode styling (M3)

**Files:**
- Modify: `src/app/portfolio/client.tsx`

**Step 1: Find amber warning banners**

Search for `border-amber-500/20 bg-amber-500/5` in the file. For each occurrence, add dark mode companions:

Change:
```
border-amber-500/20 bg-amber-500/5
```
to:
```
border-amber-500/20 dark:border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10
```

This ensures the warning badge border remains visible on dark backgrounds.

### Task 1.6: Create sidebar width component tokens (M10)

**Files:**
- Modify: `src/styles/tokens/semantic.css` (both `:root` and `.dark` blocks)
- Modify: `src/components/sidebar.tsx:77, 157`

**Step 1: Add component tokens**

In `semantic.css`, add under the `/* Component: Sidebar */` section in both `:root` and `.dark`:
```css
--sidebar-width-expanded: 220px;
--sidebar-width-collapsed: 56px;
```

**Step 2: Use tokens in sidebar**

In `sidebar.tsx`, replace the SidebarSpacer width:
```tsx
// Line 77 — change:
className={`hidden md:block shrink-0 transition-all duration-200 ${pinned ? "w-[220px]" : "w-14"}`}
// to:
className={`hidden md:block shrink-0 transition-all duration-200 ${pinned ? "w-[var(--sidebar-width-expanded)]" : "w-[var(--sidebar-width-collapsed)]"}`}
```

In the `<aside>` at line 157, change:
```tsx
style={{ width: expanded ? 220 : 56 }}
// to:
style={{ width: expanded ? "var(--sidebar-width-expanded)" : "var(--sidebar-width-collapsed)" }}
```

Note: The inline `style` approach is needed here because the width drives the CSS transition. Verify the transition still works after this change.

### Task 1.7: Document flow-machine-scene and cemetery-tombstones as dark-only (H2 partial)

**Files:**
- Modify: `src/components/flow-machine-scene.tsx` (add comment at top)
- Modify: `src/components/cemetery-tombstones.tsx` (add comment at top)

These components use raw `rgba()` and dark-palette colors intentionally for artistic effect. Rather than migrating every value (which would lose the visual intent), document this:

**Step 1: Add dark-only annotation**

Add a comment after the imports in each file:
```tsx
/**
 * Visual note: This component uses hardcoded dark-palette colors (slate, rgba shadows)
 * for artistic effect. It renders on dark surfaces only and does not adapt to light mode.
 * See design audit 2026-03-07 for rationale.
 */
```

**Step 2: Verify wrapping context**

Confirm that these components are rendered inside dark-surfaced containers. If any render on light backgrounds, wrap with a dark container or migrate colors.

### Task 1.8: Batch 1 verification

**Step 1: Build and lint**

```bash
npm run build && npm run lint
```

Expected: Clean build, no new lint errors.

**Step 2: Commit**

```bash
git add -A
git commit -m "fix: normalize token consistency and dark mode theming

- Fix MELTDOWN band invisible text in dark mode (C1)
- Migrate scroll-shadow rgba to theme-aware oklch (H2)
- Migrate DEWS radar rgba tokens to oklch (L2)
- Import chart colors from centralized token map (M9)
- Fix portfolio badge dark mode border/bg visibility (M3)
- Create sidebar width component tokens (M10)
- Document flow-machine/cemetery as dark-only components (H2)"
```

---

## Batch 2: `/harden` — Accessibility & Resilience

**Fixes:** H3, H4, M1, M2, M4, M5, M8 (7 issues, 12 files)

### Task 2.1: Add `aria-live` to dynamic status components (M1)

**Files:**
- Modify: `src/components/query-error-notice.tsx:44`
- Modify: `src/components/data-health-banner.tsx:57-58`

**Step 1: QueryErrorNotice**

Add `aria-live="polite"` and `role="status"` to the outer div (line 44):
```tsx
<div role="status" aria-live="polite" className={`rounded-lg border px-4 py-3 text-sm leading-relaxed shadow-sm ${toneClass}`}>
```

**Step 2: DataHealthBanner**

Add `aria-live="polite"` and `role="status"` to the outer div (line 58):
```tsx
<div role="status" aria-live="polite" className={`rounded-lg border px-4 py-2.5 text-sm leading-relaxed shadow-sm ${STATE_STYLES[merged.state]}`}>
```

Note: `StaleDataBanner` delegates to `DataHealthBanner`, so fixing the latter covers both.

### Task 2.2: Replace `title` with `aria-label` on icon-only buttons (M2)

**Files:**
- Modify: `src/components/sidebar.tsx:88, 121-122, 179, 233`
- Modify: `src/components/psi-history-chart.tsx:181`

**Step 1: Sidebar buttons**

In `SidebarNavItem` (line 88), the `title` is used when collapsed. Keep `title` for tooltip but add `aria-label`:
```tsx
title={expanded ? undefined : item.label}
aria-label={item.label}
```

In `ThemeSidebarItem` (line 121-122), same pattern:
```tsx
title={expanded ? undefined : label}
aria-label={label}
```

In Search button (line 179):
```tsx
title={expanded ? undefined : "Search (Ctrl+K)"}
aria-label="Search (Ctrl+K)"
```

In pin/unpin button (line 233):
```tsx
title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
```

**Step 2: PSI chart export button**

In `psi-history-chart.tsx:181`, add `aria-label`:
```tsx
<Button variant="ghost" size="icon-sm" className="shrink-0" onClick={handlePngExport} title="Save chart as PNG" aria-label="Save chart as PNG">
```

### Task 2.3: Fix footer contrast (M4)

**Files:**
- Modify: `src/components/footer.tsx:63`

**Step 1: Remove `/60` opacity from disclaimer**

Change:
```tsx
<p className="text-center text-xs text-muted-foreground/60">
```
to:
```tsx
<p className="text-center text-xs text-tertiary">
```

This uses the `--text-tertiary` token which is already calibrated for minimum readability in both themes. If `text-tertiary` is not available as a Tailwind utility, use `text-muted-foreground` instead.

Verify: `text-tertiary` maps to `var(--text-tertiary)`. If Tailwind doesn't generate this class (it's not in the `@theme inline` block in globals.css), add it:

```css
/* In globals.css @theme inline block: */
--color-tertiary: var(--text-tertiary);
```

Or simply use the safe fallback:
```tsx
<p className="text-center text-xs text-muted-foreground">
```

### Task 2.4: Add `min-h-11` touch targets to footer links (H4)

**Files:**
- Modify: `src/components/footer.tsx:10-18, 39-48, 52-61`

**Step 1: Footer nav links — add mobile touch target**

For each footer `<Link>` in the main nav (lines 10-18), change:
```tsx
className="pharos-focus-ring rounded-md px-1.5 py-1 hover:text-foreground"
```
to:
```tsx
className="pharos-focus-ring rounded-md px-1.5 py-1 min-h-11 inline-flex items-center sm:min-h-0 hover:text-foreground"
```

Apply the same pattern to category browse links (lines 44 and 57).

**Step 2: Hero card "Report data issue" button**

In `src/components/stablecoin-detail/hero-card.tsx:153-159`, change:
```tsx
className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
```
to:
```tsx
className="mt-2 flex items-center gap-1.5 min-h-11 sm:min-h-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
```

### Task 2.5: Fix methodology heading hierarchy (M5)

**Files:**
- Modify: `src/app/methodology/page.tsx`

**Step 1: Identify the structure**

The page has `h1` (line 167: "Methodology"), then `CardTitle as="h2"` for each section (line 186, 215, etc.), then `h3` for subsections (line 248, 274, etc.).

Verify: If `CardTitle as="h2"` renders an actual `<h2>`, the hierarchy is `h1 → h2 → h3` which is correct. Read the `CardTitle` component to verify.

**Step 2: If hierarchy is already correct, skip**

If `CardTitle as="h2"` does produce `<h2>` elements, the hierarchy is fine. Mark this as verified, no changes needed.

If `CardTitle` ignores the `as` prop or defaults to a non-heading element, fix by replacing with explicit `<h2>` tags.

### Task 2.6: Add `prefers-reduced-motion` check to JS-animated components (M8)

**Files:**
- Modify: `src/components/flow-machine-scene.tsx`
- Modify: `src/components/contagion-graph.tsx`

**Step 1: Create a shared hook (or use inline)**

Add at the top of each component:
```tsx
const prefersReducedMotion = typeof window !== "undefined"
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;
```

**Step 2: In flow-machine-scene**

Use the flag to reduce or disable intensity-driven animations:
```tsx
const effectiveIntensity = prefersReducedMotion ? 0 : intensity;
```

Then use `effectiveIntensity` instead of `intensity` for all animation calculations (sheet count, strip count, bill count). This stops the money-printing animation while keeping the static visual.

**Step 3: In contagion-graph**

The D3 force simulation runs physics. When reduced motion is preferred, skip the simulation tick animation and just show the final positions:
```tsx
// Inside the simulation setup useEffect:
if (prefersReducedMotion) {
  sim.stop();
  // Run simulation to completion synchronously
  for (let i = 0; i < 300; i++) sim.tick();
  // Set final positions without animation
  // ...update positions map...
}
```

### Task 2.7: Add keyboard navigation to contagion graph (H3)

**Files:**
- Modify: `src/components/contagion-graph.tsx`

**Step 1: Add keyboard support to nodes**

This is the most complex fix. The graph nodes need:
1. `tabIndex={0}` on the group element wrapping each node
2. Arrow key handling to move focus between connected nodes
3. Enter/Space to select a node (equivalent to click)

Add a `handleKeyDown` callback:
```tsx
const handleNodeKeyDown = useCallback((e: React.KeyboardEvent, nodeId: string) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setHoveredId((prev) => prev === nodeId ? null : nodeId);
  }
  // Arrow keys: move to connected nodes
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const connected = links
      .filter((l) => l.srcId === nodeId || l.tgtId === nodeId)
      .map((l) => l.srcId === nodeId ? l.tgtId : l.srcId);
    if (connected.length === 0) return;
    // Find current focused index and move to next/prev
    const currentIdx = connected.indexOf(hoveredId ?? "");
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const nextIdx = (currentIdx + dir + connected.length) % connected.length;
    const nextId = connected[nextIdx];
    setHoveredId(nextId);
    // Move focus to that node's SVG group
    const el = document.querySelector(`[data-node-id="${nextId}"]`) as HTMLElement;
    el?.focus();
  }
}, [links, hoveredId]);
```

On each node `<g>` element:
```tsx
<g
  data-node-id={node.id}
  tabIndex={0}
  role="button"
  aria-label={`${node.label}: ${node.type} stablecoin`}
  onKeyDown={(e) => handleNodeKeyDown(e, node.id)}
  onFocus={() => setHoveredId(node.id)}
  onBlur={() => setHoveredId(null)}
  // ... existing mouse handlers
>
```

Add focus styles via CSS:
```css
/* In globals.css or inline */
[data-node-id]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
```

**Step 2: Verify with keyboard**

Tab into the graph, use arrow keys to navigate between nodes, press Enter to select. Verify the tooltip/detail appears.

### Task 2.8: Batch 2 verification

**Step 1: Build and lint**

```bash
npm run build && npm run lint && npm test
```

**Step 2: Commit**

```bash
git add -A
git commit -m "fix: harden accessibility across dashboard

- Add aria-live to dynamic status banners (M1)
- Replace title with aria-label on icon-only buttons (M2)
- Fix footer disclaimer contrast (M4)
- Add min-h-11 touch targets to footer/hero links (H4)
- Fix methodology heading hierarchy (M5)
- Add prefers-reduced-motion to JS animations (M8)
- Add keyboard navigation to contagion graph (H3)"
```

---

## Batch 3: `/optimize` — Performance

**Fixes:** H1, M6 (2 issues, 2 files)

### Task 3.1: Remove `unoptimized` flag from stablecoin logos (H1)

**Files:**
- Modify: `src/components/stablecoin-logo.tsx:33`

**Step 1: Check next.config for remotePatterns**

Read `next.config.ts` (or `.js`/`.mjs`) and check if logo image domains are configured. Logos typically come from the API at `api.pharos.watch` or are bundled locally.

**Step 2: Remove the flag**

If logos are local or the remote domain is configured, simply remove `unoptimized` from line 33:
```tsx
<Image
  src={src}
  alt={`${name} logo`}
  width={size}
  height={size}
  className="flex-shrink-0 rounded-full"
  loading="lazy"
/>
```

If logos come from an external domain not in remotePatterns, add it:
```tsx
// In next.config.ts:
images: {
  remotePatterns: [
    { protocol: "https", hostname: "icons.llama.fi" },
    // ... other logo sources
  ],
},
```

**Step 3: Verify images still render**

Run `npm run dev`, navigate to homepage, confirm logos render. Check for any console errors about unoptimized images.

**Important caveat:** If this is a static export (`output: "export"` in next.config), Next.js image optimization is disabled at build time anyway and `unoptimized` is required. In that case, mark this issue as N/A and skip.

### Task 3.2: Memoize flow-machine-scene dimension calculations (M6)

**Files:**
- Modify: `src/components/flow-machine-scene.tsx`

**Step 1: Identify the render-time calculations**

The component computes `sheetCount`, `billCount`, `stripCount` and creates `Array.from({ length: N })` maps with complex style objects on every render (lines 388-426, 626-650, 729-745).

**Step 2: Memoize the sheet/bill/strip arrays**

Wrap each array generation in `useMemo`:
```tsx
const sheets = useMemo(() => {
  return Array.from({ length: sheetCount }).map((_, i) => {
    // ... existing calculation logic for seed, chaos, style, etc.
    return { key: i, className: ..., style: ... };
  });
}, [sheetCount, power, surgeBoost, stressFactor, dims, isMini, baseDuration, durationStep, delayStep, spreadPattern, spreadX, riseBase, riseStep]);
```

Then render:
```tsx
{sheets.map((sheet) => (
  <div key={sheet.key} className={sheet.className} style={sheet.style}>
    <Banknote className={cn(isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
  </div>
))}
```

Apply the same pattern to `billCount` and `stripCount` arrays.

**Step 3: Verify animation still works**

Run dev server, navigate to `/flows`, confirm the flow machine animation renders and responds to intensity changes.

### Task 3.3: Batch 3 verification

**Step 1: Build and test**

```bash
npm run build && npm run lint && npm test
```

**Step 2: Commit**

```bash
git add -A
git commit -m "perf: optimize image loading and flow machine rendering

- Remove unoptimized flag from stablecoin logos (H1)
- Memoize flow-machine-scene dimension calculations (M6)"
```

---

## Batch 4: `/adapt` — Responsive

**Fixes:** M11 (1 issue, 1 file)

### Task 4.1: Handle variable row heights in virtualized table (M11)

**Files:**
- Modify: `src/components/stablecoin-table.tsx`

**Step 1: Assess the approach**

The current `ROW_HEIGHT = 37` is a static estimate. TanStack Virtual supports dynamic row heights via `estimateSize` + `measureElement`. However, this adds complexity.

A simpler approach: increase `ROW_HEIGHT` to accommodate text wrap scenarios, and add `OVERSCAN` buffer:

```tsx
const ROW_HEIGHT = 40; // Slightly taller to accommodate minor text wrap
const OVERSCAN = 12;   // Increased from 10 for better coverage
```

This is the safer fix — dynamic measurement would require refactoring the virtualizer setup and could introduce jank.

**Step 2: Verify table rendering**

Run dev server, resize viewport to mobile width, verify no visible gaps or overlapping rows in the stablecoin table.

### Task 4.2: Batch 4 verification

```bash
npm run build && npm run lint
```

```bash
git add -A
git commit -m "fix: adjust virtualized table row height for text wrap tolerance (M11)"
```

---

## Batch 5: `/bolder` — Visual Variety

**Fixes:** M7 (1 issue, 1 file)

### Task 5.1: Add visual variety to feature highlights grid (M7)

**Files:**
- Modify: `src/components/feature-highlights.tsx`

**Step 1: Vary the layout**

Instead of 6 identical cards, make the first 2 cards span full width on mobile and show richer content. The remaining 4 stay as compact cards:

```tsx
{selected.map((f, i) => (
  <Link
    key={f.href}
    href={f.href}
    className={cn(
      "pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col gap-2 border-l-[3px] bg-gradient-to-b from-background/40 to-transparent p-4",
      f.borderClass,
      i < 2 && "col-span-2 lg:col-span-1", // First 2 span full width on mobile
    )}
  >
```

**Step 2: Alternative — add dynamic data previews**

If live data is available (e.g., current PSI score, active depeg count), inject it into the cards. This makes them information-bearing rather than static descriptions. However, this requires hooking into data queries which adds complexity. Skip for now unless the user requests it.

**Step 3: Verify layout**

Check at mobile (375px), tablet (768px), and desktop (1280px) widths. Confirm the grid doesn't break.

### Task 5.2: Batch 5 verification

```bash
npm run build && npm run lint
```

```bash
git add -A
git commit -m "style: add visual variety to feature highlights grid (M7)"
```

---

## Batch 6: `/polish` — Minor Fixes

**Fixes:** L1, L4, L5, L7, L8 (5 issues — L3/L6 are no-ops)

### Task 6.1: Differentiate duplicate footer aria-labels (L4)

**Files:**
- Modify: `src/components/footer.tsx:39, 52`

**Step 1: Make landmark names unique**

The mobile `<details>` nav (line 39) and desktop nav (line 52) both say `aria-label="Browse by category"`. Change the mobile one:
```tsx
// Line 39 — change:
<nav aria-label="Browse by category"
// to:
<nav aria-label="Browse stablecoins by category"
```

Leave the desktop one at line 52 unchanged.

### Task 6.2: Replace inline style sizing with Tailwind classes (L5)

**Files:**
- Modify: `src/components/stablecoin-detail/hero-card.tsx:100-101`

**Step 1: Replace inline style**

Change:
```tsx
<div
  className="flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground"
  style={{ width: 48, height: 48 }}
>
```
to:
```tsx
<div
  className="flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground w-12 h-12"
>
```

### Task 6.3: Extract skeleton loader constants (L7)

**Files:**
- Modify (representative, apply pattern across all): `src/components/stablecoin-table.tsx`, `src/components/blacklist-table.tsx`

**Step 1: Extract skeleton row indices to module-level constants**

For each file that uses `Array.from({ length: N }).map(...)` for skeletons, extract the array:

```tsx
// At module level:
const SKELETON_INDICES = Array.from({ length: 10 }, (_, i) => i);

// In render:
{SKELETON_INDICES.map((i) => (
  <TableRow key={i}>
    <TableCell colSpan={999}><Skeleton className="h-8 w-full" /></TableCell>
  </TableRow>
))}
```

Apply this pattern to all 7 files that use skeleton arrays:
- `src/components/stablecoin-table.tsx`
- `src/components/blacklist-table.tsx`
- `src/components/digest-archive-client.tsx`
- `src/components/category-stats.tsx`
- `src/components/flow-table.tsx` (if it exists)
- `src/components/market-highlights.tsx`
- `src/components/kpi-bar.tsx`

### Task 6.4: Document sidebar keyboard shortcut (L1)

**Files:**
- Modify: `src/components/sidebar.tsx`

**Step 1: Add a comment documenting the shortcut**

Above the `handleKeyDown` function (line 137):
```tsx
// Keyboard shortcut: [ and ] toggle sidebar pin state.
// Inputs/textareas are excluded. No modifier key is used intentionally
// to match VS Code-style sidebar toggle conventions.
```

No behavioral change — this is documentation only.

### Task 6.5: Batch 6 verification

```bash
npm run build && npm run lint && npm test
```

```bash
git add -A
git commit -m "polish: minor consistency and code quality fixes

- Differentiate duplicate footer aria-labels (L4)
- Replace inline style with Tailwind classes (L5)
- Extract skeleton loader constants (L7)
- Document sidebar keyboard shortcut (L1)"
```

---

## Final Verification

After all 6 batches:

```bash
npm run build && npm run lint && npm test
```

Manually verify in browser:
1. Toggle dark/light mode — check MELTDOWN text, portfolio badges, scroll shadows
2. Tab through the page — check all focus rings, contagion graph keyboard nav
3. Resize to mobile — check footer touch targets, table virtualization
4. Check flow machine animation — confirm memoization didn't break it
5. Check feature highlights grid — confirm varied layout on mobile

---

## Issue Tracking Summary

| ID | Severity | Batch | Status |
|----|----------|-------|--------|
| C1 | Critical | 1 | Fix MELTDOWN dark mode |
| H1 | High | 3 | Remove unoptimized |
| H2 | High | 1 | Migrate rgba + document dark-only |
| H3 | High | 2 | Keyboard nav for contagion graph |
| H4 | High | 2 | Touch targets |
| M1 | Medium | 2 | aria-live |
| M2 | Medium | 2 | aria-label |
| M3 | Medium | 1 | Portfolio dark mode |
| M4 | Medium | 2 | Footer contrast |
| M5 | Medium | 2 | Heading hierarchy |
| M6 | Medium | 3 | Flow machine memoization |
| M7 | Medium | 5 | Feature highlights variety |
| M8 | Medium | 2 | Reduced motion JS |
| M9 | Medium | 1 | Chart color imports |
| M10 | Medium | 1 | Sidebar width tokens |
| M11 | Medium | 4 | Table row height |
| L1 | Low | 6 | Sidebar shortcut docs |
| L2 | Low | 1 | DEWS radar rgba→oklch |
| L3 | Low | — | No-op (documented decision) |
| L4 | Low | 6 | Footer aria-label |
| L5 | Low | 6 | Inline style → Tailwind |
| L6 | Low | — | No-op (aesthetic choice) |
| L7 | Low | 6 | Skeleton constants |
| L8 | Low | — | Deferred (liquidity double-pass is functional) |
