# Chains Hero Module Tweaks — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the Harbor Chart (`NauticalChart`) panel on the `/chains` page so the subtitle fits on one line at typical desktop widths, and mobile first paint shows the lighthouse instead of only the left-edge ships.

**Architecture:** Two surgical edits to the existing module — no new components. (1) Shorten the subtitle copy in `src/app/chains/nautical-chart.tsx`. (2) Restructure the responsive breakpoints in `src/app/chains/nautical-chart.css` so viewports below the `md` (768px) breakpoint render the SVG at `width: 100%` (no horizontal scroll, lighthouse visible at first paint), and the existing scrollable fixed-width cascade kicks in from 768px upward.

**Tech Stack:** Next.js, React, CSS media queries. No tests added — changes are purely presentational; verification is via `npm run build`, `npm run lint`, and visual check at iPhone XR (414×896) and desktop widths.

---

## File Structure

- Modify: `src/app/chains/nautical-chart.tsx:827-830` — subtitle `<p>` copy
- Modify: `src/app/chains/nautical-chart.css:1-40` — viewport + svg responsive rules

No new files.

---

### Task 1: Shorten the subtitle copy

**Files:**
- Modify: `src/app/chains/nautical-chart.tsx:827-830`

- [ ] **Step 1: Replace the subtitle paragraph**

Current (lines 827–830):

```tsx
<p className="max-w-3xl text-sm text-muted-foreground">
  Vessel length tracks supply; hull color is health band; pennant span is dominant-coin share; window rows
  scale with vessel size; hull cargo marks show top stablecoins sized by chain-local supply.
</p>
```

Replace with:

```tsx
<p className="max-w-3xl text-sm text-muted-foreground">
  Vessel length = supply · hull color = health · pennant = dominant-coin share · cargo marks = top stablecoins by chain-local supply.
</p>
```

Rationale: drops the redundant "window rows scale with vessel size" clause (implied by vessel length) and switches to middot-separated shorthand. Final string is ~135 chars, which fits one line at `text-sm` inside `max-w-3xl` at typical desktop widths.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: success, no type errors from this file.

---

### Task 2: Responsive viewport — fit-to-width below `md`, scroll from `md` up

**Files:**
- Modify: `src/app/chains/nautical-chart.css:1-40`

- [ ] **Step 1: Restructure the viewport + svg CSS**

Current (lines 1–40):

```css
.nc-chart-viewport {
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  border-top: 1px solid oklch(1 0 0 / 0.06);
  background: oklch(0.08 0.025 252);
  scrollbar-color: oklch(0.62 0.13 248 / 0.65) oklch(0.12 0.03 252 / 0.55);
  scrollbar-width: thin;
  -webkit-overflow-scrolling: touch;
}

.nc-chart-viewport:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}

.nc-chart-svg {
  aspect-ratio: 1200 / 320;
  width: 62rem;
  max-width: none;
  height: auto;
}

@media (min-width: 640px) {
  .nc-chart-svg {
    width: 66rem;
  }
}

@media (min-width: 1024px) {
  .nc-chart-svg {
    width: 74rem;
  }
}

@media (min-width: 1280px) {
  .nc-chart-svg {
    width: 100%;
  }
}
```

Replace with:

```css
.nc-chart-viewport {
  overflow-x: hidden;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  border-top: 1px solid oklch(1 0 0 / 0.06);
  background: oklch(0.08 0.025 252);
  scrollbar-color: oklch(0.62 0.13 248 / 0.65) oklch(0.12 0.03 252 / 0.55);
  scrollbar-width: thin;
  -webkit-overflow-scrolling: touch;
}

.nc-chart-viewport:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}

.nc-chart-svg {
  aspect-ratio: 1200 / 320;
  width: 100%;
  max-width: 100%;
  height: auto;
}

@media (min-width: 768px) {
  .nc-chart-viewport {
    overflow-x: auto;
  }
  .nc-chart-svg {
    width: 66rem;
    max-width: none;
  }
}

@media (min-width: 1024px) {
  .nc-chart-svg {
    width: 74rem;
  }
}

@media (min-width: 1280px) {
  .nc-chart-svg {
    width: 100%;
  }
}
```

Changes:
- Base viewport: `overflow-x: hidden` (no scrollbar on mobile since SVG now fits).
- Base svg: `width: 100%; max-width: 100%` — scales the 1200-unit viewBox to container width, so the full scene (ships + lighthouse) is visible at first paint.
- New `min-width: 768px` media query re-enables `overflow-x: auto` and sets the fixed `66rem` width — restoring current desktop behavior from the `md` breakpoint upward.
- `1024px` and `1280px` rules unchanged.
- Removed the old `min-width: 640px` rule (folded into the 768px rule since we no longer want scroll on small tablets).

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Visual verification in browser**

Run: `npm run dev` (if not already running), then:
1. Open `/chains` at iPhone XR size (414×896) — confirm the harbor scene (Ethereum through to lighthouse) is fully visible in the chart panel without horizontal scroll. Ships will be smaller but lighthouse is present.
2. Resize to ≥768px — confirm horizontal scroll returns, SVG is 66rem wide, behavior matches current desktop.
3. Resize to ≥1280px — confirm SVG fills container (no scroll).
4. Confirm the subtitle from Task 1 fits one line at desktop width.

---

### Task 3: Lint + commit

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 2: Commit both changes together**

Both edits are small tweaks to the same module — single commit.

```bash
git add src/app/chains/nautical-chart.tsx src/app/chains/nautical-chart.css
git commit -m "$(cat <<'EOF'
refactor: tighten chains harbor chart hero

- shorten subtitle copy so it fits one line at desktop widths
- fit-to-width below md breakpoint so mobile first paint shows the lighthouse instead of only edge ships

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify commit**

Run: `git log -1 --stat`
Expected: one commit touching `src/app/chains/nautical-chart.tsx` and `src/app/chains/nautical-chart.css`.

---

## Self-Review

1. **Spec coverage:** Both recommendations from the conversation (copy rewrite + responsive fit-to-width on mobile with scroll from md up) are covered by Tasks 1 and 2. ✓
2. **Placeholder scan:** No TBDs, no "handle edge cases" — all steps show exact before/after code. ✓
3. **Type consistency:** CSS and JSX only; no type signatures involved. ✓
4. **Breakpoint sanity:** Chose 768px (`md`) as the switch point — matches Tailwind's `md:` breakpoint used elsewhere in the codebase, and is the narrowest width where 66rem scroll remains usable. At 640–767px we now fit-to-width (slightly smaller than before); the alternative is extending scroll down to 640px, but since the lighthouse is the metaphor's anchor, fit-to-width on small tablets is the intended UX.
