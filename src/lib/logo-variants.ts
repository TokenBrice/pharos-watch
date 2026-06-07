const COMPACT_LOGO_SRC_BY_CANONICAL_SRC: Record<string, string> = {
  "/logos/nxusd-nereus.png": "/logos/compact/nxusd-nereus.webp",
  "/logos/wbrl-ripio.png": "/logos/compact/wbrl-ripio.webp",
  "/logos/wmxn-ripio.png": "/logos/compact/wmxn-ripio.webp",
  "/logos/zarm-mento.png": "/logos/compact/zarm-mento.webp",
};

export function resolveCompactLogoSrc(src: string | undefined, size: number): string | undefined {
  if (!src || size > 24) return src;
  return COMPACT_LOGO_SRC_BY_CANONICAL_SRC[src] ?? src;
}
