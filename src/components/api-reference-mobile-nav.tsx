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
      if (sub.id === activeId) return sub.label;
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
