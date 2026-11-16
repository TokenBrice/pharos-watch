"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronUp, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { FeedbackModal } from "@/components/feedback-modal-lazy";
import { isFeedbackHiddenPath } from "@/components/feedback-button";

export function MobileUtilityDock() {
  const pathname = usePathname();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [scrollingUp, setScrollingUp] = useState(false);
  const lastScrollY = useRef(0);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    function onScroll() {
      const y = window.scrollY;
      // Back-to-top surfaces when the reader turns back up, so the pill
      // never parks over the content they are reading on the way down.
      if (y < lastScrollY.current - 4) setScrollingUp(true);
      else if (y > lastScrollY.current + 4) setScrollingUp(false);
      lastScrollY.current = y;
      setShowFeedback(y > 24);
      setShowScrollTop(y > 400);
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (pathname === "/") return null;
  // A stablecoin dossier carries its own "Report a data issue" action in the
  // identity header, so its reading column stays clear of the feedback pill.
  const dossierRoute = pathname?.startsWith("/stablecoin/") === true;
  const feedbackEnabled = !isFeedbackHiddenPath(pathname) && !dossierRoute;
  const scrollTopVisible = showScrollTop && scrollingUp;
  const showDock = scrollTopVisible || (feedbackEnabled && showFeedback);

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 bottom-[calc(var(--mobile-bottom-nav-safe-height)+0.875rem)] z-chrome flex max-w-[100vw] justify-end overflow-x-clip px-4 sm:hidden",
          showDock
            ? "pointer-events-none visible translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-4 opacity-0",
          !prefersReducedMotion && "transition-[opacity,transform] duration-300 ease-out",
        )}
        style={{
          transitionTimingFunction: showDock ? "cubic-bezier(0.0, 0.0, 0.2, 1)" : "cubic-bezier(0.4, 0.0, 1, 1)",
        }}
      >
        <div
          className={cn(
            "pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background p-1",
          )}
        >
          {feedbackEnabled ? (
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              aria-label="Send feedback"
              tabIndex={showFeedback ? undefined : -1}
              className="pharos-focus-ring flex size-11 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors hover:text-foreground"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" })}
            aria-label="Scroll to top"
            tabIndex={scrollTopVisible ? undefined : -1}
            className={cn(
              "pharos-focus-ring flex size-11 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-[opacity,transform,color,background-color,border-color] duration-200",
              scrollTopVisible ? "opacity-100" : "invisible pointer-events-none -translate-y-1 opacity-0",
            )}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      {feedbackEnabled && feedbackOpen && <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />}
    </>
  );
}
