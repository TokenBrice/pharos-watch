"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface SectionNavProps {
  sections: { id: string; label: string }[];
}

export function DetailSectionNav({ sections }: SectionNavProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const navRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Scroll the nav horizontally to show the active tab (without affecting page scroll)
  useEffect(() => {
    const btn = tabRefs.current.get(activeId);
    const nav = navRef.current;
    if (btn && nav) {
      const navRect = nav.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const btnCenter = btnRect.left + btnRect.width / 2;
      const navCenter = navRect.left + navRect.width / 2;
      nav.scrollBy({ left: btnCenter - navCenter, behavior: "smooth" });
    }
  }, [activeId]);

  // IntersectionObserver to detect which section is in the upper 30% of viewport
  useEffect(() => {
    const elements = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );

    for (const el of elements) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections]);

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <nav
      ref={navRef}
      aria-label="Section navigation"
      className="sticky top-14 md:top-0 z-20 bg-card/95 backdrop-blur overflow-x-auto scrollbar-none relative"
    >
      <p className="px-3 pt-1 text-[11px] text-muted-foreground/70 sm:hidden">Swipe for more sections</p>
      <div className="flex gap-0.5 p-1">
        {sections.map((section) => (
          <button
            key={section.id}
            ref={(el) => {
              if (el) tabRefs.current.set(section.id, el);
            }}
            onClick={() => handleClick(section.id)}
            className={cn(
              "px-3 py-2 h-11 text-sm font-medium whitespace-nowrap rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              activeId === section.id
                ? "text-foreground bg-muted border-b-2 border-foreground/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            {section.label}
          </button>
        ))}
      </div>
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent sm:hidden" />
    </nav>
  );
}
