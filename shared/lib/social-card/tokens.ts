/**
 * Visual tokens of the lens system (docs/og-images.md). Semantic colours are
 * not defined here: grade families, depeg severity and lifecycle stamps come
 * from the classification authority.
 */
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH } from "../social-preview";

export const CARD_WIDTH = SOCIAL_PREVIEW_WIDTH;
export const CARD_HEIGHT = SOCIAL_PREVIEW_HEIGHT;

/** Hub, dossier, versus and scorecard ground. */
export const DARK = {
  ground: "#0b131b",
  raised: "#111d28",
  line: "#1b2d3c",
  lineStrong: "#2b4153",
  text: "#eef3f5",
  soft: "#c6d3db",
  muted: "#8fa3b1",
  /** Under dark marks that have no disc of their own; a step below text so it never outshines the copy. */
  lightPlate: "#dde5ea",
} as const;

/** Record ground. */
export const PAPER = {
  ground: "#f4f6f7",
  text: "#0f1820",
  muted: "#56646f",
  line: "#d3dbe0",
} as const;

/** Brand accent: lens ticks, focus rings and the scorecard date pill only; never a gradient or a fill behind text. */
export const FROST = "#4bc4de";

/** Copy column of every left-aligned template (x 96-544), clear of the lens bezel (x 555 and right). */
export const COLUMN = { left: 96, width: 448, right: 1104 } as const;
/** The lens sits in Telegram's centre-square crop (x 285-915). */
export const LENS = { cx: 800, cy: 315, r: 205 } as const;

export type SocialCardFace =
  | "display-800"
  | "display-600"
  | "display-400"
  | "mono-500"
  | "mono-700"
  | "serif-500"
  | "serif-italic-400";

export interface SocialCardFontFace {
  /** File under SOCIAL_CARD_FONT_DIR; both runtimes register the same bytes. */
  file: string;
  family: "Bricolage" | "Mono" | "Serif";
  weight: 400 | 500 | 600 | 700 | 800;
  style: "normal" | "italic";
}

export const SOCIAL_CARD_FONT_DIR = "worker/assets/fonts/social-card";

/** A registered local logo under public/; group 1 is the extension. */
export const SOCIAL_CARD_LOGO_PATH = /^\/(?:logos|chains|dexes)\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|svg)$/i;

/** A logo SVG drawn as an image must be self-contained: no script, foreign content, imports or external references. */
export function isTrustedLogoSvg(svg: string): boolean {
  const references = [...svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi), ...svg.matchAll(/url\(\s*["']?([^"')\s]+)/gi)];
  return !/<(?:script|foreignObject)\b|@import/i.test(svg)
    && references.every((reference) => reference[1].startsWith("#") || reference[1].startsWith("data:image/"));
}

/** Static instances of the site's faces, made by `npm run subset:fonts -- --social-card`. */
export const SOCIAL_CARD_FONTS: Readonly<Record<SocialCardFace, SocialCardFontFace>> = {
  "display-800": { file: "BricolageGrotesque-800.ttf", family: "Bricolage", weight: 800, style: "normal" },
  "display-600": { file: "BricolageGrotesque-600.ttf", family: "Bricolage", weight: 600, style: "normal" },
  "display-400": { file: "BricolageGrotesque-400.ttf", family: "Bricolage", weight: 400, style: "normal" },
  "mono-500": { file: "JetBrainsMono-500.ttf", family: "Mono", weight: 500, style: "normal" },
  "mono-700": { file: "JetBrainsMono-700.ttf", family: "Mono", weight: 700, style: "normal" },
  "serif-500": { file: "Newsreader-72pt-500.ttf", family: "Serif", weight: 500, style: "normal" },
  "serif-italic-400": { file: "Newsreader-72pt-Italic-400.ttf", family: "Serif", weight: 400, style: "italic" },
};

/**
 * The drawable range: ASCII, Latin-1 (less the currency sign and soft hyphen
 * Bricolage lacks), – ‘ ’ “ ” … and €. Equal to SOCIAL_CARD_UNICODES in
 * scripts/maintenance/subset-fonts.mjs; anything else would draw a missing-glyph box.
 */
const DRAWABLE = /^[\x20-\x7E -£¥-¬®-ÿ\u2013\u2018\u2019\u201C\u201D\u2026\u20AC]*$/;

/** A spec the lens system cannot draw honestly: over budget, undrawable glyph, or copy that does not fit. */
export class SocialCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialCardError";
  }
}

/** Normalises whitespace as Satori does and maps ₮ to T; throws on an undrawable glyph or empty text. */
export function drawable(text: string, where: string): string {
  const value = text.replaceAll("\u20AE", "T").replace(/\s+/g, " ").trim();
  if (!value) throw new SocialCardError(`${where}: empty text`);
  if (!DRAWABLE.test(value)) {
    const glyphs = [...new Set([...value].filter((character) => !DRAWABLE.test(character)))];
    throw new SocialCardError(`${where}: no glyph for ${glyphs.map((glyph) => `"${glyph}" (U+${glyph.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")})`).join(", ")}`);
  }
  return value;
}
