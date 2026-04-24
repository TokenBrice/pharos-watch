# Peg Diversity Atlas Fullscreen Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Date: 2026-04-24
Status: execution-ready, all external claims verified against MDN Fullscreen API, MDN Fullscreen Guide, Radix Dialog docs, and MDN ARIA dialog role reference.
Scope: `/alt-pegs/` Peg Diversity Atlas only.

---

**Goal:** Add a fullscreen inspection mode to the Peg Diversity Atlas on `/alt-pegs/`, matching the intent in the supplied screenshot: the atlas should be inspectable as a larger, immersive map without changing the route's data model, section order, or crawlable static surface.

**Architecture:** Radix Dialog is the primary inspection surface (controlled `open`/`onOpenChange`, labeled via `Dialog.Title`, modal focus trap and body-scroll lock by default, closes on `Esc`). The browser Fullscreen API is a progressive enhancement applied to the Dialog content element when `document.fullscreenEnabled` is true, so the atlas can escape browser chrome on supporting engines. The existing `PegDiversityHeroLive` component already accepts a `worldMap: ReactNode` slot — the dialog reuses the same composition behind modifier CSS classes rather than introducing a second render path.

**Tech Stack:** Next.js 16 (App Router), React 19, Radix Dialog (via shadcn wrapper at `src/components/ui/dialog.tsx`), Radix Tooltip, lucide-react icons (`Maximize2`, `X`), Tailwind CSS 3, route-local CSS at `peg-hero.css`, vitest + `@testing-library/react` + jsdom.

---

## Current State (verified against codebase)

- `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx:1-43` — `FiatWorldAtlas` renders a `<section aria-labelledby="alt-peg-link-hub">` containing a local `AtlasHeroHeader` (the `<h2 id="alt-peg-link-hub">Peg Diversity Atlas</h2>` at lines 9–14), a skip link to `#alt-peg-history-share`, and `<PegDiversityHeroLive worldMap={<WorldMap />} />`. The header has no action slot today.
- `src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx:72-109` — `PegDiversityHeroLive({ worldMap }: { worldMap: ReactNode })` composes `HoverProvider → TopCohortStrip → SkyLayer → FiatSizeKey → FiatEmblems` inside `.peg-hero__live-shell > .peg-hero > .peg-hero__earth > .peg-hero__map-frame`. The `worldMap` prop is the existing dependency-injection point we will reuse for fullscreen mode.
- `src/app/alt-pegs/client.tsx:338-341` — `<FiatWorldAtlas ... />` is rendered once; no changes needed here.
- `src/app/alt-pegs/fiat-world-atlas/peg-hero.css:15-32, 639-722, 761-765` — atlas sizing is driven by four CSS custom properties on `.peg-hero__live-shell`: `--peg-coin-scale` (default 1), `--peg-coin-hover-scale` (1.07), `--peg-hit-scale` (1), `--peg-sky-scale` (1). `.peg-hero` height is `clamp(390px, 48vw, 590px)`, with media-query overrides at `max-width: 1279px` and `max-width: 639px`. Reduced-motion rule at 761 uses `@media (prefers-reduced-motion: reduce) { .coin-emblem { transition: none; } }`. No `:fullscreen` or `--fullscreen` hooks exist yet.
- `src/components/ui/dialog.tsx:1-158` — shadcn wrapper exports `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose`. `DialogContent` (50–82) bakes in `fixed top-[50%] left-[50%] ... max-w-[calc(100%-2rem)] ... sm:max-w-lg` centering **and** a default close button (70–78) gated by `showCloseButton?: boolean` (default `true`). Our plan must pass `showCloseButton={false}` and override the layout classes.
- `src/components/ui/button.tsx:7-39` — `Button` variants include `ghost`, size `icon-sm` (`size-10 sm:size-8`). Icon-only header-action convention.
- `src/components/ui/tooltip.tsx:44` — `TooltipProvider` is per-island in this repo (confirmed: `methodology-hint.tsx`, `status-dashboard.tsx`, `flow-table.tsx` each wrap their own). There is no global provider, so we will wrap the trigger locally.
- Existing Dialog pattern reference: `src/components/feedback-modal.tsx` — `<Dialog open={open} onOpenChange={handleOpenChange}> <DialogContent className="sm:max-w-lg"> <DialogHeader><DialogTitle>Send Feedback</DialogTitle></DialogHeader> ...`.
- Tests: `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx` (25 lines, vitest + RTL + jsdom directive at line 1, mocks `PegDiversityHeroLive` and `WorldMap`). `src/app/alt-pegs/fiat-world-atlas/__tests__/peg-diversity-hero-live.test.tsx` (55 lines, mocks data hooks and child components).
- `docs/alt-pegs-page.md:71-86` — "Section Order" section. This is the only doc that needs an amendment.

