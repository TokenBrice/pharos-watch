"use client";

import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GLOSSARY, type GlossaryEntry, type GlossarySlug } from "@/lib/glossary";

interface TermProps {
  slug: GlossarySlug | (string & {});
  children: ReactNode;
}

export function Term({ slug, children }: TermProps) {
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
