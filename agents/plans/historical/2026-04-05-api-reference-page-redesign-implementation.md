# API Reference Page Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the API reference page's horizontal pill nav with a sticky two-column sidebar layout for desktop and a Sheet drawer for mobile, plus method badges and copy buttons on code blocks.

**Architecture:** The page stays a server component that parses `docs/api-reference.md` at build time. We add a `method` field to the parser's subsection type, create three new client components (sidebar, mobile nav, copy button), and restructure the page layout into two zones: full-width onboarding header + two-column reference body.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui Sheet, Vitest + React Testing Library

**Design spec:** `agents/plans/2026-04-05-api-reference-page-redesign.md`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `src/lib/api-reference-doc.ts` | Add `method` field to subsection type, extract HTTP method from `### ` headings |
| Create | `src/components/copy-button.tsx` | Client component: icon button that copies text to clipboard with "Copied!" feedback |
| Create | `src/components/api-reference-sidebar.tsx` | Client component: two-level collapsible TOC with method badges, scrollspy, active state |
| Create | `src/components/api-reference-mobile-nav.tsx` | Client component: sticky bar + Sheet drawer for mobile, shares sidebar content |
| Modify | `src/app/about/api/page.tsx` | Two-zone layout, method badges in endpoint headings, CopyButton in code blocks, remove LongformScrollspyNav |
| Create | `src/components/__tests__/copy-button.test.tsx` | Tests for CopyButton |
| Create | `src/components/__tests__/api-reference-sidebar.test.tsx` | Tests for sidebar rendering and collapse |
| Create | `src/components/__tests__/api-reference-mobile-nav.test.tsx` | Tests for mobile nav rendering |

---

## Task 1: Add `method` field to the API reference parser

**Files:**
- Modify: `src/lib/api-reference-doc.ts:39-47` (subsection type + parser)

- [ ] **Step 1: Add `method` to the subsection type**

In `src/lib/api-reference-doc.ts`, change the subsection type inside `ApiReferenceSection`:

```typescript
// OLD (line 43-47):
  subsections: Array<{
    id: string;
    title: string;
    blocks: MarkdownBlock[];
  }>;

// NEW:
  subsections: Array<{
    id: string;
    title: string;
    method: "GET" | "POST" | null;
    blocks: MarkdownBlock[];
  }>;
```

- [ ] **Step 2: Extract method when parsing `### ` headings**

In the same file, find the `isSubsectionLine` branch inside `parseApiReferenceDocument` (around line 316-325). Update the subsection creation to extract the method:

```typescript
// OLD:
    if (isSubsectionLine(line)) {
      flushBuffer();
      if (!currentSection) continue;
      currentSubsection = {
        id: slugifyHeading(line.slice(4).trim()),
        title: line.slice(4).trim(),
        blocks: [],
      };
      currentSection.subsections.push(currentSubsection);
      continue;
    }

// NEW:
    if (isSubsectionLine(line)) {
      flushBuffer();
      if (!currentSection) continue;
      const rawTitle = line.slice(4).trim();
      const methodMatch = rawTitle.replace(/`/g, "").match(/^(GET|POST)\s+/);
      currentSubsection = {
        id: slugifyHeading(rawTitle),
        title: rawTitle,
        method: methodMatch ? (methodMatch[1] as "GET" | "POST") : null,
        blocks: [],
      };
      currentSection.subsections.push(currentSubsection);
      continue;
    }
```

- [ ] **Step 3: Verify the build passes**

Run: `npm run build 2>&1 | tail -20`

Expected: Build succeeds. The new `method` field is just additive data — nothing consumes it yet.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api-reference-doc.ts
git commit -m "feat(api-ref): add method field to parsed subsection type"
```

---

## Task 2: Create the CopyButton component (TDD)

**Files:**
- Create: `src/components/copy-button.tsx`
- Create: `src/components/__tests__/copy-button.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/copy-button.test.tsx`:

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "@/components/copy-button";

afterEach(cleanup);

const mockWriteText = vi.fn().mockResolvedValue(undefined);

Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