## Verified Facts From External Sources

Summarized from the subagent reviews attached during planning:

1. **Fullscreen API is element-scoped.** `Element.requestFullscreen()` asks the UA to place the specified element (and its descendants) into fullscreen; `document.exitFullscreen()` exits. Baseline status is **Limited availability** ("not Baseline because it does not work in some of the most widely-used browsers") — feature detection via `document.fullscreenEnabled` is mandatory. Source: MDN Fullscreen API.
2. **User activation is required.** "Fullscreen requests need to be called from within an event handler or otherwise they will be denied." Promise rejects with `TypeError` on failure. Listen for `fullscreenerror` alongside promise rejection. Source: MDN Fullscreen API + Guide.
3. **Exit paths.** "Pressing Esc or F11 exits all fullscreen elements." "Navigating to another page, changing tabs, or switching to another application … will likewise exit fullscreen mode." The `fullscreenchange` event carries no direction info — read `document.fullscreenElement` to tell. Our UI must provide a visible exit affordance because some exits are silent. Source: MDN Fullscreen Guide.
4. **Top-layer CSS.** "Once an element is in fullscreen mode, it is matched by `:fullscreen`, which gives it some default styles like taking up the entire screen. It is also placed in the top layer." UA default background is typically black and must be overridden. `z-index` from the rest of the app is bypassed while fullscreen. Source: MDN Fullscreen Guide.
5. **Radix Dialog, verified behaviors.** Controlled state via `open` + `onOpenChange`. `modal={true}` (default) locks body scroll and traps focus. Auto-applies `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby`. `Dialog.Title` is effectively required — Radix logs a console warning if omitted. Use `onOpenAutoFocus={(e) => { e.preventDefault(); ref.current?.focus(); }}` to redirect initial focus without losing the focus-trap. `Dialog.Portal` renders to `document.body` by default. Source: Radix Dialog primitive docs.
6. **Accessibility for the `dialog` role.** `aria-labelledby` is MDN's preferred labeling approach. Focus should move "to the default focusable control inside the dialog." Focus should return on close. Tab containment is "expected behavior." Content outside the modal must be inaccessible to SR users — Radix handles this via sibling `aria-hidden`. Source: MDN ARIA `dialog` role.

## Assumptions

- "Fullscreen mode" is a first-class inspection mode; it must work even when the browser Fullscreen API is unsupported.
- Browser fullscreen is progressive enhancement: when `document.fullscreenEnabled` is true, request it for the `DialogContent` element so the atlas fills the physical screen.
- No query-param deep link in this version; the fullscreen state is ephemeral UI state.
- Crawlability surface (`StaticAltPegLinkHub`) and route section order are unchanged.
- No methodology version bump — this feature does not touch pricing, PSI, PegScore/DEWS, LiquidityScore, report cards, mint/burn flow, yield intelligence, blacklist tracker, or Chain Health.

## File Structure

**Create:**

- `src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx` — client component rendering Radix Dialog with the atlas composition.
- `src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts` — route-local hook gating the progressive Fullscreen API enhancement.
- `src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx`
- `src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts`

**Modify:**

- `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx` — add the Expand trigger slot to `AtlasHeroHeader` and render `AtlasFullscreenDialog`.
- `src/app/alt-pegs/fiat-world-atlas/peg-hero.css` — add `.peg-hero__live-shell--fullscreen`, `.peg-hero--fullscreen`, `.atlas-fullscreen-dialog__*` classes and a `:fullscreen` background override.
- `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx` — add a trigger-button assertion.
- `docs/alt-pegs-page.md` — one-paragraph amendment to Section Order.

