/**
 * Node side of the lens system: loads the tracked fonts and registered logos,
 * validates specs with real font metrics (no Satori) and renders SVG with
 * Satori. PNG rasterisation stays with `renderSvgPngWithResvg`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import satori, { type SatoriOptions } from "satori";
import sharp, { type Sharp } from "sharp";
import type { SocialCardAssets, SocialCardElement, SocialCardLogo } from "../../shared/lib/social-card/parts";
import type { SocialCardIdentity, SocialCardSpec, SocialScorecardCard } from "../../shared/lib/social-card/spec";
import type { SocialScorecardOverviewCard } from "../../shared/lib/social-card/scorecard";
import { buildSocialCardElement, buildSocialScorecardElement, buildSocialScorecardOverviewElement, normalizeSocialCardSpec } from "../../shared/lib/social-card/templates";
import { createSocialCardMeasurer, type HarfBuzzApi } from "../../shared/lib/social-card/text";
import { CARD_HEIGHT, CARD_WIDTH, SOCIAL_CARD_FONT_DIR, SOCIAL_CARD_FONTS, SOCIAL_CARD_LOGO_PATH, isTrustedLogoSvg, type SocialCardFace } from "../../shared/lib/social-card/tokens";

/**
 * Every file whose bytes reach a rendered card apart from the spec's own logos:
 * the templates, the authorities they read (colours, grade families, canvas
 * size), the inlined brand marks and the fonts.
 */
export const SOCIAL_CARD_RENDER_SOURCES = [
  "scripts/lib/social-card-render.ts",
  "shared/lib/social-card/brand.ts",
  "shared/lib/social-card/parts.ts",
  "shared/lib/social-card/spec.ts",
  "shared/lib/social-card/templates.ts",
  "shared/lib/social-card/text.ts",
  "shared/lib/social-card/tokens.ts",
  "shared/lib/classification.ts",
  "shared/lib/classification/domain.ts",
  "shared/lib/classification/grades.ts",
  "shared/lib/report-card-core.ts",
  "shared/lib/format.ts",
  "shared/lib/social-preview.ts",
  ...Object.values(SOCIAL_CARD_FONTS).map(({ file }) => `${SOCIAL_CARD_FONT_DIR}/${file}`),
] as const;

export interface SocialCardRenderAssets extends SocialCardAssets {
  fonts: SatoriOptions["fonts"];
  /** The same TTF bytes, for resvg; Satori already outlines every glyph. */
  fontBuffers: Uint8Array[];
}

/** Rasters are normalised to this square; the largest drawn logo is 216px. */
const LOGO_SIZE = 384;

function admitSvg(svg: string, path: string): string {
  if (!isTrustedLogoSvg(svg)) throw new Error(`Social card logo has an external or executable resource: ${path}`);
  return svg;
}

const pngUri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** A dark mark whose rim is mostly transparent has no disc of its own and would vanish on the dark plate. */
async function needsLightPlate(source: Sharp): Promise<boolean> {
  const { data } = await source.resize(64, 64, { fit: "contain", background: TRANSPARENT }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let rim = 0;
  let rimOpaque = 0;
  let opaque = 0;
  let luminance = 0;
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const distance = Math.hypot(x - 31.5, y - 31.5);
      if (distance > 31) continue;
      const index = (y * 64 + x) * 4;
      const solid = data[index + 3] > 127;
      if (distance > 27) {
        rim += 1;
        if (solid) rimOpaque += 1;
      }
      if (solid) {
        opaque += 1;
        luminance += (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
      }
    }
  }
  return opaque > 0 && rimOpaque / rim < 0.5 && luminance / opaque < 0.5;
}

