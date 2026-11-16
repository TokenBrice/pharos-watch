"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export function ScrollToTop() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [scrollingUp, setScrollingUp] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    function onScroll() {
      const y = window.scrollY;
      // Below lg the button sits over the reading column: like the phone
      // dock, it surfaces only when the reader turns back up.
      if (y < lastScrollY.current - 4) setScrollingUp(true);
      else if (y > lastScrollY.current + 4) setScrollingUp(false);
      lastScrollY.current = y;
      setVisible(y > 400);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const prefersReducedMotion = usePrefersReducedMotion();

  if (!visible || pathname === "/") return null;

  return (
    <Button
      variant="outline"
      size="icon"
      // Stacked above FeedbackButton in the page gutter (see feedback-button.tsx);
      // below lg both clear the bottom tab bar instead of straddling its edge.
      className={cn(
        "fixed right-1 bottom-[calc(var(--mobile-bottom-nav-safe-height)+3rem)] z-chrome hidden size-8 animate-in fade-in duration-300 border-border/70 bg-background/90 shadow-sm backdrop-blur-sm lg:bottom-12",
        scrollingUp ? "sm:inline-flex" : "lg:inline-flex",
      )}
      aria-label="Scroll to top"
      title="Scroll to top"
      onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" })}
    >
      <ChevronUp className="h-4 w-4" />
    </Button>
  );
}