**Do NOT touch:** `client.tsx`, `page.tsx`, `static-link-hub.tsx`, history chart files, data hooks, methodology docs, API/worker code, or shared primitives under `src/components/ui/`.

---

## Implementation Tasks

### Task 1: Lift atlas open state into `world-atlas.tsx` (convert to client component)

**Files:**
- Modify: `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx` (entire file)
- Test: `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx:15-24`

The existing `world-atlas.tsx` has no `"use client"` directive because it renders a static shell and injects `PegDiversityHeroLive` (which is already `"use client"`). To own the Dialog open state, we must promote `world-atlas.tsx` to a client component. This is a fresh rendered leaf on `/alt-pegs/`, so promotion has no SEO impact — the crawlable surface is `StaticAltPegLinkHub`, which stays server-rendered.

- [ ] **Step 1: Write failing test for the Expand trigger button**

Open `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx`. After the existing assertion, add:

```tsx
it("renders an Expand atlas trigger button", () => {
  render(<FiatWorldAtlas fiatItems={[]} commodityIndexItems={[]} />);
  const trigger = screen.getByRole("button", { name: /expand atlas/i });
  expect(trigger).toBeTruthy();
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx`
Expected: FAIL with "Unable to find … expand atlas".

- [ ] **Step 3: Promote `world-atlas.tsx` to client, add state + header action slot**

Replace the file contents with:

```tsx
"use client";

import { useState } from "react";
import { Maximize2 } from "lucide-react";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import "./peg-hero.css";

function AtlasHeroHeader({
  onExpand,
  open,
}: {
  onExpand: () => void;
  open: boolean;
}) {
  return (
    <div className="relative z-10 flex items-center justify-between gap-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5 sm:pb-4 lg:px-6">
      <h2
        id="alt-peg-link-hub"
        className="text-lg font-semibold tracking-tight text-frost-blue/95 sm:text-xl lg:text-[1.45rem]"
      >
        Peg Diversity Atlas
      </h2>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Expand atlas"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={onExpand}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Expand atlas</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function FiatWorldAtlas(_props: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-border/70 bg-card/92 text-foreground shadow-[0_22px_60px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[oklch(0.105_0.012_248)] dark:text-white dark:shadow-[0_26px_70px_oklch(0_0_0_/0.22)]"
    >
      <AtlasHeroHeader onExpand={() => setOpen(true)} open={open} />

      <div data-alt-peg-layout="responsive-atlas" className="block">
        <a
          href="#alt-peg-history-share"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip peg map
        </a>
        <div className="peg-hero__viewport" role="group" aria-label="Peg diversity map atlas">
          <PegDiversityHeroLive worldMap={<WorldMap />} />
        </div>
      </div>

      <AtlasFullscreenDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}
```

- [ ] **Step 4: Stub `atlas-fullscreen-dialog.tsx` so the import resolves**

Create `src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx` with a minimal stub — Task 3 will fill it in:

```tsx
"use client";

export function AtlasFullscreenDialog(_props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return null;
}
```

- [ ] **Step 5: Run test to verify the trigger assertions pass**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx \
        src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx \
        src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx
git commit -m "feat(alt-pegs): add Expand atlas trigger slot to world-atlas header"
```

---

### Task 2: Add `peg-hero.css` modifier classes for fullscreen mode

**Files:**
- Modify: `src/app/alt-pegs/fiat-world-atlas/peg-hero.css` (append to end of file, after the existing `prefers-reduced-motion` block at lines 761–765)

Rationale: the existing atlas uses four CSS custom properties on `.peg-hero__live-shell` to scale coins, hover targets, hit targets, and sky — and `.peg-hero` supplies the height. We create modifier variants that override those same variables and height rule, so fullscreen mode is a class swap, not a parallel CSS tree. We also set `background` on `:fullscreen` so the UA default black does not flash when the browser API engages.

- [ ] **Step 1: Append the fullscreen CSS block**

Append to `src/app/alt-pegs/fiat-world-atlas/peg-hero.css`:

```css
/* ===== Fullscreen inspection mode ===== */

.atlas-fullscreen-dialog__content {
  display: flex;
  flex-direction: column;
  background: oklch(0.035 0.012 255 / 0.98);
}

