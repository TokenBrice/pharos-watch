# Collapsible Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar collapsible per-group, dissolve the Info group, and surface the 5 About reference pages as first-class nav citizens.

**Architecture:** The nav config (`nav-config.ts`) is restructured to 3 standard groups + 1 link-group for About. A shared `useNavCollapse` hook manages per-group expand/collapse state (localStorage-persisted, route-aware auto-expand). Sidebar and mobile drawer both consume the hook.

**Tech Stack:** React 19, Next.js 16, Tailwind CSS v4, localStorage, lucide-react icons

**Spec:** `docs/superpowers/specs/2026-04-05-collapsible-nav-design.md`

---

### Task 1: Restructure nav config

**Files:**
- Modify: `src/lib/nav-config.ts`

This task changes the data layer only — no UI changes yet.

- [ ] **Step 1: Add `key` field to `NavGroup` and create `AboutNavGroup` type**

In `src/lib/nav-config.ts`, update the interfaces:

```ts
export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export interface AboutNavGroup {
  key: "about";
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  children: NavItem[];
}
```

- [ ] **Step 2: Add `key` to each existing group and redistribute Info items**

Replace the `NAV_GROUPS` array. Move Upcoming and Cemetery into Data, Digest into Tools. Remove the Info group entirely. Add keys to each group:

```ts
export const NAV_GROUPS: NavGroup[] = [
  {
    key: "risk-lab",
    label: "Risk Lab",
    items: [
      { href: "/stability-index", label: "Stability Index", icon: LighthouseIcon, description: "Market-regime read for the stablecoin system" },
      { href: "/safety-scores", label: "Safety Scores", icon: FlaskConical, description: "Cross-market safety grades and contagion scenarios" },
      { href: "/yield", label: "Risk-Adjusted Yield", icon: TrendingUp, description: "Yield ranked after adjusting for stablecoin risk" },
    ],
  },
  {
    key: "data",
    label: "Data",
    items: [
      { href: "/chains/", label: "Stable per Chain", icon: Layers, description: "Chain-by-chain stablecoin share, mix, and health" },
      { href: "/liquidity", label: "Liquidity Tracker", icon: Droplets, description: "DEX depth, durability, and market support" },
      { href: "/depeg", label: "Depeg Tracker", icon: Activity, description: "Live incident board for peg stress and early warnings" },
      { href: "/flows", label: "Mint/Burn Flows", icon: ArrowUpDown, description: "Ethereum issuance and redemption pressure" },
      { href: "/blacklist", label: "Blacklist Tracker", icon: ShieldBan, description: "Freeze activity and issuer control events" },
      { href: "/treasuries", label: "Treasuries", icon: Landmark, description: "Protocol and DAO treasuries ranked by stablecoin exposure" },
      { href: "/upcoming", label: "Upcoming", icon: Rocket, description: "Pre-launch stablecoins and launch-watch context" },
      { href: "/cemetery", label: "Cemetery", icon: Skull, description: "Failed stablecoins and the lessons they left behind" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    items: [
      { href: "/portfolio", label: "Portfolio Audit", icon: Wallet, description: "Look through your holdings as one combined stablecoin book" },
      { href: "/compare", label: "Compare", icon: ArrowLeftRight, description: "Build a live peer set and judge substitutes side by side" },
      { href: "/dependency-map", label: "Dependency Map", icon: Network, description: "Collateral graph for hidden upstream stablecoin risk" },
      { href: "/telegram", label: "Telegram Alerts", icon: Send, description: "Push alerts for depegs, DEWS shifts, and the daily digest" },
      { href: "/digest", label: "Digest", icon: Newspaper, description: "Daily editorial recap of the stablecoin market" },
    ],
  },
];
```

- [ ] **Step 3: Add `ABOUT_NAV_GROUP` and `DEFAULT_EXPANDED`**

Below `NAV_GROUPS`, add:

```ts
export const ABOUT_NAV_GROUP: AboutNavGroup = {
  key: "about",
  href: "/about",
  label: "About",
  icon: Info,
  description: "Scope, data sources, and why Pharos exists",
  children: [
    { href: "/methodology", label: "Methodology", icon: BookOpen, description: "Reference manual for formulas, thresholds, and changelogs" },
    { href: "/coverage", label: "Coverage", icon: TableProperties, description: "Truth surface for what each route can show per coin" },
    { href: "/start", label: "Start Here", icon: Compass, description: "Shortest route into the product for new or returning users" },
    { href: "/about/api", label: "API Reference", icon: KeyRound, description: "Auth model, key requirement, and full endpoint reference" },
    { href: "/changelog", label: "Changelog", icon: ScrollText, description: "Weekly release notes and feature updates" },
  ],
};

export const DEFAULT_EXPANDED: Record<string, boolean> = {
  "risk-lab": true,
  data: false,
  tools: false,
  about: false,
};
```

