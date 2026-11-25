"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocTocHeading {
  id: string;
  text: string;
}

interface DocsTocProps {
  headings: readonly DocTocHeading[];
  children: React.ReactNode;
}

function readStickyHeaderBottomPx(): number {
  if (typeof window === "undefined") return 60;
  const probe = document.documentElement;
  const raw = getComputedStyle(probe).getPropertyValue("--sticky-header-bottom").trim();
  if (!raw) return 60;
  // Resolve calc(...) or rem values against a temporary font-size scale fallback.
  const pxMatch = /^([\d.]+)px$/.exec(raw);
  if (pxMatch) return Number(pxMatch[1]);
  const remMatch = /^([\d.]+)rem$/.exec(raw);
  if (remMatch) {
    const rootFontSize = parseFloat(getComputedStyle(probe).fontSize) || 16;
    return Number(remMatch[1]) * rootFontSize;
  }
  return 60;
}

function isDocumentBottom(): boolean {
  const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  return scrollHeight > window.innerHeight && window.scrollY + window.innerHeight >= scrollHeight - 1;
}

function getHashId(): string {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

/**
 * Scrollspy table of contents for `/docs/[slug]/`.
 *
 * Renders the desktop `<nav aria-label="On this page">` synchronously in SSR
 * HTML with every level-2 heading anchor, while keeping active-section tracking
 * and the sticky mobile section bar inside this small client leaf.
 */
export function DocsToc({ headings, children }: DocsTocProps) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileBarRef = useRef<HTMLDivElement | null>(null);
  const mobileToggleRef = useRef<HTMLButtonElement | null>(null);
  const headingSignature = headings.map((heading) => heading.id).join("|");
  const effectiveActiveId = headings.some((heading) => heading.id === activeId)
    ? activeId
    : (headings[0]?.id ?? "");
  const activeHeading = headings.find((heading) => heading.id === effectiveActiveId) ?? headings[0];

  useEffect(() => {
    const ids = headingSignature ? headingSignature.split("|") : [];
    if (ids.length === 0) return;

    const getAnchors = () =>
      ids
        .map((id) => ({ id, node: document.getElementById(id) }))
        .filter((entry): entry is { id: string; node: HTMLElement } => entry.node !== null);

    let scrollFrame = 0;

    const computeActive = () => {
      const anchors = getAnchors();
      if (anchors.length === 0) return;

      let nextActive = anchors[0];
      if (window.scrollY <= 0) {
        nextActive = anchors[0];
      } else if (isDocumentBottom()) {
        nextActive = anchors[anchors.length - 1];
      } else {
        const mobileRect = mobileBarRef.current?.getBoundingClientRect();
        const mobileHeight = mobileRect && mobileRect.height > 0 ? mobileRect.height : 0;
        const activationLine = readStickyHeaderBottomPx() + mobileHeight + 24;
        for (const anchor of anchors) {
          if (anchor.node.getBoundingClientRect().top <= activationLine) {
            nextActive = anchor;
          }
        }
      }
      if (nextActive) {
        setActiveId(nextActive.id);
      }
    };

    const scheduleCompute = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        computeActive();
      });
    };

    const handleHashChange = () => {
      const hashId = getHashId();
      if (hashId && ids.includes(hashId)) {
        setActiveId(hashId);
      } else {
        scheduleCompute();
      }
    };

    const initialFrame = window.requestAnimationFrame(() => {
      const hashId = getHashId();
      if (hashId && ids.includes(hashId)) {
        setActiveId(hashId);
      } else {
        computeActive();
      }
    });

    window.addEventListener("scroll", scheduleCompute, { passive: true });
    window.addEventListener("resize", scheduleCompute, { passive: true });
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.cancelAnimationFrame(initialFrame);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      window.removeEventListener("scroll", scheduleCompute);
      window.removeEventListener("resize", scheduleCompute);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [headingSignature]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        mobileToggleRef.current?.focus();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (mobileBarRef.current && !mobileBarRef.current.contains(event.target as Node)) {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [mobileOpen]);

  return (
    <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start lg:gap-10 lg:space-y-0">
      <div
        ref={mobileBarRef}
        className="sticky top-[var(--sticky-header-bottom,3.75rem)] z-chrome -mx-4 border-y border-border/60 bg-background/95 px-4 py-2 lg:hidden"
      >
        <button
          ref={mobileToggleRef}
          type="button"
          aria-expanded={mobileOpen}
          aria-controls={mobileOpen ? "docs-mobile-toc-panel" : undefined}
          onClick={() => setMobileOpen((open) => !open)}
          className="pharos-focus-ring flex min-h-10 w-full items-center justify-between gap-3 rounded-md text-left text-xs text-foreground"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-semibold text-muted-foreground">On this page</span>
            <span aria-hidden="true" className="text-muted-foreground">
              &middot;
            </span>
            <span className="truncate font-medium text-foreground">
              {activeHeading?.text ?? headings[0]?.text}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              mobileOpen && "rotate-180",
            )}
          />
        </button>
        {mobileOpen ? (
          <nav
            id="docs-mobile-toc-panel"
            aria-label="On this page (mobile)"
            className="mt-2 max-h-[60dvh] overflow-y-auto overscroll-contain border-t border-border/50 pt-2 pb-1"
          >
            <ol className="space-y-0.5 text-xs">
              {headings.map((heading) => {
                const isActive = heading.id === effectiveActiveId;
                return (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      aria-current={isActive ? "location" : undefined}
                      onClick={() => {
                        setActiveId(heading.id);
                        setMobileOpen(false);
                      }}
                      className={cn(
                        "pharos-focus-ring flex min-h-10 items-center rounded-md px-2.5 py-2 leading-snug transition-colors",
                        isActive
                          ? "bg-muted/60 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/35 hover:text-foreground",
                      )}
                    >
                      {heading.text}
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
      </div>

      {children}

      <aside className="hidden lg:sticky lg:top-[calc(var(--sticky-header-bottom,3.75rem)+1.25rem)] lg:block lg:max-h-[calc(100dvh-var(--sticky-header-bottom,3.75rem)-2.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:border-l lg:border-border/60">
        <nav aria-label="On this page" className="space-y-2.5">
          <p className="pharos-label pl-3.5">On this page</p>
          <ol className="space-y-0.5 text-xs">
            {headings.map((heading) => {
              const isActive = heading.id === effectiveActiveId;
              return (
                <li key={heading.id}>
                  <a
                    href={`#${heading.id}`}
                    aria-current={isActive ? "location" : undefined}
                    onClick={() => setActiveId(heading.id)}
                    className={cn(
                      "pharos-focus-ring block rounded-r-sm py-1.5 leading-snug transition-colors",
                      isActive
                        ? "-ml-px border-l-2 border-foreground/70 pl-3 font-medium text-foreground"
                        : "pl-3.5 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {heading.text}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      </aside>
    </div>
  );
}
