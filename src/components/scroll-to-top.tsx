"use client";

import { useState, useEffect } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > 400);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <Button
      variant="outline"
      size="icon"
      className="fixed right-6 bottom-20 z-50 hidden animate-in fade-in duration-300 border-border/70 bg-background/80 shadow-lg backdrop-blur-sm sm:inline-flex"
      aria-label="Scroll to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <ChevronUp className="h-4 w-4" />
    </Button>
  );
}
