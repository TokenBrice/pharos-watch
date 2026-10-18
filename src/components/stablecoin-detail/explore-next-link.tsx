"use client";

import { ArrowRight } from "lucide-react";
import { IntentLink } from "@/components/intent-link";

/** Keep repeated link markup inside its interactive boundary, not in every route's RSC payload. */
export function ExploreNextLink({ href, label }: { href: string; label: string }) {
  return (
    <IntentLink
      href={href}
      className="pharos-focus-ring group flex min-h-9 items-center justify-between gap-3 rounded-sm py-1.5 text-sm text-foreground/85 transition-colors hover:text-foreground"
    >
      <span className="min-w-0 truncate">{label}</span>
      <ArrowRight
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </IntentLink>
  );
}
