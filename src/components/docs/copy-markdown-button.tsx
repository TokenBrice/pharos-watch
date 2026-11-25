"use client";

import { useCallback, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyMarkdownButtonProps {
  markdownHref: string;
  className?: string;
}

/**
 * Fetches the route's published plain-Markdown twin on demand and copies it to
 * the clipboard without inflating the static HTML payload with a second copy.
 */
export function CopyMarkdownButton({ markdownHref, className }: CopyMarkdownButtonProps) {
  const { copied, copy } = useCopyToClipboard(2000);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const cachedRef = useRef<{ href: string; body: string } | null>(null);

  const handleCopy = useCallback(async () => {
    setStatus("loading");
    try {
      let markdown = cachedRef.current?.href === markdownHref ? cachedRef.current.body : null;
      if (markdown === null) {
        const response = await fetch(markdownHref, { headers: { Accept: "text/markdown, text/plain" } });
        if (!response.ok) {
          throw new Error(`Failed to fetch markdown (${response.status})`);
        }
        markdown = await response.text();
        cachedRef.current = { href: markdownHref, body: markdown };
      }
      await copy(markdown);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }, [copy, markdownHref]);

  const Icon = copied ? Check : Copy;
  const label = copied
    ? "Copied Markdown"
    : status === "loading"
      ? "Copying..."
      : status === "error"
        ? "Copy failed"
        : "Copy Markdown";

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={status === "loading"}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted/40 hover:text-foreground disabled:opacity-60",
        copied && "text-state-positive hover:text-state-positive",
        status === "error" && "text-state-danger hover:text-state-danger",
        className,
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </button>
  );
}
