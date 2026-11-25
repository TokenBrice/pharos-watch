"use client";

import { Check, Link2 } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/**
 * Small copy-link control for a case study article. Copies the current page URL
 * to the clipboard and flips to a confirmed state for two seconds. Client-only:
 * reads `window.location`, which is unavailable at static-export build time.
 */
export function CaseStudyShare() {
  const { copied, copy } = useCopyToClipboard(2000);

  return (
    <button
      type="button"
      onClick={() => void copy(window.location.href)}
      aria-label="Copy link"
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 sm:min-h-9",
        copied && "pharos-control-pill-active",
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
      ) : (
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span aria-hidden="true">{copied ? "Copied" : "Copy link"}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Link copied" : ""}
      </span>
    </button>
  );
}
