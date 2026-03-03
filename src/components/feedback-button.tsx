"use client";

import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";

export function FeedbackButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed right-4 bottom-[max(0.75rem,env(safe-area-inset-bottom))] sm:right-6 sm:bottom-6 z-50 flex items-center justify-center gap-2 rounded-full bg-primary px-3 py-3 sm:px-4 sm:py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl active:scale-95"
      >
        <MessageSquarePlus className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Feedback</span>
      </button>
      <FeedbackModal open={open} onOpenChange={setOpen} />
    </>
  );
}
