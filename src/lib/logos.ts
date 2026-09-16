import logos from "../../data/logos.json";

export type LogoMap = Record<string, string>;

// Plain object (not a null prototype): it crosses the Server->Client Component
// boundary during prerender, which rejects null-prototype objects. Lookups stay
// guarded through getLogoSrc so inherited keys still cannot leak.
export const logosById: LogoMap = Object.freeze({ ...logos });

export function getLogoSrc(logos: LogoMap, id: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(logos, id)) return undefined;
  const src = logos[id];
  return typeof src === "string" ? src : undefined;
}
