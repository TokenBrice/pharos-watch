"use client";

import Image from "next/image";
import { resolveCompactLogoSrc, resolveCompactLogoSrcSet } from "@/lib/logo-variants";

interface StablecoinLogoProps {
  src: string | undefined;
  name: string;
  size?: number;
  loading?: "lazy" | "eager";
}

export function StablecoinLogo({ src, name, size = 24, loading = "lazy" }: StablecoinLogoProps) {
  const innerSize = Math.max(size - 6, 12);
  const effectiveSrc = resolveCompactLogoSrc(src, innerSize);

  if (!effectiveSrc) {
    return (
      <span
        role="img"
        aria-label={`${name} logo`}
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs font-bold text-muted-foreground dark:border-transparent dark:bg-muted dark:ring-1 dark:ring-border/60"
        style={{ width: size, height: size }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    // Dark mode uses a softly lifted neutral backplate + hairline ring so dark-ink
    // transparent marks remain legible without glaring white discs.
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 dark:border-transparent dark:bg-foreground/12 dark:ring-1 dark:ring-border/60"
      style={{ width: size, height: size }}
    >
      <picture>
        <source srcSet={resolveCompactLogoSrcSet(src, innerSize)} />
        <Image
          src={effectiveSrc}
          alt={`${name} logo`}
          width={innerSize}
          height={innerSize}
          style={{ width: innerSize, height: innerSize }}
          className="rounded-full object-contain"
          unoptimized
          loading={loading}
        />
      </picture>
    </span>
  );
}
