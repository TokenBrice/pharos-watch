"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function ScoringBreakdownDisclosure({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9">
        <span className="underline decoration-dashed underline-offset-2">Scoring breakdown</span>
        <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
      </summary>
      {children}
    </details>
  );
}
