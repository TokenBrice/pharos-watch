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
        className="pharos-focus-ring fixed right-6 bottom-6 z-50 hidden min-h-11 items-center justify-center gap-2 rounded-full border border-primary/70 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-[transform,background-color,border-color] hover:border-primary/85 hover:bg-primary/92 active:translate-y-[1px] sm:flex"
      >
        <MessageSquarePlus className="h-4 w-4 shrink-0" />
        <span>Feedback</span>
      </button>
      {open && <FeedbackModal open={open} onOpenChange={setOpen} />}
    </>
  );
}