- [ ] **Step 4: Update `NAV_ITEMS` flat list and remove `ABOUT_REFERENCE_ITEMS`**

Replace the old `ABOUT_REFERENCE_ITEMS` export and `NAV_ITEMS`:

```ts
/** Flat list for use in header and command palette */
export const NAV_ITEMS: NavItem[] = [
  DASHBOARD_NAV_ITEM,
  ...NAV_GROUPS.flatMap((g) => g.items),
  { href: ABOUT_NAV_GROUP.href, label: ABOUT_NAV_GROUP.label, icon: ABOUT_NAV_GROUP.icon, description: ABOUT_NAV_GROUP.description },
  ...ABOUT_NAV_GROUP.children,
];
```

Remove the `ABOUT_REFERENCE_ITEMS` export entirely.

- [ ] **Step 5: Update `about-reference-module.tsx` to import from new location**

In `src/components/about-reference-module.tsx`, change the import:

```ts
// Before:
import { ABOUT_REFERENCE_ITEMS } from "@/lib/nav-config";

// After:
import { ABOUT_NAV_GROUP } from "@/lib/nav-config";
```

And update the usage from `ABOUT_REFERENCE_ITEMS.map(...)` to `ABOUT_NAV_GROUP.children.map(...)`.

- [ ] **Step 6: Verify build**

Run: `npx tsc --noEmit 2>&1 | grep -E 'nav-config|sidebar|header|about-reference|command-palette' || echo "no nav-related errors"`

Expected: no errors referencing nav-config consumers.

- [ ] **Step 7: Commit**

```bash
git add src/lib/nav-config.ts src/components/about-reference-module.tsx
git commit -m "refactor(nav): restructure groups, dissolve Info, add About nav group"
```

---

### Task 2: Add `useNavCollapse` hook

**Files:**
- Create: `src/hooks/use-nav-collapse.ts`
- Create: `src/hooks/__tests__/use-nav-collapse.test.ts`

- [ ] **Step 1: Write failing tests for the hook**

Create `src/hooks/__tests__/use-nav-collapse.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock browser-storage before importing the hook module
vi.mock("@/lib/browser-storage", () => ({
  getWindowStorage: () => mockStorage,
  safeStorageGetItem: (_s: unknown, key: string) => mockStorage.getItem(key),
  safeStorageSetItem: (_s: unknown, key: string, val: string) => mockStorage.setItem(key, val),
}));

let mockStorage: Storage;

function createMockStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

// Import after mocks are in place
const { getExpandedState, setExpandedState, STORAGE_KEY } = await import("@/hooks/use-nav-collapse");

beforeEach(() => {
  mockStorage = createMockStorage();
});

describe("getExpandedState", () => {
  it("returns defaults when localStorage is empty", () => {
    const state = getExpandedState();
    expect(state["risk-lab"]).toBe(true);
    expect(state["data"]).toBe(false);
    expect(state["tools"]).toBe(false);
    expect(state["about"]).toBe(false);
  });

  it("merges persisted state over defaults", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ data: true }));
    const state = getExpandedState();
    expect(state["risk-lab"]).toBe(true); // default
    expect(state["data"]).toBe(true);     // overridden
    expect(state["tools"]).toBe(false);   // default
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage.setItem(STORAGE_KEY, "not-json");
    const state = getExpandedState();
    expect(state["risk-lab"]).toBe(true); // falls back to defaults
  });
});

describe("setExpandedState", () => {
  it("persists state to localStorage", () => {
    setExpandedState({ "risk-lab": true, data: true, tools: false, about: false });
    const raw = mockStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ "risk-lab": true, data: true, tools: false, about: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/__tests__/use-nav-collapse.test.ts`

Expected: FAIL — module `@/hooks/use-nav-collapse` does not exist.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/use-nav-collapse.ts`:

```ts
"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { NAV_GROUPS, ABOUT_NAV_GROUP, DEFAULT_EXPANDED } from "@/lib/nav-config";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";
import { isRouteActive } from "@/lib/navigation";

