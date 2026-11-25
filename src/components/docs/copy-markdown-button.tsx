"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyMarkdownButtonProps {
  markdownHref: string;
  className?: string;
}

/**
 * Fetches the route's published plain-Markdown twin on demand and copies it to
 * the clipboard without inflating the static HTML payload with a second copy.
 * Prefetches on hover/focus so click-time clipboard writes stay inside Safari's
 * synchronous user-activation window, uses `aria-disabled` to preserve keyboard
 * focus, and surfaces clipboard failures explicitly.
 */
export function CopyMarkdownButton({ markdownHref, className }: CopyMarkdownButtonProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "copied" | "error">("idle");
  const cachedRef = useRef<{ href: string; body: string } | null>(null);
  const inflightRef = useRef<Promise<string> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const loadMarkdown = useCallback(async (): Promise<string> => {
    if (cachedRef.current?.href === markdownHref) {
      return cachedRef.current.body;
    }
    if (!inflightRef.current) {
      inflightRef.current = fetch(markdownHref, {
        headers: { Accept: "text/markdown, text/plain" },
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Failed to fetch markdown (${response.status})`);
          }
          const body = await response.text();
          cachedRef.current = { href: markdownHref, body };
          return body;
        })
        .finally(() => {
          inflightRef.current = null;
        });
    }
    return inflightRef.current;
  }, [markdownHref]);

  const prefetchMarkdown = useCallback(() => {
    if (cachedRef.current?.href === markdownHref || inflightRef.current) return;
    void loadMarkdown().catch(() => {
      // Prefetch errors stay silent; click handler reports failures explicitly.
    });
  }, [loadMarkdown, markdownHref]);

  const handleCopy = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("loading");
    try {
      const markdown =
        cachedRef.current?.href === markdownHref
          ? cachedRef.current.body
          : await loadMarkdown();
      const result = await copyText(markdown);
      if (!result.ok) {
        setStatus("error");
        return;
      }
      setStatus("copied");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
    } finally {
      busyRef.current = false;
    }
  }, [loadMarkdown, markdownHref]);

  const copied = status === "copied";
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
      onPointerEnter={prefetchMarkdown}
      onFocus={prefetchMarkdown}
      onClick={() => void handleCopy()}
      aria-disabled={status === "loading" || undefined}
      className={cn(
        "pharos-control-pill pharos-focus-ring min-h-11 gap-1.5 sm:min-h-9",
        status === "loading" && "cursor-wait opacity-70",
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
