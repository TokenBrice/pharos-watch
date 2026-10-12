"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

export function ScrollToTop() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > 400);
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
      // Stacked above FeedbackButton in the page gutter (see feedback-button.tsx).
      className="fixed right-1 bottom-12 z-chrome hidden size-8 animate-in fade-in duration-300 border-border/70 bg-background/90 shadow-sm backdrop-blur-sm sm:inline-flex"
      aria-label="Scroll to top"
      title="Scroll to top"
      onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" })}
    >
      <ChevronUp className="h-4 w-4" />
    </Button>
  );
}