export const STORAGE_KEY = "pharos-nav-groups";

/* ── Pure helpers (exported for testing) ──────────────────────── */

export function getExpandedState(): Record<string, boolean> {
  const storage = getWindowStorage("local");
  const raw = safeStorageGetItem(storage, STORAGE_KEY);
  let persisted: Record<string, boolean> = {};
  if (raw) {
    try {
      persisted = JSON.parse(raw);
    } catch {
      // corrupted — ignore
    }
  }
  return { ...DEFAULT_EXPANDED, ...persisted };
}

export function setExpandedState(state: Record<string, boolean>): void {
  safeStorageSetItem(getWindowStorage("local"), STORAGE_KEY, JSON.stringify(state));
}

/* ── Route → group key resolver ──────────────────────────────── */

function findGroupKeyForRoute(pathname: string): string | null {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => isRouteActive(pathname, item.href))) return group.key;
  }
  if (isRouteActive(pathname, ABOUT_NAV_GROUP.href) || ABOUT_NAV_GROUP.children.some((item) => isRouteActive(pathname, item.href))) {
    return "about";
  }
  return null;
}

/* ── React hook ──────────────────────────────────────────────── */

export function useNavCollapse() {
  const pathname = usePathname();
  const [state, setState] = useState(getExpandedState);

  const activeGroupKey = useMemo(() => findGroupKeyForRoute(pathname), [pathname]);

  const isExpanded = useCallback(
    (key: string): boolean => {
      // Active group always shows expanded
      if (key === activeGroupKey) return true;
      return state[key] ?? DEFAULT_EXPANDED[key] ?? false;
    },
    [state, activeGroupKey],
  );

  const toggle = useCallback(
    (key: string) => {
      setState((prev) => {
        const next = { ...prev, [key]: !isExpanded(key) };
        setExpandedState(next);
        return next;
      });
    },
    [isExpanded],
  );

  return { isExpanded, toggle, activeGroupKey };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/__tests__/use-nav-collapse.test.ts`

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-nav-collapse.ts src/hooks/__tests__/use-nav-collapse.test.ts
git commit -m "feat(nav): add useNavCollapse hook with localStorage persistence"
```

---

### Task 3: Desktop sidebar — collapsible groups

**Files:**
- Modify: `src/components/sidebar.tsx`

- [ ] **Step 1: Update imports**

In `src/components/sidebar.tsx`, update the nav-config import:

```ts
// Before:
import { NAV_GROUPS, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";

// After:
import { NAV_GROUPS, ABOUT_NAV_GROUP, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { useNavCollapse } from "@/hooks/use-nav-collapse";
import { ChevronRight } from "lucide-react";
```

- [ ] **Step 2: Add the collapsible group component**

Add a new `SidebarGroup` component above the `Sidebar` component (after `ThemeSidebarItem`):

```tsx
function SidebarGroup({
  groupKey,
  label,
  items,
  expanded: sidebarExpanded,
  isGroupExpanded,
  onToggle,
  pathname,
}: {
  groupKey: string;
  label: string;
  items: NavItem[];
  expanded: boolean;
  isGroupExpanded: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  return (
    <div>
      {sidebarExpanded && (
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-between px-5 pb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65 hover:text-muted-foreground transition-colors"
          aria-expanded={isGroupExpanded}
          aria-controls={`nav-group-${groupKey}`}
        >
          {label}
          <ChevronRight
            className={`h-3 w-3 transition-transform duration-200 ${isGroupExpanded ? "rotate-90" : ""}`}
          />
        </button>
      )}
      {/* Items — always visible in icon mode, collapsible in expanded mode */}
      {(!sidebarExpanded || isGroupExpanded) ? (
        <div id={`nav-group-${groupKey}`} className="space-y-0.5">
          {items.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={sidebarExpanded}
              isActive={isRouteActive(pathname, item.href)}
            />
          ))}
        </div>
      ) : (
        <div className="px-5 text-[11px] italic text-muted-foreground/40">
          {items.length} pages
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the About split-target group component**

Add below `SidebarGroup`:

```tsx
function SidebarAboutGroup({
  expanded: sidebarExpanded,
  isGroupExpanded,
  onToggle,
  pathname,
}: {
  expanded: boolean;
  isGroupExpanded: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  const isAboutActive = isRouteActive(pathname, ABOUT_NAV_GROUP.href);

  return (
    <div>
      {sidebarExpanded ? (
        <div className="flex items-center justify-between px-5 pb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65">
          <Link
            href={ABOUT_NAV_GROUP.href}
            className={`pharos-focus-ring rounded-sm underline underline-offset-3 hover:text-muted-foreground transition-colors ${
              isAboutActive ? "text-foreground" : ""
            }`}
          >
            {ABOUT_NAV_GROUP.label}
          </Link>
          <button
            onClick={onToggle}
            className="pharos-focus-ring rounded-sm p-0.5 hover:text-muted-foreground transition-colors"
            aria-expanded={isGroupExpanded}
            aria-controls="nav-group-about"
            aria-label={isGroupExpanded ? "Collapse About section" : "Expand About section"}
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform duration-200 ${isGroupExpanded ? "rotate-90" : ""}`}
            />
          </button>
        </div>
      ) : (
        <SidebarNavItem
          item={{ href: ABOUT_NAV_GROUP.href, label: ABOUT_NAV_GROUP.label, icon: ABOUT_NAV_GROUP.icon }}
          expanded={false}
          isActive={isAboutActive}
        />
      )}
      {/* Children — always visible in icon mode, collapsible in expanded mode */}
      {(!sidebarExpanded || isGroupExpanded) ? (
        <div id="nav-group-about" className="space-y-0.5">
          {ABOUT_NAV_GROUP.children.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={sidebarExpanded}
              isActive={isRouteActive(pathname, item.href)}
            />
          ))}
        </div>
      ) : (
        <div className="px-5 text-[11px] italic text-muted-foreground/40">
          {ABOUT_NAV_GROUP.children.length} pages
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update the Sidebar component's nav section**

In the `Sidebar` component, add the hook call at the top of the component body (after the existing `useSidebar` and `usePathname` calls):

```tsx
const { isExpanded: isGroupExpanded, toggle } = useNavCollapse();
```

Then replace the `{/* Nav groups */}` section (the `<nav>` element) with:

```tsx
{/* Nav groups */}
<nav className="flex-1 overflow-y-auto py-2 space-y-4" aria-label="Main navigation">
  {/* Dashboard standalone */}
  <div className="space-y-0.5">
    <SidebarNavItem item={DASHBOARD_NAV_ITEM} expanded={expanded} isActive={isRouteActive(pathname, DASHBOARD_NAV_ITEM.href)} />
  </div>
  {NAV_GROUPS.map((group) => (
    <SidebarGroup
      key={group.key}
      groupKey={group.key}
      label={group.label}
      items={group.items}
      expanded={expanded}
      isGroupExpanded={isGroupExpanded(group.key)}
      onToggle={() => toggle(group.key)}
      pathname={pathname}
    />
  ))}
</nav>
```

- [ ] **Step 5: Move About group to the bottom section**

In the `{/* Bottom section */}` div, add the About group before the social links:

```tsx
{/* Bottom section */}
<div className="shrink-0 border-t border-border/65 bg-muted/15 py-2 space-y-0.5">
  <SidebarAboutGroup
    expanded={expanded}
    isGroupExpanded={isGroupExpanded("about")}
    onToggle={() => toggle("about")}
    pathname={pathname}
  />
  {BOTTOM_NAV_ITEMS.map((item) => (
    <SidebarNavItem
      key={item.href}
      item={item}
      expanded={expanded}
      isActive={isRouteActive(pathname, item.href)}
    />
  ))}
  <SidebarSocialLinks expanded={expanded} />
  <ThemeSidebarItem expanded={expanded} />
  {/* pin/unpin button unchanged */}
```

- [ ] **Step 6: Add `isRouteActive` import**

Add at the top of `sidebar.tsx` (if not already imported — it's already there via `@/lib/navigation`):

```ts
import { isRouteActive } from "@/lib/navigation";
```

- [ ] **Step 7: Verify build and test locally**

Run: `npx tsc --noEmit 2>&1 | grep sidebar || echo "no sidebar errors"`

Then start the dev server (`npm run dev`) and verify:
1. Risk Lab is expanded by default, Data/Tools/About are collapsed
2. Clicking a group header toggles expand/collapse
3. The chevron rotates on toggle
4. Collapsed groups show "N pages" hint
5. About label links to `/about`, chevron toggles children
6. Navigating to a Data page auto-expands the Data group
7. Icon-only sidebar (unpinned) still shows all icons

- [ ] **Step 8: Commit**

```bash
git add src/components/sidebar.tsx
git commit -m "feat(nav): add collapsible groups to desktop sidebar"
```

---

### Task 4: Mobile drawer — collapsible groups

**Files:**
- Modify: `src/components/header.tsx`

- [ ] **Step 1: Update imports**

```ts
// Before:
import { NAV_GROUPS, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";

// After:
import { NAV_GROUPS, ABOUT_NAV_GROUP, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { useNavCollapse } from "@/hooks/use-nav-collapse";
import { ChevronRight } from "lucide-react";
import { isRouteActive } from "@/lib/navigation";
```

- [ ] **Step 2: Add the hook inside the `Header` component**

After the existing `const [open, setOpen] = useState(false);` line:

```tsx
const { isExpanded: isGroupExpanded, toggle } = useNavCollapse();
```

- [ ] **Step 3: Replace the grouped sections in the mobile drawer**

Replace the `{/* Grouped sections */}` block (the `NAV_GROUPS.map(...)` section) with:

```tsx
{/* Grouped sections */}
{NAV_GROUPS.map((group, groupIndex) => {
  const groupIsActive = group.items.some((item) => isRouteActive(pathname, item.href));
  const groupExpanded = isGroupExpanded(group.key);
  return (
    <div
      key={group.key}
      className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
        groupIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
      }`}
      style={{ animationDelay: `${(groupIndex + 1) * 50}ms`, animationDuration: "200ms" }}
    >
      <button
        onClick={() => toggle(group.key)}
        className="flex w-full items-center justify-between mb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65 hover:text-muted-foreground transition-colors"
        aria-expanded={groupExpanded}
      >
        {group.label}
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${groupExpanded ? "rotate-90" : ""}`}
        />
      </button>
      {groupExpanded ? (
        group.items.map((item) => (
          <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
        ))
      ) : (
        <div className="px-3 py-2 text-xs italic text-muted-foreground/40">
          {group.items.length} pages
        </div>
      )}
    </div>
  );
})}

{/* About group — separate link + expansion row */}
<div
  className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
    isRouteActive(pathname, ABOUT_NAV_GROUP.href) || ABOUT_NAV_GROUP.children.some((c) => isRouteActive(pathname, c.href))
      ? "border-l-2 border-l-frost-blue pl-3"
      : "pl-[14px]"
  }`}
  style={{ animationDelay: `${(NAV_GROUPS.length + 1) * 50}ms`, animationDuration: "200ms" }}
>
  <MobileNavLink
    item={{ href: ABOUT_NAV_GROUP.href, label: ABOUT_NAV_GROUP.label, icon: ABOUT_NAV_GROUP.icon, description: ABOUT_NAV_GROUP.description }}
    active={isRouteActive(pathname, ABOUT_NAV_GROUP.href)}
    onNavigate={() => setOpen(false)}
  />
  <button
    onClick={() => toggle("about")}
    className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
    aria-expanded={isGroupExpanded("about")}
  >
    <span>Methodology, API, Changelog…</span>
    <ChevronRight
      className={`h-3 w-3 transition-transform duration-200 ${isGroupExpanded("about") ? "rotate-90" : ""}`}
    />
  </button>
  {isGroupExpanded("about") && (
    <div className="ml-2">
      {ABOUT_NAV_GROUP.children.map((item) => (
        <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 4: Remove the old `isRouteActive` import if it's a duplicate**

The file already imports `isRouteActive` from `@/lib/navigation` (added in step 1). Make sure there's no duplicate.

- [ ] **Step 5: Verify build and test locally**

Run: `npx tsc --noEmit 2>&1 | grep header || echo "no header errors"`

Then test on a narrow viewport (Chrome DevTools mobile):
1. Open the hamburger menu
2. Risk Lab is expanded, Data/Tools/About are collapsed
3. Group headers toggle on tap
4. "N pages" hint shows on collapsed groups
5. About row navigates to `/about`, separate "Methodology, API, Changelog…" row expands children
6. All touch targets ≥44px

- [ ] **Step 6: Commit**

```bash
git add src/components/header.tsx
git commit -m "feat(nav): add collapsible groups to mobile drawer"
```

---

### Task 5: Height animation for smooth expand/collapse

**Files:**
- Modify: `src/components/sidebar.tsx`
- Modify: `src/components/header.tsx`

The current implementation shows/hides groups instantly. This task adds smooth height transitions using CSS `grid-template-rows` animation (the modern CSS-only approach that avoids measuring DOM height).

- [ ] **Step 1: Add the animated wrapper to `SidebarGroup`**

In `SidebarGroup`, replace the conditional items/hint rendering with an animated wrapper:

```tsx
{sidebarExpanded && (
  <div
    className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${
      isGroupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
    }`}
  >
    <div className="overflow-hidden">
      <div id={`nav-group-${groupKey}`} className="space-y-0.5">
        {items.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            expanded={sidebarExpanded}
            isActive={isRouteActive(pathname, item.href)}
          />
        ))}
      </div>
    </div>
  </div>
)}
{sidebarExpanded && !isGroupExpanded && (
  <div className="px-5 text-[11px] italic text-muted-foreground/40">
    {items.length} pages
  </div>
)}
{/* Icon-only mode: always show icons */}
{!sidebarExpanded && (
  <div className="space-y-0.5">
    {items.map((item) => (
      <SidebarNavItem
        key={item.href}
        item={item}
        expanded={false}
        isActive={isRouteActive(pathname, item.href)}
      />
    ))}
  </div>
)}
```

- [ ] **Step 2: Apply the same animation to `SidebarAboutGroup` children**

In `SidebarAboutGroup`, replace the conditional children/hint rendering with the same grid-rows wrapper:

```tsx
      {sidebarExpanded && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${
            isGroupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div id="nav-group-about" className="space-y-0.5">
              {ABOUT_NAV_GROUP.children.map((item) => (
                <SidebarNavItem
                  key={item.href}
                  item={item}
                  expanded={sidebarExpanded}
                  isActive={isRouteActive(pathname, item.href)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {sidebarExpanded && !isGroupExpanded && (
        <div className="px-5 text-[11px] italic text-muted-foreground/40">
          {ABOUT_NAV_GROUP.children.length} pages
        </div>
      )}
      {!sidebarExpanded && (
        <div className="space-y-0.5">
          {ABOUT_NAV_GROUP.children.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={false}
              isActive={isRouteActive(pathname, item.href)}
            />
          ))}
        </div>
      )}
```

- [ ] **Step 3: Apply animation to mobile drawer groups**

In `header.tsx`, wrap the mobile group items and About children in the same `grid-rows` animated wrapper. For each `NAV_GROUPS` entry, replace the conditional rendering:

```tsx
{/* Replace the groupExpanded ternary with: */}
<div
  className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${
    groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
  }`}
>
  <div className="overflow-hidden">
    {group.items.map((item) => (
      <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
    ))}
  </div>
</div>
{!groupExpanded && (
  <div className="px-3 py-2 text-xs italic text-muted-foreground/40">
    {group.items.length} pages
  </div>
)}
```

And for the About children section:

```tsx
<div
  className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${
    isGroupExpanded("about") ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
  }`}
>
  <div className="overflow-hidden ml-2">
    {ABOUT_NAV_GROUP.children.map((item) => (
      <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
    ))}
  </div>
</div>
```

- [ ] **Step 4: Verify visually**

Open the app, toggle groups — expand/collapse should be a smooth 200ms height animation, not an instant show/hide.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar.tsx src/components/header.tsx
git commit -m "feat(nav): add smooth height animation to group expand/collapse"
```

---

### Task 6: Final verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests pass. If any nav-related tests exist that check for "Info" group label or `ABOUT_REFERENCE_ITEMS`, update them.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Fix any warnings introduced by the changes.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: static export succeeds with no errors.

- [ ] **Step 4: Manual QA checklist**

Verify in the running app:

- [ ] Desktop expanded sidebar: Risk Lab expanded, Data/Tools/About collapsed
- [ ] Click Data header → expands with animation, shows 8 items
- [ ] Click Data header again → collapses with animation, shows "8 pages"
- [ ] Navigate to `/depeg` → Data auto-expands
- [ ] Collapse Data manually while on `/depeg` → re-collapses (overrides auto-expand)
- [ ] Refresh page → collapse state persists from localStorage
- [ ] About label → navigates to `/about`
- [ ] About chevron → toggles 5 reference children
- [ ] Navigate to `/methodology` → About auto-expands
- [ ] Icon-only sidebar → all icons visible, no group headers, no collapse behavior
- [ ] Mobile hamburger → same collapse behavior, About has separate expansion row
- [ ] Cmd+K → all pages still searchable in command palette

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "fix(nav): final adjustments from QA pass"
```
