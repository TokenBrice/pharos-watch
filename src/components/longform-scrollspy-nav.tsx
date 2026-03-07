"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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

export function LongformScrollspyNav({
  sections,
  railLabel = "Jump to Section",
  navAriaLabel,
  rightSlot,
  className,
}: LongformScrollspyNavProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const effectiveActiveId = sections.some((section) => section.id === activeId)
    ? activeId
    : (sections[0]?.id ?? "");

  useEffect(() => {
    const sectionNodes = sections
      .map((section) => document.getElementById(section.id))
      .filter((node): node is HTMLElement => node !== null);

    if (sectionNodes.length === 0) return;

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

    return () => observer.disconnect();
  }, [sections]);

  if (sections.length === 0) return null;

  return (
    <div
      className={cn(
        "sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 -mx-4 border-y border-border/60 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:top-0",
        className,
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{railLabel}</p>
        {rightSlot}
      </div>
      <nav aria-label={navAriaLabel} className="mt-2 overflow-x-auto scrollbar-none">
        <div className="flex min-w-max items-center gap-2">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={() => setActiveId(section.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                effectiveActiveId === section.id
                  ? "border-foreground/40 bg-muted text-foreground"
                  : "border-border/60 bg-background text-foreground hover:border-foreground/30 hover:bg-muted",
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
