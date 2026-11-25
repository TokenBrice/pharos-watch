"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyThemeWithTransition } from "@/hooks/use-theme-toggle";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
] as const;

// Icon plus a visible label: three bare glyphs (moon/sun/monitor) left
// "System" to guesswork.
const THEME_CONTROL_VARIANTS = {
  desktop: {
    container: "flex items-center gap-1 p-0.5",
    activeButton:
      "pharos-focus-ring inline-flex min-w-14 cursor-pointer flex-col items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-xs font-medium text-foreground ring-1 ring-border/60 transition-colors dark:bg-card dark:ring-border/80",
    inactiveButton:
      "pharos-focus-ring inline-flex min-w-14 cursor-pointer flex-col items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
  },
  mobile: {
    container: "flex items-center gap-1",
    activeButton:
      "pharos-focus-ring inline-flex min-h-11 min-w-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md bg-muted px-2 text-xs font-medium leading-none text-foreground ring-1 ring-border/60 transition-colors dark:bg-card dark:ring-border/80",
    inactiveButton:
      "pharos-focus-ring inline-flex min-h-11 min-w-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md px-2 text-xs leading-none text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
  },
} as const;

export function ThemeControls({ density }: { density: keyof typeof THEME_CONTROL_VARIANTS }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const variant = THEME_CONTROL_VARIANTS[density];

  useEffect(() => {
    // next-themes: only read the selected theme after mount so the active
    // highlight doesn't cause a hydration mismatch. One-shot, empty deps.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  return (
    <div role="group" aria-label="Theme" className={variant.container}>
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => applyThemeWithTransition(() => setTheme(option.value))}
            aria-label={`${option.label} theme`}
            aria-pressed={active}
            className={active ? variant.activeButton : variant.inactiveButton}
          >
            <Icon className="size-4" aria-hidden />
            <span aria-hidden>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
