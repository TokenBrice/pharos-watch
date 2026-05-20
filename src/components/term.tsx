"use client";

import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MethodologyHint } from "@/components/methodology-hint";
import { GLOSSARY, type GlossaryEntry, type GlossarySlug } from "@/lib/glossary";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";

interface TermProps {
  slug: GlossarySlug | MethodologyContextKey | (string & {});
  children: ReactNode;
}

export function Term({ slug, children }: TermProps) {
  // 1. Pharos-specific path: route through the methodology-hint surface, but
  //    with the inline dotted-underline trigger rather than the CircleHelp icon.
  if (slug in METHODOLOGY_CONTEXT) {
    return (
      <MethodologyHint topic={slug as MethodologyContextKey}>{children}</MethodologyHint>
    );
  }

  // 2. DeFi jargon path: existing Popover.
  const entry = (GLOSSARY as Record<string, GlossaryEntry>)[slug];
  if (!entry) return <>{children}</>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="pharos-focus-ring inline underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground data-[state=open]:decoration-foreground"
          aria-label={`Definition: ${entry.term}`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-xs border-border/70 text-sm">
        <p className="mb-1 font-semibold">{entry.term}</p>
        <p className="leading-relaxed text-muted-foreground">{entry.short}</p>
        {entry.longHref ? (
          <a
            href={entry.longHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-frost-blue hover:underline"
          >
            Learn more →
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