/** Admits one registered logo: rasters normalised to square PNG (resvg cannot decode every format), SVG checked and kept. */
async function readLogo(repoRoot: string, path: string, grey: boolean): Promise<SocialCardLogo> {
  const match = SOCIAL_CARD_LOGO_PATH.exec(path);
  if (!match) throw new Error(`Social card logo must be a registered local image: ${path}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(repoRoot, `public${path}`));
  } catch (cause) {
    throw new Error(`Social card logo bytes are missing: public${path}`, { cause });
  }
  const isSvg = match[1].toLowerCase() === "svg";
  if (isSvg) admitSvg(bytes.toString("utf8"), path);
  const decode = () => sharp(bytes, isSvg ? { density: 288 } : {}).rotate();
  const square = (source: Sharp) => source.resize(LOGO_SIZE, LOGO_SIZE, { fit: "contain", background: TRANSPARENT });
  try {
    const color = isSvg ? svgDataUri(bytes.toString("utf8")) : pngUri(await square(decode()).png().toBuffer());
    const lightPlate = await needsLightPlate(decode());
    const logo: SocialCardLogo = lightPlate ? { color, lightPlate } : { color };
    // Historical records fade to a compressed mid-grey, like an archived print, whatever the original contrast.
    return grey ? { ...logo, grey: pngUri(await square(decode()).grayscale().linear(0.55, 18).png().toBuffer()) } : logo;
  } catch (cause) {
    throw new Error(`Social card logo could not be decoded: ${path}`, { cause });
  }
}

export const identitiesOf = (spec: SocialCardSpec | SocialScorecardCard): readonly SocialCardIdentity[] => {
  if (!("template" in spec)) return [spec.identity];
  switch (spec.template) {
    case "dossier": return [spec.identity];
    case "versus": return [spec.left, spec.right];
    case "record": return spec.identity ? [spec.identity] : [];
    case "hub": {
      const subject = spec.subject;
      if (subject.kind === "cluster") return subject.members;
      if (subject.kind === "orbit") return [subject.center, ...subject.members];
      if (subject.kind === "peg-ruler") return subject.lows.map((low) => low.identity);
      return [];
    }
  }
};

/** Fonts, HarfBuzz metrics and every logo the specs draw (greyscale where a historical record needs it). */
export async function loadSocialCardAssets(repoRoot: string, specs: readonly (SocialCardSpec | SocialScorecardCard)[]): Promise<SocialCardRenderAssets> {
  const faces = Object.keys(SOCIAL_CARD_FONTS) as SocialCardFace[];
  const bytes = Object.fromEntries(faces.map((face) => [face, readFileSync(resolve(repoRoot, SOCIAL_CARD_FONT_DIR, SOCIAL_CARD_FONTS[face].file))])) as Record<SocialCardFace, Buffer>;
  // harfbuzzjs ships no types; its default export is a promise of the API Satori shapes with.
  const hb = await (createRequire(import.meta.url)("harfbuzzjs") as Promise<HarfBuzzApi>);
  const greyPaths = new Set(specs.flatMap((spec) => "template" in spec && spec.template === "dossier" && spec.lifecycle === "historical" && spec.identity.logoPath ? [spec.identity.logoPath] : []));
  const paths = [...new Set(specs.flatMap((spec) => identitiesOf(spec).flatMap((identity) => identity.logoPath ? [identity.logoPath] : [])))].sort();
  const logos = new Map(await Promise.all(paths.map(async (path) => [path, await readLogo(repoRoot, path, greyPaths.has(path))] as const)));
  return {
    measure: createSocialCardMeasurer(hb, bytes),
    logos,
    fonts: faces.map((face) => ({ name: SOCIAL_CARD_FONTS[face].family, data: bytes[face], weight: SOCIAL_CARD_FONTS[face].weight, style: SOCIAL_CARD_FONTS[face].style })),
    fontBuffers: faces.map((face) => new Uint8Array(bytes[face])),
  };
}

/**
 * Budgets, glyph range and structure; with `assets`, also the real-metric fit
 * and logo admission. No Satori, so it is cheap enough for every spec.
 * Throws a SocialCardError naming the spec path and field.
 */
export function validateSocialCardSpec(spec: SocialCardSpec, assets?: SocialCardAssets): void {
  if (assets) buildSocialCardElement(spec, assets);
  else normalizeSocialCardSpec(spec);
}

const toSvg = (element: SocialCardElement, assets: SocialCardRenderAssets) =>
  satori(element as unknown as Parameters<typeof satori>[0], { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: assets.fonts });

export function renderSocialCardSvg(spec: SocialCardSpec, assets: SocialCardRenderAssets): Promise<string> {
  return toSvg(buildSocialCardElement(spec, assets), assets);
}

/** A coin or overview scorecard; production renders these in the Worker, this is for review and tests. */
export function renderSocialScorecardSvg(card: SocialScorecardCard | SocialScorecardOverviewCard, assets: SocialCardRenderAssets): Promise<string> {
  return toSvg("identity" in card ? buildSocialScorecardElement(card, assets) : buildSocialScorecardOverviewElement(card, assets), assets);
}
