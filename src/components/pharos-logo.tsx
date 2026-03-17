"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";

interface PharosLogoProps {
  size?: number;
  className?: string;
  priority?: boolean;
}

/**
 * Standardized Pharos logo component.
 * Ensures consistent treatment across all surfaces.
 */
export function PharosLogo({ size = 32, className, priority = false }: PharosLogoProps) {
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg ring-1 ring-border/60",
        "bg-slate-900/90 dark:bg-transparent",
        className
      )}
      style={{ width: size, height: size }}
    >
      <Image
        src="/pharos-icon.png"
        alt="Pharos"
        width={size}
        height={size}
        className="rounded-lg"
        priority={priority}
      />
    </div>
  );
}

/**
 * Pharos logo with text lockup for headers.
 */
export function PharosLogoWithText({ 
  size = 32, 
  className,
  textClassName,
  priority = false,
}: PharosLogoProps & { textClassName?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <PharosLogo size={size} priority={priority} />
      <span 
        className={cn(
          "font-mono text-[1.05rem] font-semibold uppercase tracking-[0.18em]",
          textClassName
        )}
      >
        PHAROS
      </span>
    </div>
  );
}
