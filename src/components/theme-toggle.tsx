"use client";

import { useCallback } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThemeToggle } from "@/hooks/use-theme-toggle";

// M17 — wrap the theme swap in a View Transition so the cross-dissolve
// happens as a single coordinated 220ms cross-fade across the viewport
// instead of an uncoordinated stutter of per-element transitions. Falls
// through to the bare toggle when the API is unavailable (Safari, FF).
function withViewTransition(run: () => void): void {
  if (typeof document === "undefined") {
    run();
    return;
  }
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(run);
    return;
  }
  run();
}

export function ThemeToggle() {
  const { mounted, isDark, label, toggleTheme } = useThemeToggle();

  const handleToggle = useCallback(() => {
    withViewTransition(toggleTheme);
  }, [toggleTheme]);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-9 w-9">
        <span className="sr-only">Display theme</span>
      </Button>
    );
  }

  return (
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleToggle} aria-label={label}>
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
