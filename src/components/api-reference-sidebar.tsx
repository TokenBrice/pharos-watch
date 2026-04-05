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
