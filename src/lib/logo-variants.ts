import MAP from "./logo-variants.generated.json";

const LOGO_VARIANTS: Record<string, Partial<Record<32 | 56 | 100, string>>> = MAP;

export function resolveCompactLogoSrc(src: string | undefined, size: number): string | undefined {
  if (!src) return src;
  const variants = LOGO_VARIANTS[src];
  if (!variants) return src;
  if (size <= 24 && variants[32]) return variants[32];
  if (size <= 28 && variants[56]) return variants[56];
  if (size <= 50 && variants[100]) return variants[100];
  return src;
}

/** Browser-selected density candidates; never upscale a derivative beyond its pixels. */
export function resolveCompactLogoSrcSet(src: string | undefined, size: number): string | undefined {
  if (!src || !LOGO_VARIANTS[src]) return undefined;
  const variants = LOGO_VARIANTS[src];
  return [1, 2, 3].map((density) => {
    const pixels = size * density;
    const width = ([32, 56, 100] as const).find((candidate) => candidate >= pixels && variants[candidate]);
    return `${width ? variants[width] : src} ${density}x`;
  }).join(", ");
}
