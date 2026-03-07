"use client";

import { useEffect, useState } from "react";
import { ChevronUp, MessageSquarePlus } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
import { cn } from "@/lib/utils";

export function MobileUtilityDock() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    function onScroll() {
      setShowScrollTop(window.scrollY > 400);
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(0.875rem,env(safe-area-inset-bottom))] z-50 flex justify-end px-4 sm:hidden">
        <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/92 p-1 shadow-[0_14px_38px_oklch(0_0_0_/0.28)] backdrop-blur-md">
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            aria-label="Send feedback"
            className="pharos-focus-ring flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_18px_oklch(0_0_0_/0.22)]"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="Scroll to top"
            aria-hidden={!showScrollTop}
            tabIndex={showScrollTop ? 0 : -1}
            className={cn(
              "pharos-focus-ring flex size-11 items-center justify-center rounded-full border border-border/70 bg-card/92 text-muted-foreground transition-[opacity,transform,color,background-color,border-color] duration-200",
              showScrollTop ? "opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
            )}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}
