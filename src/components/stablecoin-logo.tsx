"use client";

import Image from "next/image";

interface StablecoinLogoProps {
  src: string | undefined;
  name: string;
  size?: number;
}

export function StablecoinLogo({ src, name, size = 24 }: StablecoinLogoProps) {
  const innerSize = Math.max(size - 6, 12);

  if (!src) {
    return (
      <span
        role="img"
        aria-label={`${name} logo`}
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]"
        style={{ width: size, height: size }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]"
      style={{ width: size, height: size }}
    >
      <Image
        src={src}
        alt={`${name} logo`}
        width={innerSize}
        height={innerSize}
        style={{ width: innerSize, height: innerSize }}
        className="rounded-full object-contain"
        unoptimized
        loading="lazy"
      />
    </span>
  );
}
