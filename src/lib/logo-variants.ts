import MAP from "./logo-variants.generated.json";

const COMPACT_LOGO_SRC_BY_CANONICAL_SRC: Record<string, string> = MAP;

export function resolveCompactLogoSrc(src: string | undefined, size: number): string | undefined {
  if (!src || size > 24) return src;
  return COMPACT_LOGO_SRC_BY_CANONICAL_SRC[src] ?? src;
}
