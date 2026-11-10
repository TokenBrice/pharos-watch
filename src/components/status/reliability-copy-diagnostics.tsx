"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { RequestSequence, isRequestCancellation } from "@/lib/request";

export function ReliabilityCopyDiagnostics({ text }: { text: string }) {
  const [outcome, setOutcome] = useState<{ text: string; status: "copied" | "failed" } | null>(null);
  const [pending, setPending] = useState(false);
  const requests = useRef(new RequestSequence());
  const status = outcome?.text === text ? outcome.status : "idle";

  useEffect(() => () => requests.current.cancel(), [text]);

  const copy = async () => {
    if (pending) return;
    setPending(true);
    setOutcome(null);
    try {
      const result = await requests.current.run(() => copyText(text));
      setOutcome({ text, status: result.ok ? "copied" : "failed" });
    } catch (error) {
      if (!isRequestCancellation(error)) setOutcome({ text, status: "failed" });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-disabled={pending}
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
