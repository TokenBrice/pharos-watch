"use client";

import Image from "next/image";

interface StablecoinLogoProps {
  src: string | undefined;
  name: string;
  size?: number;
}

export function StablecoinLogo({ src, name, size = 24 }: StablecoinLogoProps) {
  if (!src) {
    // Fallback: colored circle with first letter
    return (
      <div
        role="img"
        aria-label={`${name} logo`}
        className="flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground"
        style={{ width: size, height: size }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={`${name} logo`}
      width={size}
      height={size}
      className="flex-shrink-0 rounded-full"
      unoptimized
    />
  );
}
