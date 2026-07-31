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
  // The emblem carries its own disc and paints its own field, so there is no plate or ring
  // here. Theme selection swaps the file via static `dark:` utilities rather than `useTheme()`:
  // this renders in the sticky header on every route, and a JS-driven swap would flash on first
  // paint. Both files are ~1.5 KB and next/image is unoptimized, so rendering the pair is cheap.
  // `alt=""` on both — every consumer sits next to a visible "Pharos" wordmark that carries the name.
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden rounded-full", className)}
      style={{ width: size, height: size }}
    >
      <Image
        src="/pharos-mark-on-light.svg"
        alt=""
        width={size}
        height={size}
        className="rounded-full dark:hidden"
        decoding={priority ? "sync" : "async"}
      />
      <Image
        src="/pharos-mark-on-dark.svg"
        alt=""
        width={size}
        height={size}
        className="hidden rounded-full dark:block"
        decoding={priority ? "sync" : "async"}
      />
    </div>
  );
}
