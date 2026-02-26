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

  // Scroll the active tab into view within the horizontal nav
  useEffect(() => {
    const btn = tabRefs.current.get(activeId);
    if (btn && navRef.current) {
      btn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
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
      className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border overflow-x-auto scrollbar-none"
    >
      <div className="flex gap-1 p-1.5">
        {sections.map((section) => (
          <button
            key={section.id}
            ref={(el) => {
              if (el) tabRefs.current.set(section.id, el);
            }}
            onClick={() => handleClick(section.id)}
            className={cn(
              "px-3 py-2 text-sm font-medium whitespace-nowrap rounded-lg transition-colors",
              activeId === section.id
                ? "text-foreground bg-muted"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            {section.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