describe("CopyButton", () => {
  afterEach(() => {
    mockWriteText.mockClear();
  });

  it("renders with copy icon by default", () => {
    render(<CopyButton text="hello" />);
    const button = screen.getByRole("button", { name: /copy/i });
    expect(button).toBeTruthy();
  });

  it("copies text to clipboard on click", async () => {
    render(<CopyButton text="test-content" />);
    const button = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(button);
    expect(mockWriteText).toHaveBeenCalledWith("test-content");
  });

  it("shows check icon after successful copy", async () => {
    render(<CopyButton text="hello" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    // After click, aria-label changes to "Copied"
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/copy-button.test.tsx 2>&1 | tail -15`

Expected: FAIL — module `@/components/copy-button` not found.

- [ ] **Step 3: Implement CopyButton**

Create `src/components/copy-button.tsx`:

```typescript
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail — clipboard API may be unavailable
    }
  }, [text]);

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className={cn(
        "pharos-focus-ring inline-flex size-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200",
        copied && "text-emerald-400 hover:text-emerald-400",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/copy-button.test.tsx 2>&1 | tail -15`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/copy-button.tsx src/components/__tests__/copy-button.test.tsx
git commit -m "feat: add CopyButton component with clipboard feedback"
```

---

## Task 3: Create the ApiReferenceSidebar component (TDD)

**Files:**
- Create: `src/components/api-reference-sidebar.tsx`
- Create: `src/components/__tests__/api-reference-sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/api-reference-sidebar.test.tsx`:

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiReferenceSidebar } from "@/components/api-reference-sidebar";

afterEach(cleanup);

const MOCK_SECTIONS = [
  {
    id: "surface-split",
    label: "Surface Split",
    subsections: [],
  },
  {
    id: "public-endpoints",
    label: "Public Endpoints",
    subsections: [
      { id: "get-api-stablecoins", label: "/api/stablecoins", method: "GET" as const },
      { id: "post-api-feedback", label: "/api/feedback", method: "POST" as const },
    ],
  },
  {
    id: "admin-endpoints",
    label: "Admin Endpoints",
    subsections: [
      { id: "get-api-status", label: "/api/status", method: "GET" as const },
    ],
  },
];

describe("ApiReferenceSidebar", () => {
  it("renders all top-level sections", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={() => {}} />);
    expect(screen.getByText("Surface Split")).toBeTruthy();
    expect(screen.getByText("Public Endpoints")).toBeTruthy();
    expect(screen.getByText("Admin Endpoints")).toBeTruthy();
  });

  it("renders method badges for endpoints when group is expanded", () => {
    // Use an activeId inside "public-endpoints" to auto-expand that group
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="get-api-stablecoins" onNavigate={() => {}} />);
    const getBadges = screen.getAllByText("GET");
    const postBadges = screen.getAllByText("POST");
    expect(getBadges.length).toBe(1); // stablecoins (only public group is expanded)
    expect(postBadges.length).toBe(1); // feedback
  });

  it("expands the group containing the active endpoint", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="get-api-status" onNavigate={() => {}} />);
    // Admin Endpoints group should be expanded, showing /api/status
    expect(screen.getByText("/api/status")).toBeTruthy();
  });

  it("calls onNavigate when an item is clicked", () => {
    const onNavigate = vi.fn();
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Surface Split"));
    expect(onNavigate).toHaveBeenCalledWith("surface-split");
  });

  it("toggles group collapse on heading click", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={() => {}} />);
    const publicHeading = screen.getByText("Public Endpoints");
    // Initially collapsed (no subsections visible unless active)
    // Click to expand
    fireEvent.click(publicHeading);
    expect(screen.getByText("/api/stablecoins")).toBeTruthy();
    // Click again to collapse
    fireEvent.click(publicHeading);
    expect(screen.queryByText("/api/stablecoins")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/api-reference-sidebar.test.tsx 2>&1 | tail -15`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ApiReferenceSidebar**

Create `src/components/api-reference-sidebar.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarSubsection {
  id: string;
  label: string;
  method: "GET" | "POST" | null;
}

export interface SidebarSection {
  id: string;
  label: string;
  subsections: SidebarSubsection[];
}

interface ApiReferenceSidebarProps {
  sections: SidebarSection[];
  activeId: string;
  onNavigate: (id: string) => void;
  className?: string;
}

function MethodBadge({ method }: { method: "GET" | "POST" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full border px-1.5 py-px font-mono text-[10px] font-bold leading-tight",
        method === "GET" && "border-emerald-500/25 bg-emerald-500/15 text-emerald-400",
        method === "POST" && "border-amber-500/25 bg-amber-500/15 text-amber-400",
      )}
    >
      {method}
    </span>
  );
}