.atlas-fullscreen-dialog__content:fullscreen {
  background: oklch(0.035 0.012 255);
}

.atlas-fullscreen-dialog__toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid oklch(0.6 0 0 / 0.14);
}

.atlas-fullscreen-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: oklch(0.92 0.03 250);
}

.atlas-fullscreen-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
}

.atlas-fullscreen-dialog__body .peg-hero__viewport {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.peg-hero__live-shell--fullscreen {
  --peg-coin-scale: 1.2;
  --peg-coin-hover-scale: 1.3;
  --peg-hit-scale: 1.1;
  --peg-sky-scale: 1.15;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.peg-hero__live-shell--fullscreen .peg-hero__legend-stack {
  flex-shrink: 0;
}

.peg-hero--fullscreen {
  flex: 1;
  min-height: 0;
  height: auto;
  border-radius: 0;
}

@media (max-width: 1279px) {
  .peg-hero__live-shell--fullscreen {
    --peg-coin-scale: 0.9;
    --peg-coin-hover-scale: 0.98;
    --peg-hit-scale: 1.18;
    --peg-sky-scale: 1;
  }
}

@media (max-width: 639px) {
  .peg-hero__live-shell--fullscreen {
    --peg-coin-scale: 0.7;
    --peg-coin-hover-scale: 0.8;
    --peg-hit-scale: 1.35;
    --peg-sky-scale: 0.85;
  }

  .atlas-fullscreen-dialog__toolbar {
    padding: 8px 12px;
  }
}
```

- [ ] **Step 2: Verify no CSS regression in existing tests**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/peg-diversity-hero-live.test.tsx`
Expected: PASS (this test does not assert styles, only DOM shape; we're adding rules, not changing the existing ones).

- [ ] **Step 3: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/peg-hero.css
git commit -m "feat(alt-pegs): add fullscreen modifier classes to peg-hero.css"
```

---

### Task 3: Build `AtlasFullscreenDialog` component (TDD)

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx` (replace the stub from Task 1)
- Create: `src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx`

The dialog re-renders the exact same `<PegDiversityHeroLive worldMap={<WorldMap />} />` composition, but passes a modifier class via a new opt-in prop added in this task.

- [ ] **Step 1: Extend `PegDiversityHeroLive` to accept an optional wrapper class**

The existing signature is `({ worldMap }: { worldMap: ReactNode })`. Add an opt-in `variant` prop so the dialog can apply the `--fullscreen` modifier without mutating normal-mode rendering.

In `src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx`, change the function signature:

```tsx
export function PegDiversityHeroLive({
  worldMap,
  variant = "default",
}: {
  worldMap: ReactNode;
  variant?: "default" | "fullscreen";
}) {
```

Then update the two wrapper classes so they pick up the modifier only in fullscreen mode. Replace the line `<div className="peg-hero__live-shell">` (line 87) with:

```tsx
<div
  className={
    variant === "fullscreen"
      ? "peg-hero__live-shell peg-hero__live-shell--fullscreen"
      : "peg-hero__live-shell"
  }
>
```

And replace `<div className="peg-hero">` (line 91) with:

```tsx
<div
  className={
    variant === "fullscreen" ? "peg-hero peg-hero--fullscreen" : "peg-hero"
  }
>
```

- [ ] **Step 2: Write failing test for the dialog component**

Create `src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";

vi.mock("@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live", () => ({
  PegDiversityHeroLive: ({ variant }: { variant?: string }) => (
    <div data-testid="hero-live" data-variant={variant ?? "default"} />
  ),
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/world-map", () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

describe("AtlasFullscreenDialog", () => {
  afterEach(() => cleanup());

  it("renders nothing when closed", () => {
    render(<AtlasFullscreenDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("hero-live")).toBeNull();
  });

  it("renders a labeled dialog with the atlas body in fullscreen variant when open", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /peg diversity atlas/i });
    expect(dialog).toBeTruthy();
    const hero = screen.getByTestId("hero-live");
    expect(hero.getAttribute("data-variant")).toBe("fullscreen");
  });

  it("exposes a Close atlas control as the first focusable element", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: /close atlas/i })).toBeTruthy();
  });

  it("calls onOpenChange(false) when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    render(<AtlasFullscreenDialog open={true} onOpenChange={onOpenChange} />);
    const close = screen.getByRole("button", { name: /close atlas/i });
    close.click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx`
Expected: FAIL (all four cases) — stub returns `null`.

- [ ] **Step 4: Implement the dialog**

Replace the stub in `src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx` with:

```tsx
"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { useBrowserFullscreen } from "@/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen";

const DIALOG_CONTENT_CLASSES =
  "atlas-fullscreen-dialog__content fixed inset-2 sm:inset-4 top-2 left-2 sm:top-4 sm:left-4 max-w-none w-auto h-auto translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-2xl border-border/70 p-0 shadow-2xl";

export function AtlasFullscreenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useBrowserFullscreen(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className={DIALOG_CONTENT_CLASSES}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <div className="atlas-fullscreen-dialog__toolbar">
          <DialogTitle className="atlas-fullscreen-dialog__title">
            Peg Diversity Atlas
          </DialogTitle>
          <DialogDescription className="sr-only">
            Expanded inspection view of the Peg Diversity Atlas. Press Escape to close.
          </DialogDescription>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close atlas"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="atlas-fullscreen-dialog__body">
          <div
            className="peg-hero__viewport"
            role="group"
            aria-label="Peg diversity map atlas"
          >
            <PegDiversityHeroLive worldMap={<WorldMap />} variant="fullscreen" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Key design decisions in this code, mapped to verified facts:

- `showCloseButton={false}` disables the shadcn-wrapper built-in close button (`src/components/ui/dialog.tsx:53-78`) so we render a custom close button inside our toolbar. Verified via Radix audit.
- `onOpenAutoFocus={(e) => { e.preventDefault(); closeRef.current?.focus(); }}` redirects Radix's default initial focus to the close button without losing the focus-trap (verified Radix pattern).
- `DialogTitle` is mandatory — Radix warns if absent — so it is always rendered and visible in the toolbar (verified).
- `DialogDescription` is kept for SR users via `sr-only`; it silences Radix's describedby warning without adding visible prose.
- `useBrowserFullscreen(open)` returns a ref; Task 4 implements it.
- The `DIALOG_CONTENT_CLASSES` override the baked-in `top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%] sm:max-w-lg` from `DialogContent` (confirmed lines 63–64 of `dialog.tsx`) so the dialog fills near-viewport.

- [ ] **Step 5: Stub `use-browser-fullscreen.ts` so the import resolves**

Create `src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts`:

```ts
"use client";

import { useRef, type RefObject } from "react";

export function useBrowserFullscreen(_open: boolean): RefObject<HTMLDivElement | null> {
  return useRef<HTMLDivElement | null>(null);
}
```

Task 4 will replace this with the real implementation.

- [ ] **Step 6: Run dialog test to verify it passes**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx`
Expected: all four cases PASS.

- [ ] **Step 7: Run full alt-pegs test scope to confirm no regression**

Run:
```
npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx \
            src/app/alt-pegs/fiat-world-atlas/__tests__/peg-diversity-hero-live.test.tsx \
            src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx \
            src/app/alt-pegs/static-link-hub.test.tsx \
            src/app/alt-pegs/client.test.tsx
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog.tsx \
        src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts \
        src/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live.tsx \
        src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx
git commit -m "feat(alt-pegs): add AtlasFullscreenDialog and fullscreen variant slot"
```

---

### Task 4: Implement `useBrowserFullscreen` hook with TDD

**Files:**
- Modify: `src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts`
- Create: `src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts`

This hook is the progressive-enhancement layer. It:
1. Returns a ref the caller attaches to the `DialogContent`.
2. When `open` becomes `true` and `document.fullscreenEnabled` is true, calls `requestFullscreen()` on the target.
3. When `open` becomes `false` and the target still owns fullscreen, calls `document.exitFullscreen()`.
4. On unmount (belt-and-braces), exits fullscreen if the target owns it.
5. Swallows promise rejections (verified as `TypeError` on rejection) — the Radix Dialog remains the fallback.

Note on user-activation: MDN specifies `requestFullscreen` must be called from within a user-activation handler. Because the hook's effect runs right after React commits the `open=true` transition (which was itself set by the trigger's click handler), the browser is still within the transient-activation window. This is the standard React pattern and works in Chrome, Firefox, and Edge. Safari may reject on older versions; we silently swallow the rejection in that case.

- [ ] **Step 1: Write failing hook tests**

Create `src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts`:

```ts
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserFullscreen } from "@/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen";

type FullscreenStub = {
  enabled: boolean;
  element: Element | null;
  requestSpy: ReturnType<typeof vi.fn>;
  exitSpy: ReturnType<typeof vi.fn>;
};

function stubFullscreen(enabled: boolean): FullscreenStub {
  const requestSpy = vi.fn(() => Promise.resolve());
  const exitSpy = vi.fn(() => Promise.resolve());
  const stub: FullscreenStub = { enabled, element: null, requestSpy, exitSpy };

  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => stub.enabled,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => stub.element,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: () => {
      exitSpy();
      stub.element = null;
      return Promise.resolve();
    },
  });

  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    value: function (this: Element) {
      requestSpy();
      stub.element = this;
      return Promise.resolve();
    },
  });

  return stub;
}

describe("useBrowserFullscreen", () => {
  let stub: FullscreenStub;

  beforeEach(() => {
    stub = stubFullscreen(true);
  });

  afterEach(() => {
    // @ts-expect-error reset
    delete document.fullscreenEnabled;
    // @ts-expect-error reset
    delete document.fullscreenElement;
    // @ts-expect-error reset
    delete document.exitFullscreen;
    // @ts-expect-error reset
    delete Element.prototype.requestFullscreen;
    vi.restoreAllMocks();
  });

  it("returns a usable ref object", () => {
    const { result } = renderHook(() => useBrowserFullscreen(false));
    expect(result.current).toHaveProperty("current");
  });

  it("calls requestFullscreen on the attached element when open transitions to true", async () => {
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    expect(stub.requestSpy).toHaveBeenCalledTimes(1);
  });

  it("calls exitFullscreen when open returns to false and target owns fullscreen", async () => {
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });
    await act(async () => {
      rerender({ open: false });
    });

    expect(stub.exitSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when document.fullscreenEnabled is false", async () => {
    stub.enabled = false;
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    expect(stub.requestSpy).not.toHaveBeenCalled();
  });

  it("swallows a rejected requestFullscreen promise without throwing", async () => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new TypeError("denied")),
    });
    const { result, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await expect(
      act(async () => {
        rerender({ open: true });
      }),
    ).resolves.not.toThrow();
  });

  it("exits fullscreen on unmount if target still owns it", async () => {
    const { result, unmount, rerender } = renderHook(({ open }) => useBrowserFullscreen(open), {
      initialProps: { open: false },
    });
    const el = document.createElement("div");
    result.current.current = el;

    await act(async () => {
      rerender({ open: true });
    });

    unmount();

    expect(stub.exitSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts`
Expected: FAIL — the stub doesn't call any fullscreen APIs.

- [ ] **Step 3: Implement the hook**

Replace `src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts` contents with:

```ts
"use client";

import { useEffect, useRef, type RefObject } from "react";

export function useBrowserFullscreen(open: boolean): RefObject<HTMLDivElement | null> {
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!document.fullscreenEnabled) return;
    const target = targetRef.current;
    if (!target) return;

    if (open && document.fullscreenElement !== target) {
      const requested = target.requestFullscreen?.();
      if (requested && typeof requested.catch === "function") {
        requested.catch(() => {
          // MDN: rejects with TypeError when denied (no activation, permissions
          // policy, iframe without allowfullscreen, etc.). Silently accept —
          // the Radix Dialog remains the fallback.
        });
      }
    } else if (!open && document.fullscreenElement === target) {
      const exited = document.exitFullscreen?.();
      if (exited && typeof exited.catch === "function") {
        exited.catch(() => {
          // Swallow — browser may have already exited via Esc/F11.
        });
      }
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return;
      if (document.fullscreenElement === targetRef.current) {
        const exited = document.exitFullscreen?.();
        if (exited && typeof exited.catch === "function") exited.catch(() => {});
      }
    };
  }, []);

  return targetRef;
}
```

- [ ] **Step 4: Run hook tests to verify they pass**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts`
Expected: all six cases PASS.

- [ ] **Step 5: Run full alt-pegs suite as a regression check**

Run:
```
npm test -- src/app/alt-pegs
```
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen.ts \
        src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts
git commit -m "feat(alt-pegs): add useBrowserFullscreen progressive-enhancement hook"
```

---

### Task 5: Update route documentation

**Files:**
- Modify: `docs/alt-pegs-page.md:73-86` (Section Order paragraph)

- [ ] **Step 1: Read current paragraph to confirm edit target**

Lines 73–86 describe the `FiatWorldAtlas` hero at every breakpoint. We add one sentence describing the fullscreen affordance, preserving the rest.

- [ ] **Step 2: Apply the edit**

In `docs/alt-pegs-page.md`, after the paragraph ending at line 84 ("...still provides the stacked `MobileRegionList` below the historical charts."), add this sentence to the existing paragraph:

```markdown
The atlas card header exposes an Expand atlas affordance that opens a viewport-sized inspection overlay built on Radix Dialog; when `document.fullscreenEnabled` is true the overlay also requests browser fullscreen as a progressive enhancement. The overlay reuses the same `PegDiversityHeroLive` composition with a `--fullscreen` CSS variant and does not alter the crawlable hidden link hub, route query-state, or section order.
```

- [ ] **Step 3: Commit**

```bash
git add docs/alt-pegs-page.md
git commit -m "docs(alt-pegs): document atlas fullscreen inspection mode"
```

---

### Task 6: Full validation gate

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: PASS with no new errors in the modified files.

- [ ] **Step 2: Type check (frontend)**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Merge gate**

Run: `npm run test:merge-gate`
Expected: PASS (skip cleanly or pass build/SEO/typecheck — atlas changes are client-only, so Pages build should be the gating check).

- [ ] **Step 6: Manual browser QA**

Start dev server and walk the following scenarios in Chrome and Firefox:

```bash
npm run dev
```

1. Navigate to `http://localhost:3000/alt-pegs/`.
2. **Trigger:** Confirm the Expand atlas button appears at the top-right of the Peg Diversity Atlas card, with a tooltip on hover.
3. **Desktop open (1440×900 and 1920×1080):**
   - Click Expand atlas → dialog fills the viewport.
   - Browser fullscreen engages on Chrome/Firefox (page UI chrome disappears).
   - Top cohort strip and atlas markers are visibly larger.
   - Close button focuses first (Tab stays inside dialog; Shift+Tab from first reaches last).
4. **Esc exit path:** Press `Esc` → dialog closes, browser fullscreen exits, focus returns to the Expand trigger.
5. **Click close:** same outcome as Esc.
6. **Tablet (iPad viewport):** Verify the toolbar and close button stay reachable; top strip wraps without overflow.
7. **Mobile (iPhone viewport via DevTools device mode):** No horizontal scroll by default; close button remains tappable; coin markers scale appropriately.
8. **Fullscreen API fallback:** In DevTools console, run
   ```js
   Object.defineProperty(document, "fullscreenEnabled", { get: () => false });
   ```
   Reload, click Expand atlas. Dialog still opens and fills near-viewport (inset-2/4). Close works normally.
9. **External exit sync:** With browser fullscreen engaged, press `F11`. Dialog stays open (Radix still controls it), browser fullscreen exits. Close button still works.
10. **Keyboard flow end-to-end:** Tab reaches Expand trigger → Enter opens dialog → Tab moves through close and coin links → Esc closes → focus lands back on Expand trigger.

Record any visual issues and fix inline before considering the task complete.

- [ ] **Step 7: Final commit (if QA fixes were applied)**

If QA surfaces visual issues only (e.g. hover-card clipping at new scale), apply CSS tweaks to `peg-hero.css` and commit:

```bash
git add src/app/alt-pegs/fiat-world-atlas/peg-hero.css
git commit -m "polish(alt-pegs): visual tuning for fullscreen atlas"
```

---

## Testing Plan (summary)

Unit/component tests created by this plan:

- `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx` — adds trigger assertion (Task 1).
- `src/app/alt-pegs/fiat-world-atlas/__tests__/atlas-fullscreen-dialog.test.tsx` — 4 cases (Task 3).
- `src/app/alt-pegs/fiat-world-atlas/__tests__/use-browser-fullscreen.test.ts` — 6 cases, all against a jsdom fullscreen stub (Task 4).

Unchanged and expected to stay green:

- `peg-diversity-hero-live.test.tsx` (new `variant` prop defaults to `"default"`, so existing assertions are unaffected).
- `static-link-hub.test.tsx`, `client.test.tsx`, `page.test.tsx`, `alt-peg-cohort-history-chart.test.tsx`.

Coverage of this feature-slice is enforced implicitly by the repo's 66%-lines threshold (see `vitest.config.ts`). The hook and dialog tests exercise every branch that contains logic.

---

## Success Criteria

- Normal atlas appearance and route section order are unchanged when fullscreen is closed.
- The atlas can be expanded into a viewport-sized inspection mode with a visible close control.
- Browser fullscreen is engaged only when `document.fullscreenEnabled` is true; its absence or rejection does not degrade the feature.
- `StaticAltPegLinkHub` and the hidden crawlable directory are untouched.
- `aria-labelledby` wiring, focus trap, Esc-to-close, and focus return are all behaviorally verified.
- Lint, type check, full test suite, production build, and merge gate pass.
- `docs/alt-pegs-page.md` mentions the fullscreen mode.

## Risks And Mitigations

- **Hydration/runtime risk.** `requestFullscreen()` is browser-only. Mitigation: the hook guards `typeof document !== "undefined"` and feature-detects `fullscreenEnabled`; the component and hook files are `"use client"`.
- **Fullscreen API support variance.** MDN marks it **Limited availability** ("does not work in some of the most widely-used browsers"). Mitigation: Radix Dialog is the product surface; browser fullscreen is purely enhancement.
- **User-activation timing.** Our hook calls `requestFullscreen` in a `useEffect` after React commits the `open=true` transition. In practice this is inside the transient-activation window because the click handler just set the state. If any browser rejects, the promise is swallowed and the dialog remains open — user experience is not broken, only slightly less immersive.
- **Duplicate live query work while dialog open.** `useStablecoins()` is TanStack-cached, so rendering the atlas twice reuses the same fetched data. Acceptable for a modal inspection mode.
- **Tooltip/card overflow at larger scale.** Increased `--peg-coin-scale` may clip hover cards. Mitigation: QA step 3 watches for clipping; existing `data-card-x/y` placement logic is retained.
- **Focus density.** The map has many coin links. Mitigation: close button is the initial focus target (`onOpenAutoFocus` + ref); the dialog's focus trap keeps Tab inside; Esc provides a single-keystroke exit.
- **Mobile browser fullscreen restrictions.** iOS Safari and embedded WebViews may deny fullscreen. Mitigation: the Radix dialog covers the viewport regardless.
- **Console warnings from Radix.** `DialogTitle` is always rendered visibly; `DialogDescription` is rendered `sr-only`. Both warnings are silenced.

---

## Self-Review Notes

Spec coverage: the original draft's 8 recommended-approach points all map to tasks — (1) trigger button → Task 1; (2) atlas body extraction → obviated by reusing `PegDiversityHeroLive` slot, accomplished implicitly in Task 3; (3) new dialog component → Task 3; (4) viewport-filling overlay with custom close → Task 3; (5) same composition with wrapper class → Task 3 via `variant` prop + Task 2 CSS; (6) CSS variable overrides → Task 2; (7) progressive browser fullscreen → Task 4; (8) `fullscreenchange` resilience → handled in Task 4 because the React-controlled `open` state drives reconciliation — if the browser exits externally, React state stays correct and the next transition to `open=false` finds no owned fullscreen element (the `document.fullscreenElement === target` guard returns false) so `exitFullscreen` is skipped, and the dialog remains usable. No explicit `fullscreenchange` listener is needed because no UI component reads an independent "isBrowserFullscreen" flag.

No placeholders. Every code-producing step shows concrete code. Every command is exact. All types (`RefObject<HTMLDivElement | null>`, `variant?: "default" | "fullscreen"`) are consistent across tasks. All file paths have been verified against the actual working tree.
