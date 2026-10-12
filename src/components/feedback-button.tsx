"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquarePlus } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal-lazy";

/** Routes without the floating feedback entry. `/api/` keeps key requests off the public-GitHub feedback modal. */
export function isFeedbackHiddenPath(pathname: string | null): boolean {
  return pathname === "/" || pathname === "/api" || pathname === "/api/";
}

export function FeedbackButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (isFeedbackHiddenPath(pathname)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="pharos-focus-ring fixed right-4 bottom-4 z-50 hidden h-8 items-center justify-center gap-1.5 rounded-md border border-border/70 bg-background/90 px-2.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:border-border hover:bg-card hover:text-foreground sm:flex"
      >
        <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>Feedback</span>
      </button>
      {open && <FeedbackModal open={open} onOpenChange={setOpen} />}
    </>
  );
}