function findParentSectionId(sections: SidebarSection[], activeId: string): string | null {
  for (const section of sections) {
    if (section.id === activeId) return null;
    if (section.subsections.some((sub) => sub.id === activeId)) return section.id;
  }
  return null;
}

export function ApiReferenceSidebar({ sections, activeId, onNavigate, className }: ApiReferenceSidebarProps) {
  const activeParent = findParentSectionId(sections, activeId);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (activeParent) initial.add(activeParent);
    return initial;
  });

  // Auto-expand the group containing the active item when activeId changes
  useEffect(() => {
    if (activeParent) {
      setExpandedGroups((prev) => {
        if (prev.has(activeParent)) return prev;
        const next = new Set(prev);
        next.add(activeParent);
        return next;
      });
    }
  }, [activeParent]);

  const toggleGroup = (sectionId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  return (
    <nav aria-label="API reference navigation" className={cn("space-y-1 text-sm", className)}>
      <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        API Reference
      </p>
      {sections.map((section) => {
        const hasChildren = section.subsections.length > 0;
        const isExpanded = expandedGroups.has(section.id);
        const isActive = activeId === section.id;

        if (!hasChildren) {
          // Plain link — concept section
          return (
            <button
              key={section.id}
              type="button"
              data-sidebar-id={section.id}
              onClick={() => onNavigate(section.id)}
              className={cn(
                "pharos-focus-ring flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                isActive
                  ? "border-l-2 border-foreground/50 bg-muted/60 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              {section.label}
            </button>
          );
        }

        // Collapsible group — endpoint section
        return (
          <div key={section.id}>
            <button
              type="button"
              onClick={() => toggleGroup(section.id)}
              className={cn(
                "pharos-focus-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors",
                isActive || activeParent === section.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  isExpanded && "rotate-90",
                )}
              />
              {section.label}
            </button>
            {isExpanded && (
              <div className="ml-2 border-l border-border/60 pl-2 pt-1">
                {section.subsections.map((sub) => {
                  const isSubActive = activeId === sub.id;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      data-sidebar-id={sub.id}
                      onClick={() => onNavigate(sub.id)}
                      className={cn(
                        "pharos-focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
                        isSubActive
                          ? "bg-muted/60 text-foreground"
                          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                      )}
                    >
                      {sub.method && <MethodBadge method={sub.method} />}
                      <span className="truncate font-mono text-[12px]">{sub.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/api-reference-sidebar.test.tsx 2>&1 | tail -15`

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/api-reference-sidebar.tsx src/components/__tests__/api-reference-sidebar.test.tsx
git commit -m "feat: add ApiReferenceSidebar with collapsible groups and method badges"
```

---

## Task 4: Create the ApiReferenceMobileNav component (TDD)

**Files:**
- Create: `src/components/api-reference-mobile-nav.tsx`
- Create: `src/components/__tests__/api-reference-mobile-nav.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/api-reference-mobile-nav.test.tsx`:

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiReferenceMobileNav } from "@/components/api-reference-mobile-nav";
import type { SidebarSection } from "@/components/api-reference-sidebar";

// Mock the Sheet components to render inline
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const MOCK_SECTIONS: SidebarSection[] = [
  { id: "surface-split", label: "Surface Split", subsections: [] },
  {
    id: "public-endpoints",
    label: "Public Endpoints",
    subsections: [
      { id: "get-api-stablecoins", label: "/api/stablecoins", method: "GET" },
    ],
  },
];

describe("ApiReferenceMobileNav", () => {
  afterEach(cleanup);

  it("shows the current section label", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="surface-split"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("Surface Split")).toBeTruthy();
  });

  it("shows the parent section label when an endpoint is active", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="get-api-stablecoins"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("Public Endpoints")).toBeTruthy();
  });

  it("renders a menu button", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId=""
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /open.*navigation/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/api-reference-mobile-nav.test.tsx 2>&1 | tail -15`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ApiReferenceMobileNav**

Create `src/components/api-reference-mobile-nav.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ApiReferenceSidebar, type SidebarSection } from "@/components/api-reference-sidebar";

interface ApiReferenceMobileNavProps {
  sections: SidebarSection[];
  activeId: string;
  onNavigate: (id: string) => void;
}

function getActiveLabel(sections: SidebarSection[], activeId: string): string {
  for (const section of sections) {
    if (section.id === activeId) return section.label;
    for (const sub of section.subsections) {
      if (sub.id === activeId) return section.label;
    }
  }
  return sections[0]?.label ?? "API Reference";
}

export function ApiReferenceMobileNav({ sections, activeId, onNavigate }: ApiReferenceMobileNavProps) {
  const [open, setOpen] = useState(false);

  const handleNavigate = (id: string) => {
    setOpen(false);
    onNavigate(id);
  };

  return (
    <div className="sticky top-0 z-30 -mx-4 border-b border-border/60 bg-background px-4 py-2.5 lg:hidden">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Section</p>
          <p className="text-sm font-semibold text-foreground">{getActiveLabel(sections, activeId)}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open API navigation"
          className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-lg border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Menu className="size-4" />
        </button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 overflow-y-auto">
          <SheetHeader>
            <SheetTitle>API Reference</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <ApiReferenceSidebar sections={sections} activeId={activeId} onNavigate={handleNavigate} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/api-reference-mobile-nav.test.tsx 2>&1 | tail -15`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/api-reference-mobile-nav.tsx src/components/__tests__/api-reference-mobile-nav.test.tsx
git commit -m "feat: add ApiReferenceMobileNav with Sheet drawer"
```

---

## Task 5: Create the scrollspy + navigation wrapper

This client component owns the IntersectionObserver, the active-ID state, and the scroll-to-section logic. It wraps the sidebar, mobile nav, and content area.

**Files:**
- Create: `src/components/api-reference-layout.tsx`

- [ ] **Step 1: Implement the layout wrapper**

Create `src/components/api-reference-layout.tsx`:

```typescript
"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ApiReferenceSidebar, type SidebarSection } from "@/components/api-reference-sidebar";
import { ApiReferenceMobileNav } from "@/components/api-reference-mobile-nav";

const SCROLL_OFFSET = 96;

interface ApiReferenceLayoutProps {
  sections: SidebarSection[];
  children: ReactNode;
}

export function ApiReferenceLayout({ sections, children }: ApiReferenceLayoutProps) {
  const allIds = useMemo(
    () => sections.flatMap((s) => [s.id, ...s.subsections.map((sub) => sub.id)]),
    [sections],
  );
  const idSignature = allIds.join("|");
  const [activeId, setActiveId] = useState(allIds[0] ?? "");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const initialHashHandled = useRef(false);

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = window.scrollY + el.getBoundingClientRect().top - SCROLL_OFFSET;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    window.history.pushState(null, "", `#${id}`);
    setActiveId(id);
  }, []);

  // Scrollspy
  useEffect(() => {
    const ids = idSignature.split("|");
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (nodes.length === 0) return;

    // Set scroll-margin-top on all observed elements
    for (const node of nodes) {
      node.style.scrollMarginTop = `${SCROLL_OFFSET}px`;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: [0.05, 0.2, 0.4] },
    );

    for (const node of nodes) observer.observe(node);

    // Handle initial hash
    if (!initialHashHandled.current) {
      initialHashHandled.current = true;
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (hash && ids.includes(hash)) {
        requestAnimationFrame(() => {
          setActiveId(hash);
          const el = document.getElementById(hash);
          if (el) {
            const top = window.scrollY + el.getBoundingClientRect().top - SCROLL_OFFSET;
            window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
          }
        });
      }
    }

    return () => {
      observer.disconnect();
      for (const node of nodes) {
        node.style.scrollMarginTop = "";
      }
    };
  }, [idSignature]);

  // Auto-scroll sidebar to keep active item visible
  useEffect(() => {
    if (!sidebarRef.current) return;
    const activeEl = sidebarRef.current.querySelector(`[data-sidebar-id="${activeId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeId]);

  return (
    <>
      <ApiReferenceMobileNav sections={sections} activeId={activeId} onNavigate={scrollToId} />
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
        <div
          ref={sidebarRef}
          className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:overscroll-contain lg:pb-8 lg:scrollbar-none"
        >
          <ApiReferenceSidebar sections={sections} activeId={activeId} onNavigate={scrollToId} />
        </div>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify the build passes**

Run: `npm run build 2>&1 | tail -20`

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/api-reference-layout.tsx
git commit -m "feat: add ApiReferenceLayout with scrollspy and sidebar scroll-sync"
```

---

## Task 6: Wire everything into the API reference page

**Files:**
- Modify: `src/app/about/api/page.tsx`

This is the largest task. We restructure the page into Zone 1 (full-width, unchanged content) and Zone 2 (two-column with the new layout wrapper).

- [ ] **Step 1: Update imports**

In `src/app/about/api/page.tsx`, replace the `LongformScrollspyNav` import and add the new ones:

```typescript
// REMOVE this import:
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";

// ADD these imports:
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import { ApiReferenceLayout } from "@/components/api-reference-layout";
import type { SidebarSection } from "@/components/api-reference-sidebar";
```

- [ ] **Step 2: Update MarkdownBlockRenderer code block to include CopyButton**

Replace the `block.type === "code"` branch in `MarkdownBlockRenderer` (lines 153-166):

```typescript
  if (block.type === "code") {
    return (
      <div className="overflow-hidden rounded-xl border border-border/60 bg-zinc-950 text-zinc-100 shadow-[0_12px_28px_oklch(0_0_0_/0.18)]">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          {block.language ? (
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              {block.language}
            </span>
          ) : (
            <span />
          )}
          <CopyButton text={block.code} />
        </div>
        <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed">
          <code>{block.code}</code>
        </pre>
      </div>
    );
  }
```

- [ ] **Step 3: Update endpoint heading in SectionRenderer to show method badge + path**

Replace the subsection `<h3>` block inside `SectionRenderer` (lines 224-228):

```typescript
              <h3 className="mb-4 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                {subsection.method ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold leading-tight",
                      subsection.method === "GET" && "border-emerald-500/25 bg-emerald-500/15 text-emerald-400",
                      subsection.method === "POST" && "border-amber-500/25 bg-amber-500/15 text-amber-400",
                    )}
                  >
                    {subsection.method}
                  </span>
                ) : null}
                <code className="font-mono text-[0.92rem]">
                  {stripMarkdownHeadingFormatting(subsection.title).replace(/^(GET|POST)\s+/, "")}
                </code>
              </h3>
```

- [ ] **Step 4: Remove EndpointIndex, the "Endpoint" kicker, and stale scroll-margin classes from SectionRenderer**

Remove the `EndpointIndex` function entirely (lines 171-192) — the sidebar replaces this.

In `SectionRenderer`, remove the `<EndpointIndex section={section} />` call (line 210).

Also remove the "Endpoint" kicker `<div>` from the subsection article (lines 220-223):

```typescript
              // REMOVE these lines from each subsection article:
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <p className="pharos-kicker">Endpoint</p>
                <div className="h-px min-w-12 flex-1 bg-gradient-to-r from-border to-transparent" />
              </div>
```

Remove `scroll-mt-28` from both the `<section>` (line 196) and `<article>` (line 218) elements in `SectionRenderer`. The `ApiReferenceLayout` scrollspy now owns scroll-margin via `SCROLL_OFFSET` set as an inline style, so the Tailwind class is no longer needed and would conflict with it.

- [ ] **Step 5: Restructure the page layout into Zone 1 + Zone 2**

In the `AboutApiPage` component, replace the `navSections` computation and the return JSX. The key changes:

1. Build `sidebarSections` instead of `navSections`
2. Remove `LongformScrollspyNav`
3. Wrap the reference sections in `ApiReferenceLayout`

Replace the `navSections` computation (lines 244-247):

```typescript
  const sidebarSections: SidebarSection[] = document.sections.map((section) => ({
    id: section.id,
    label: stripMarkdownHeadingFormatting(section.title),
    subsections: section.subsections.map((sub) => ({
      id: sub.id,
      label: stripMarkdownHeadingFormatting(sub.title).replace(/^(GET|POST)\s+/, ""),
      method: sub.method,
    })),
  }));
```

In the return JSX, remove the `LongformScrollspyNav` block (the line with `<LongformScrollspyNav ... />`).

Wrap the sections `<div>` in the new `ApiReferenceLayout`:

```typescript
      {/* Zone 2: Two-column reference body */}
      <ApiReferenceLayout sections={sidebarSections}>
        {document.sections.map((section) => (
          <SectionRenderer key={section.id} section={section} />
        ))}
      </ApiReferenceLayout>
```

- [ ] **Step 6: Verify the build passes**

Run: `npm run build 2>&1 | tail -30`

Expected: Build succeeds with no type errors.

- [ ] **Step 7: Verify lint passes**

Run: `npm run lint 2>&1 | tail -20`

Expected: No errors. If the removed `EndpointIndex` function or `LongformScrollspyNav` import triggers unused-import warnings, confirm they are fully removed.

- [ ] **Step 8: Run all tests**

Run: `npm test 2>&1 | tail -30`

Expected: All tests pass, including the 3 new test files from Tasks 2-4.

- [ ] **Step 9: Commit**

```bash
git add src/app/about/api/page.tsx
git commit -m "feat(api-ref): two-column sidebar layout with method badges and copy buttons"
```

---

## Task 7: Visual smoke test and scroll-margin tuning

**Files:** None created — this is a manual verification task with potential tweaks to existing files.

- [ ] **Step 1: Start the dev server and verify desktop layout**

Run: `npm run dev`

Open `http://localhost:3000/about/api/` in a browser at ≥1024px width. Verify:
- Zone 1 (hero, lanes, CTA, intro) renders full-width as before
- Zone 2 shows the sidebar on the left with all 12 sections
- "Public Endpoints" and "Admin Endpoints" groups are collapsible with chevron
- Method badges show green GET / amber POST
- Clicking a sidebar item scrolls to the section and highlights it
- Scrolling updates the active sidebar item
- Code blocks have a copy button in the header bar

- [ ] **Step 2: Verify mobile layout**

Resize browser to <1024px. Verify:
- Sidebar is hidden
- Sticky bar at top of Zone 2 shows current section name + hamburger
- Tapping hamburger opens Sheet drawer from the left
- Drawer contains the full sidebar TOC
- Selecting an item closes the drawer and scrolls to the target

- [ ] **Step 3: Verify deep-linking**

Navigate directly to `http://localhost:3000/about/api/#get-api-stablecoins`. Verify:
- Page scrolls to the correct endpoint
- Sidebar highlights the correct item and its parent group is expanded

- [ ] **Step 4: Tune scroll offset if needed**

If sections land behind the sticky nav bar or too far below, adjust the `SCROLL_OFFSET` constant in `src/components/api-reference-layout.tsx`. It controls both the `scrollMarginTop` inline style and the arithmetic offset in `scrollToId` / initial-hash handling. The value may need to account for the site's global nav height.

- [ ] **Step 5: Run the merge gate**

Run: `npm run test:merge-gate 2>&1 | tail -40`

Expected: Merge gate passes. This validates lint, type-check, tests, and build together.

- [ ] **Step 6: Commit any tuning changes**

```bash
git add -A
git commit -m "fix(api-ref): tune scroll offsets for sidebar layout"
```

Skip this commit if no changes were needed.
