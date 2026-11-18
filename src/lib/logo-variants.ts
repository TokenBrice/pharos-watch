import MAP from "./logo-variants.generated.json";

type CompactSize = 32 | 56 | 100;

/** Per collection ("/logos", "/chains"): its variant sizes and the source file names that have them. */
const COLLECTIONS = new Map(Object.entries(MAP as Record<string, { sizes: CompactSize[]; sources: string[] }>)
  .map(([prefix, { sizes, sources }]) => [prefix, { sizes, sources: new Set(sources) }]));

/**
 * A source logo's compact derivatives by pixel size, or undefined when it has none. Paths follow
 * `generate-compact-logos`: `<dir>/compact/<base>.webp` for the small size, `<base>-100.webp` for 100 px.
 */
export function compactLogoVariants(src: string): Partial<Record<CompactSize, string>> | undefined {
  const slash = src.lastIndexOf("/");
  const dir = src.slice(0, slash);
  const name = src.slice(slash + 1);
  const collection = COLLECTIONS.get(dir);
  if (!collection?.sources.has(name)) return undefined;
  const base = name.slice(0, name.lastIndexOf("."));
  return Object.fromEntries(collection.sizes.map((size) => [size, `${dir}/compact/${base}${size === 100 ? "-100" : ""}.webp`]));
}

export function resolveCompactLogoSrc(src: string | undefined, size: number): string | undefined {
  if (!src) return src;
  const variants = compactLogoVariants(src);
  if (!variants) return src;
  if (size <= 24 && variants[32]) return variants[32];
  if (size <= 28 && variants[56]) return variants[56];
  if (size <= 50 && variants[100]) return variants[100];
  return src;
}

/** Browser-selected density candidates; never upscale a derivative beyond its pixels. */
export function resolveCompactLogoSrcSet(src: string | undefined, size: number): string | undefined {
  const variants = src ? compactLogoVariants(src) : undefined;
  if (!src || !variants) return undefined;
  return [1, 2, 3].map((density) => {
    const pixels = size * density;
    const width = ([32, 56, 100] as const).find((candidate) => candidate >= pixels && variants[candidate]);
    return `${width ? variants[width] : src} ${density}x`;
  }).join(", ");
}
