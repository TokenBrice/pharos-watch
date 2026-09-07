"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Check, Download, ImageIcon, Link, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { API_BASE } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { triggerBlobDownload } from "@/lib/exports/download";
import { RequestSequence, isRequestCancellation, requestBlob } from "@/lib/request";

type Status = "idle" | "loading" | "copied" | "error";

interface ShareButtonProps {
  ogPath: string;
  label?: string;
  iconOnly?: boolean;
}

async function fetchOgBlob(ogPath: string, signal: AbortSignal): Promise<Blob> {
  return requestBlob(`${API_BASE}${ogPath}`, { signal, timeoutMs: 15_000 });
}

export function ShareButton({ ogPath, label = "Share", iconOnly = false }: ShareButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [canCopyImage] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator?.clipboard?.write === "function",
  );

  const resetTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const requestSequence = useRef(new RequestSequence());

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      requestSequence.current.cancel();
    },
    [],
  );

  const resetStatus = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const copyLink = useCallback(async () => {
    const result = await copyText(window.location.href);
    if (result.ok) {
      setStatus("copied");
    } else {
      console.warn("[share] clipboard write failed:", result.reason);
      setStatus("error");
    }
    resetStatus();
  }, [resetStatus]);

  const copyImage = useCallback(async () => {
    setStatus("loading");
    try {
      const blob = await requestSequence.current.run((signal) => fetchOgBlob(ogPath, signal));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("copied");
    } catch (err) {
      if (isRequestCancellation(err)) return;
      console.warn("[share] image copy failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
    resetStatus();
  }, [ogPath, resetStatus]);

  const downloadPng = useCallback(async () => {
    setStatus("loading");
    try {
      const blob = await requestSequence.current.run((signal) => fetchOgBlob(ogPath, signal));
      triggerBlobDownload(blob, `pharos-${ogPath.split("/").pop() ?? "card"}.png`);
      setStatus("idle");
    } catch (err) {
      if (isRequestCancellation(err)) return;
      console.warn("[share] download failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
      resetStatus();
    }
  }, [ogPath, resetStatus]);

  const triggerIcon =
    status === "loading" ? <Loader2 className="animate-spin" /> : status === "copied" ? <Check /> : <Share2 />;

  const triggerLabel = status === "copied" ? "Copied!" : status === "error" ? "Failed" : label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={status === "loading"}
          aria-label={triggerLabel}
          className={cn(
            "min-h-11 rounded-full px-4 lg:min-h-9 lg:rounded-md",
            iconOnly && "size-8 min-h-0 rounded-md px-0 lg:min-h-0",
          )}
        >
          {triggerIcon}
          {iconOnly ? <span className="sr-only">{triggerLabel}</span> : <span>{triggerLabel}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink}>
          <Link />
          Copy link
        </DropdownMenuItem>
        {canCopyImage && (
          <DropdownMenuItem onSelect={copyImage}>
            <ImageIcon />
            Copy as image
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={downloadPng}>
          <Download />
          Download PNG
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
