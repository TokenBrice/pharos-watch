"use client";

import type { MutableRefObject, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface LongformSection {
  id: string;
  label: string;
}

interface LongformScrollspyNavProps {
  sections: readonly LongformSection[];
  railLabel?: string;
  navAriaLabel: string;
  rightSlot?: ReactNode;
  className?: string;
  /** Show a subtle gradient fade below the nav hinting at content below */
  showDepthHint?: boolean;
}

function getScrollOffset(railNode: HTMLDivElement | null) {
  const railRect = railNode?.getBoundingClientRect();
  if (!railRect) return 16;
  return Math.ceil(railRect.height + Math.max(railRect.top, 0) + 16);
}

function getHashSectionId() {
  return decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

function scrollToSection(sectionId: string, railNode: HTMLDivElement | null) {
  const sectionNode = document.getElementById(sectionId);
  if (!sectionNode) return;

  const nextTop = window.scrollY + sectionNode.getBoundingClientRect().top - getScrollOffset(railNode);
  window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
}

function clearPendingScrollSync(pendingScrollSyncRef: MutableRefObject<number[]>) {
  for (const timer of pendingScrollSyncRef.current) {
    window.clearTimeout(timer);
  }
  pendingScrollSyncRef.current = [];
}

function scheduleSectionAlignment(
  sectionId: string,
  railNode: HTMLDivElement | null,
  pendingScrollSyncRef: MutableRefObject<number[]>,
  updateHash: boolean,
) {
  clearPendingScrollSync(pendingScrollSyncRef);
  if (updateHash) {
    window.history.pushState(null, "", `#${sectionId}`);
  }
  scrollToSection(sectionId, railNode);

  for (const delay of [160, 480, 960]) {
    const timer = window.setTimeout(() => {
      if (getHashSectionId() === sectionId) {
        scrollToSection(sectionId, railNode);
      }
    }, delay);
    pendingScrollSyncRef.current.push(timer);
  }
}

export function LongformScrollspyNav({
  sections,
  railLabel = "Jump to",
  navAriaLabel,
  rightSlot,
  className,
  showDepthHint,
}: LongformScrollspyNavProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const railRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollSyncRef = useRef<number[]>([]);
  const initialHashHandledRef = useRef(false);
  const effectiveActiveId = sections.some((section) => section.id === activeId) ? activeId : (sections[0]?.id ?? "");
  const sectionSignature = sections.map((section) => section.id).join("|");

  useEffect(() => {
    const railNode = railRef.current;
    const sectionIds = sectionSignature.length > 0 ? sectionSignature.split("|") : [];
    const sectionNodes = sectionIds
      .map((sectionId) => document.getElementById(sectionId))
      .filter((node): node is HTMLElement => node !== null);

    if (!railNode || sectionNodes.length === 0) return;

    const applyScrollMargins = () => {
      const scrollMarginTop = getScrollOffset(railNode);
      for (const node of sectionNodes) {
        node.style.scrollMarginTop = `${scrollMarginTop}px`;
      }
    };

    applyScrollMargins();

    const resizeObserver = new ResizeObserver(() => {
      applyScrollMargins();
    });
    resizeObserver.observe(railNode);
    window.addEventListener("resize", applyScrollMargins);

    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (inView[0]) {
          setActiveId(inView[0].target.id);
        }
      },
      {
        rootMargin: "-20% 0px -65% 0px",
        threshold: [0.05, 0.2, 0.4, 0.7],
      },
    );

    for (const node of sectionNodes) {
      observer.observe(node);
    }

    const activeHash = getHashSectionId();
    if (!initialHashHandledRef.current) {
      initialHashHandledRef.current = true;
      if (activeHash.length > 0 && sectionNodes.some((node) => node.id === activeHash)) {
        requestAnimationFrame(() => {
          applyScrollMargins();
          setActiveId(activeHash);
          scheduleSectionAlignment(activeHash, railNode, pendingScrollSyncRef, false);
        });
      }
    }

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", applyScrollMargins);
      clearPendingScrollSync(pendingScrollSyncRef);
      for (const node of sectionNodes) {
        node.style.scrollMarginTop = "";
      }
    };
  }, [sectionSignature]);

  if (sections.length === 0) return null;

  return (
    <>
      <div
        ref={railRef}
        className={cn(
          "sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 -mx-4 rounded-xl border border-border/60 bg-background px-3 py-2 shadow-[0_8px_24px_oklch(0_0_0_/0.1)] md:top-0 md:rounded-2xl md:px-4 md:py-2.5",
          className,
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 text-xs font-medium text-muted-foreground">
              <span className="hidden sm:inline">{railLabel ?? "Jump to Section"}</span>
              <span className="sm:hidden">Sections:</span>
            </p>
          </div>
          {rightSlot && <div className="hidden sm:block">{rightSlot}</div>}
        </div>
        <div className="relative">
          {/* Fade mask hints at off-screen content */}
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background to-transparent sm:hidden" aria-hidden="true" />
        <nav aria-label={navAriaLabel} className="overflow-x-auto pb-0.5 scrollbar-none -mx-1 px-1">
          <div className="flex min-w-max snap-x snap-mandatory items-center gap-1.5">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  scheduleSectionAlignment(section.id, railRef.current, pendingScrollSyncRef, true);
                  setActiveId(section.id);
                }}
                className={cn(
                  "pharos-focus-ring inline-flex min-h-9 shrink-0 snap-start items-center whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors md:min-h-8 md:text-sm",
                  effectiveActiveId === section.id
                    ? "border-foreground/35 bg-muted text-foreground"
                    : "border-border/60 bg-background/80 text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground",
                )}
              >
                {section.label}
              </a>
            ))}
          </div>
        </nav>
        </div>
      </div>
      {showDepthHint && (
        <div
          className="pointer-events-none h-6 bg-gradient-to-b from-border/20 to-transparent motion-safe:animate-[pharos-fade-in-up_0.6s_ease-out_0.3s_both]"
          aria-hidden="true"
        />
      )}
    </>
  );
}
