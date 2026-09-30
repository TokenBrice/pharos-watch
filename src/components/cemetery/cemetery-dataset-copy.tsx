"use client";

import { Check, Copy } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** Copies the dataset citation and announces success politely. */
export function CemeteryDatasetCopyCitation({ citation }: { citation: string }) {
  const { copied, copy } = useCopyToClipboard(2000);
  const Icon = copied ? Check : Copy;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void copy(citation)}
        className={buttonVariants({ variant: "outline", size: "sm", className: "pharos-focus-ring" })}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        Copy citation
      </button>
      <span role="status" aria-live="polite" className="pharos-meta">
        {copied ? "Citation copied." : ""}
      </span>
    </div>
  );
}
