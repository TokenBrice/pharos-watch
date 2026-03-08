"use client";

import { useState, useCallback, useEffect } from "react";
import { Check, Download, Image, Link, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

async function fetchOgBlob(ogPath: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${ogPath}`);
  if (!res.ok) throw new Error(`Failed to fetch OG image: ${res.status}`);
  return res.blob();
}

export function ShareButton({ ogPath, label = "Share" }: ShareButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [canCopyImage, setCanCopyImage] = useState(false);

  useEffect(() => {
    // ClipboardItem with image/png is not supported in all browsers (e.g. Firefox).
    // Detect support at mount time and conditionally show the option.
    setCanCopyImage(
      typeof window !== "undefined" &&
        typeof ClipboardItem !== "undefined" &&
        typeof navigator?.clipboard?.write === "function",
    );
  }, []);

  const resetStatus = useCallback(() => {
    setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setStatus("copied");
    } catch {
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
    } catch {
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
      URL.revokeObjectURL(url);
      setStatus("idle");
    } catch {
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
        <Button variant="outline" size="sm" disabled={status === "loading"}>
          {triggerIcon}
          <span>{triggerLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink}>
          <Link />
          Copy link
        </DropdownMenuItem>
        {canCopyImage && (
          <DropdownMenuItem onSelect={copyImage}>
            <Image />
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
