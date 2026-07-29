"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
] as const;

const THEME_CONTROL_VARIANTS = {
  desktop: {
    container: "flex items-center gap-1 px-1.5 py-1",
    activeButton: "inline-flex size-8 items-center justify-center rounded-md transition-colors bg-muted text-foreground",
    inactiveButton:
      "inline-flex size-8 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-muted/40 hover:text-foreground",
  },
  mobile: {
    container: "flex items-center gap-1",
    activeButton:
      "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors bg-muted text-foreground",
    inactiveButton:
      "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-muted/40 hover:text-foreground",
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
    <div className={variant.container}>
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            aria-label={`${option.label} theme`}
            aria-pressed={active}
            className={active ? variant.activeButton : variant.inactiveButton}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
