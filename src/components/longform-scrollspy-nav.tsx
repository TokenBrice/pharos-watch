"use client";

import type { ReactNode } from "react";
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
}

function getScrollOffset(railNode: HTMLDivElement | null) {
  const railRect = railNode?.getBoundingClientRect();
  if (!railRect) return 16;
  return Math.ceil(railRect.height + Math.max(railRect.top, 0) + 16);
}

function scrollToSection(sectionId: string, railNode: HTMLDivElement | null) {
  const sectionNode = document.getElementById(sectionId);
  if (!sectionNode) return;

  const nextTop = window.scrollY + sectionNode.getBoundingClientRect().top - getScrollOffset(railNode);
  window.history.pushState(null, "", `#${sectionId}`);
  window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
}

export function LongformScrollspyNav({
  sections,
  railLabel = "Jump to Section",
  navAriaLabel,
  rightSlot,
  className,
}: LongformScrollspyNavProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const railRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollSyncRef = useRef<number[]>([]);
  const effectiveActiveId = sections.some((section) => section.id === activeId) ? activeId : (sections[0]?.id ?? "");

  const scheduleSectionAlignment = (sectionId: string) => {
    for (const timer of pendingScrollSyncRef.current) {
      window.clearTimeout(timer);
    }
    pendingScrollSyncRef.current = [];

    scrollToSection(sectionId, railRef.current);

    for (const delay of [160, 480, 960]) {
      const timer = window.setTimeout(() => {
        if (window.location.hash.replace(/^#/, "") === sectionId) {
          scrollToSection(sectionId, railRef.current);
        }
      }, delay);
      pendingScrollSyncRef.current.push(timer);
    }
  };

  useEffect(() => {
    const railNode = railRef.current;
    const sectionNodes = sections
      .map((section) => document.getElementById(section.id))
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

    const activeHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (activeHash.length > 0 && sectionNodes.some((node) => node.id === activeHash)) {
      requestAnimationFrame(() => {
        applyScrollMargins();
        setActiveId(activeHash);
        for (const timer of pendingScrollSyncRef.current) {
          window.clearTimeout(timer);
        }
        pendingScrollSyncRef.current = [];
        scrollToSection(activeHash, railNode);
        for (const delay of [160, 480, 960]) {
          const timer = window.setTimeout(() => {
            if (window.location.hash.replace(/^#/, "") === activeHash) {
              scrollToSection(activeHash, railNode);
            }
          }, delay);
          pendingScrollSyncRef.current.push(timer);
        }
      });
    }

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", applyScrollMargins);
      for (const timer of pendingScrollSyncRef.current) {
        window.clearTimeout(timer);
      }
      pendingScrollSyncRef.current = [];
      for (const node of sectionNodes) {
        node.style.scrollMarginTop = "";
      }
    };
  }, [sections]);

  if (sections.length === 0) return null;

  return (
    <div
      ref={railRef}
      className={cn(
        "sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 -mx-4 rounded-2xl border border-border/60 bg-background/95 px-4 py-3 shadow-[0_16px_40px_oklch(0_0_0_/0.12)] backdrop-blur supports-[backdrop-filter]:bg-background/85 md:top-0",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <p className="pharos-kicker">{railLabel}</p>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {sections.find((section) => section.id === effectiveActiveId)?.label}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground sm:hidden">Swipe to jump</span>
        </div>
        {rightSlot}
      </div>
      <nav aria-label={navAriaLabel} className="scroll-shadow mt-3 overflow-x-auto pb-1 scrollbar-none">
        <div className="flex min-w-max snap-x snap-mandatory items-center gap-2 pr-4 sm:pr-0">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={(event) => {
                event.preventDefault();
                scheduleSectionAlignment(section.id);
                setActiveId(section.id);
              }}
              className={cn(
                "pharos-focus-ring inline-flex min-h-11 shrink-0 snap-start items-center whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition-colors md:min-h-9 md:px-3.5",
                effectiveActiveId === section.id
                  ? "border-foreground/35 bg-muted text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground",
              )}
            >
              {section.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}
