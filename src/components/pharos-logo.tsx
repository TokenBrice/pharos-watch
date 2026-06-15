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
        src="/pharos-icon.svg"
        alt="Pharos"
        width={size}
        height={size}
        className="rounded-lg"
        decoding={priority ? "sync" : "async"}
      />
    </div>
  );
}
