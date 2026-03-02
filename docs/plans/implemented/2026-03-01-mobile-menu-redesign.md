# Mobile Menu Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the crowded mobile dropdown menu with a full-screen Sheet overlay featuring grouped navigation, item descriptions, staggered entry animation, and active-section highlighting.

**Architecture:** Single-component rewrite of `header.tsx`. Replace `DropdownMenu` with shadcn `Sheet` (side="left"). Render items from existing `NAV_GROUPS` config with group headers, descriptions, and animations. No config changes needed.

**Tech Stack:** React 19, shadcn/ui Sheet, Tailwind CSS v4, lucide-react icons, existing nav-config.ts

---

### Task 1: Add shadcn Sheet component

**Files:**
- Create: `src/components/ui/sheet.tsx`

**Step 1: Install Sheet via shadcn CLI**

Run: `npx shadcn@latest add sheet`
Expected: Sheet component created at `src/components/ui/sheet.tsx`

If the CLI fails (version mismatch, etc.), manually create the component using Radix Dialog primitives already available via the `radix-ui` package.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/ui/sheet.tsx package.json package-lock.json
git commit -m "chore: add shadcn Sheet component for mobile menu"
```

---

### Task 2: Rewrite header.tsx — Sheet with grouped navigation

**Files:**
- Modify: `src/components/header.tsx`

**Step 1: Replace DropdownMenu with Sheet**

Replace the `DropdownMenu`/`DropdownMenuContent`/`DropdownMenuItem` imports and usage with `Sheet`/`SheetTrigger`/`SheetContent`/`SheetClose`.

Key changes:
- Import `Sheet`, `SheetTrigger`, `SheetContent`, `SheetClose`, `SheetTitle` from `@/components/ui/sheet`
- Import `NAV_GROUPS`, `DASHBOARD_NAV_ITEM` instead of `NAV_ITEMS`, `BOTTOM_NAV_ITEMS`
- Add `useState` for open state (needed to close on navigation)
- SheetContent: `side="left"`, full-width override class `w-full sm:w-full`
- Remove the DropdownMenu import entirely

**Step 2: Build the Sheet content structure**

Three sections inside SheetContent:

**Header (sticky):**
```tsx
<div className="flex items-center justify-between px-4 h-14 border-b">
  <Link href="/" className="flex items-center gap-3">
    <Image src="/pharos-icon.png" ... />
    <span className="text-lg font-mono uppercase tracking-[0.2em]">PHAROS</span>
  </Link>
  <SheetClose asChild>
    <Button variant="ghost" size="icon"><X className="h-4 w-4" /></Button>
  </SheetClose>
</div>
```

**Navigation (scrollable middle):**
```tsx
<nav className="flex-1 overflow-y-auto px-4 py-4">
  {/* Dashboard standalone */}
  <MobileNavItem item={DASHBOARD_NAV_ITEM} ... />

  {/* Grouped sections */}
  {NAV_GROUPS.map((group, groupIndex) => (
    <div key={group.label} className={...stagger animation + active group border}>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2 mt-4">
        {group.label}
      </div>
      {group.items.map((item) => (
        <MobileNavItem key={item.href} item={item} ... />
      ))}
    </div>
  ))}
</nav>
```

Each `MobileNavItem` renders:
- Icon + label on one line
- Description as muted secondary text below
- `py-3` for comfortable tap targets
- Active state: accent bg + font-medium + left border
- onClick: `setOpen(false)` to close sheet on navigation

**Footer (sticky):**
```tsx
<div className="border-t px-4 py-3 flex items-center justify-between">
  <Button variant="ghost" onClick={openCommandPalette}>
    <Search /> Search
  </Button>
  <ThemeToggle />
</div>
```

**Step 3: Add staggered entry animation**

Use Tailwind `animate-in fade-in slide-in-from-left-2` with inline `style={{ animationDelay }}` per group:
- Dashboard: 0ms
- Group 0: 50ms
- Group 1: 100ms
- Group 2: 150ms
- Group 3: 200ms
- Group 4: 250ms

Add `animation-fill-mode: backwards` so items are hidden until their delay fires.

**Step 4: Add active-section group border**

Check if any item in the group `isActive`. If so, apply `border-l-2 border-l-frost-blue pl-3` to the group container (matching sidebar's `frost-blue` accent).

**Step 5: Remove search and theme toggle from header bar**

Since these move into the Sheet, remove them from the header's right-side div. The header bar becomes: logo | hamburger only.

**Step 6: Remove unused imports**

Remove `DropdownMenu*` imports, `NAV_ITEMS`, `BOTTOM_NAV_ITEMS`. Add new imports for Sheet components, `X` icon, `NAV_GROUPS`, `DASHBOARD_NAV_ITEM`.

**Step 7: Build and type-check**

Run: `npm run build`
Expected: Build succeeds with no type errors

**Step 8: Commit**

```bash
git add src/components/header.tsx
git commit -m "feat(mobile): replace dropdown with full-screen grouped navigation sheet"
```

---

### Task 3: Visual QA and polish

**Step 1: Lint**

Run: `npm run lint`
Expected: No new lint errors

**Step 2: Build final check**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit any fixes**

If lint/build issues arose, fix and commit.

---

### Task 4: Push to production

**Step 1: Push**

Run: `git push origin main`
Expected: Cloudflare Pages picks up the deployment

**Step 2: Track deployment**

Monitor the Cloudflare deployment via the live site.

**Step 3: Verify on mobile**

Use Chrome extension to verify the mobile menu at pharos.watch:
- Hamburger opens full-screen sheet
- Groups render with headers
- Descriptions show under each item
- Active item highlighted
- Stagger animation plays
- Sheet closes on nav item tap
- Search and theme toggle in footer work
