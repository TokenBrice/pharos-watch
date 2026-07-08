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

type Status = "idle" | "loading" | "copied" | "error";

interface ShareButtonProps {
  ogPath: string;
  label?: string;
  iconOnly?: boolean;
}

async function fetchOgBlob(ogPath: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${ogPath}`);
  if (!res.ok) throw new Error(`Failed to fetch OG image: ${res.status}`);
  return res.blob();
}

export function ShareButton({ ogPath, label = "Share", iconOnly = false }: ShareButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [canCopyImage] = useState(() =>
    typeof window !== "undefined" &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator?.clipboard?.write === "function",
  );

  const resetTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const resetStatus = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setStatus("copied");
    } catch (err) {
      console.warn("[share] clipboard write failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
    resetStatus();
  }, [resetStatus]);

  const copyImage = useCallback(async () => {
    setStatus("loading");
    try {
      const blob = await fetchOgBlob(ogPath);
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setStatus("copied");
    } catch (err) {
      console.warn("[share] image copy failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
    resetStatus();
  }, [ogPath, resetStatus]);

  const downloadPng = useCallback(async () => {
    setStatus("loading");
    try {
      const blob = await fetchOgBlob(ogPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pharos-${ogPath.split("/").pop() ?? "card"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus("idle");
    } catch (err) {
      console.warn("[share] download failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
      resetStatus();
    }
  }, [ogPath, resetStatus]);

  const triggerIcon =
    status === "loading" ? (
      <Loader2 className="animate-spin" />
    ) : status === "copied" ? (
      <Check />
    ) : (
      <Share2 />
    );

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
