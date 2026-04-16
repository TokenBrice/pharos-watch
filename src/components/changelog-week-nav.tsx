"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDateRange } from "@/components/changelog-entry-card";

interface ChangelogWeekNavProps {
  entries: { dateRange: { from: string; to: string } }[];
}

export function ChangelogWeekNav({ entries }: ChangelogWeekNavProps) {
  const sectionSignature = entries.map((e) => e.dateRange.to).join("|");
  const [activeId, setActiveId] = useState(entries[0]?.dateRange.to ?? "");

  useEffect(() => {
    const ids = sectionSignature.split("|").filter(Boolean);
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const visibleIds = new Set<string>();

    const observer = new IntersectionObserver(
      (observerEntries) => {
        for (const entry of observerEntries) {
          if (entry.isIntersecting) {
            visibleIds.add(entry.target.id);
          } else {
            visibleIds.delete(entry.target.id);
          }
        }

        for (const id of ids) {
          if (visibleIds.has(id)) {
            setActiveId(id);
            return;
          }
        }
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0.05, 0.2] },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sectionSignature]);

  return (
    <div className="relative">
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent sm:hidden"
        aria-hidden
      />
      <nav
        aria-label="Jump to release"
        className="overflow-x-auto scrollbar-none -mx-1 px-1 text-xs font-mono"
      >
        <div className="flex min-w-max items-center gap-1.5">
          <span className="shrink-0 text-xs font-medium text-muted-foreground pl-1">Jump to:</span>
          {entries.map((entry, i) => {
            const id = entry.dateRange.to;
            const isActive = activeId === id;
            const isLatest = i === 0;

            return (
              <a
                key={id}
                href={`#${id}`}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "pharos-focus-ring flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2.5 sm:py-1.5 transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full transition-colors",
                    isActive
                      ? "bg-frost-blue shadow-[0_0_0_3px_oklch(0.72_0.14_248/0.10)]"
                      : "border border-border/80 bg-transparent",
                  )}
                  aria-hidden
                />
                {formatDateRange(entry.dateRange.from, entry.dateRange.to, {
                  compact: true,
                })}
                {isLatest && (
                  <span className="inline-flex items-center rounded-full bg-frost-blue/15 px-2 py-0.5 text-[10px] font-sans font-semibold uppercase tracking-wider text-frost-blue">
                    Latest
                  </span>
                )}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
