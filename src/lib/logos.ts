import logos from "../../data/logos.json";

export type LogoMap = Record<string, string>;

export const logosById = Object.freeze(
  Object.assign(Object.create(null) as LogoMap, logos),
);

export function getLogoSrc(logos: LogoMap, id: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(logos, id)) return undefined;
  const src = logos[id];
  return typeof src === "string" ? src : undefined;
}
