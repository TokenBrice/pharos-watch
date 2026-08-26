"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { copyText } from "@/lib/clipboard";

/**
 * Small copy-link control for a case study article. Copies the current page URL
 * to the clipboard and flips to a confirmed state for a moment. Client-only:
 * reads `window.location`, which is unavailable at static-export build time.
 */
export function CaseStudyShare() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (typeof window === "undefined") return;
    const result = await copyText(window.location.href);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy link"
      className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-frost-blue/60 hover:text-frost-blue"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Copy link
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Link copied" : ""}
      </span>
    </button>
  );
}
