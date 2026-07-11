"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function ReliabilityCopyDiagnostics({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-muted/50"
        aria-label="Copy secret-free reliability diagnostics"
      >
        {status === "copied" ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        {status === "copied" ? "Copied" : "Copy diagnostics"}
      </button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {status === "failed" ? "Copy failed" : null}
      </span>
    </div>
  );
}
