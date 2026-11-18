/**
 * Drawing parts shared by the templates, as plain Satori element objects.
 * Text is always a Satori text node: text inside a nested SVG image never renders.
 */
import { PHAROS_MARK_ON_DARK_SVG, PHAROS_MARK_ON_LIGHT_SVG } from "./brand";
import type { SocialCardGlyph } from "./spec";
import { fitBlock, type FittedBlock, type SocialCardMeasurer } from "./text";
import { DARK, FROST, PAPER, SOCIAL_CARD_FONTS, SocialCardError, type SocialCardFace } from "./tokens";

export interface SocialCardElement {
  type: string;
  props: Record<string, unknown>;
}
type Child = SocialCardElement | string | null | undefined | false;
export type Style = Record<string, string | number>;

/** Registered logo bytes as data URIs: `color` always, `grey` for historical records. */
export interface SocialCardLogo {
  color: string;
  grey?: string;
  /** A dark mark with no disc of its own: drawn on a light plate, as the site does in dark mode. */
  lightPlate?: boolean;
}

/** Everything a template needs besides the spec; both runtimes build it from the same files. */
export interface SocialCardAssets {
  measure: SocialCardMeasurer;
  /** Keyed by registered public path ("/logos/1-usdt.svg"). */
  logos: ReadonlyMap<string, SocialCardLogo>;
}

export function h(type: string, style: Style, ...children: Child[]): SocialCardElement {
  const kids = children.filter((child): child is SocialCardElement | string => Boolean(child));
  return { type, props: { style: { display: "flex", ...style }, children: kids.length === 1 ? kids[0] : kids } };
}

export const img = (src: string, width: number, style: Style = {}, height = width): SocialCardElement =>
  ({ type: "img", props: { src, width, height, style: { width, height, ...style } } });

export const at = (left: number, top: number, width: number, height: number): Style =>
  ({ position: "absolute", left, top, width, height });

export const svgUri = (width: number, height: number, body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;

const round = (value: number) => Math.round(value * 100) / 100;

export function font(face: SocialCardFace): Style {
  const { family, weight, style } = SOCIAL_CARD_FONTS[face];
  return { fontFamily: family, fontWeight: weight, fontStyle: style };
}

/** A fitted text block; `balance` keeps a short last line from standing alone. */
export function text(block: FittedBlock, color: string, style: Style = {}): SocialCardElement {
  return h("div", {
    ...font(block.face),
    width: block.width,
    fontSize: block.size,
    lineHeight: block.lineHeight,
    letterSpacing: round((block.tracking ?? 0) * block.size),
    color,
    ...(block.lines > 1 ? { textWrap: "balance" } : {}),
    ...style,
  }, block.text);
}

/** One line of fixed-size text, measured so callers can lay out around it. */
export function label(measure: SocialCardMeasurer, value: string, face: SocialCardFace, size: number, color: string, tracking = 0): { node: SocialCardElement; width: number } {
  const width = Math.ceil(measure.width(value, face, size, tracking * size));
  return { node: h("div", { ...font(face), fontSize: size, lineHeight: 1.2, letterSpacing: round(tracking * size), color, whiteSpace: "nowrap" }, value), width };
}

type Theme = "dark" | "paper";
const MARK_ON_DARK = `data:image/svg+xml,${encodeURIComponent(PHAROS_MARK_ON_DARK_SVG)}`;
const MARK_ON_LIGHT = `data:image/svg+xml,${encodeURIComponent(PHAROS_MARK_ON_LIGHT_SVG)}`;

/** The only small text on a card: mark, "Pharos" and the destination kind. */
export function lockup(assets: SocialCardAssets, kind: string, theme: Theme): { node: SocialCardElement; width: number } {
  const ink = theme === "dark" ? DARK : PAPER;
  const name = label(assets.measure, "Pharos", "display-800", 30, ink.text, -0.02);
  const kindLabel = label(assets.measure, kind, "mono-500", 22, ink.muted);
  return {
    node: h("div", { alignItems: "center", height: 44 },
      img(theme === "dark" ? MARK_ON_DARK : MARK_ON_LIGHT, 40),
      h("div", { marginLeft: 14 }, name.node),
      h("div", { width: 2, height: 26, marginLeft: 16, marginRight: 16, background: theme === "dark" ? DARK.lineStrong : PAPER.line }),
      kindLabel.node),
    width: 40 + 14 + name.width + 34 + kindLabel.width,
  };
}

/** The signature: a rangefinder bezel of hairline rings and frost ticks around the subject. */
export function lens(cx: number, cy: number, r: number, options: { orbit?: number; dashed?: boolean } = {}): SocialCardElement {
  const scale = r / 205;
  const extent = Math.ceil(r + 44 * scale);
  const c = extent;
  const ticks: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    const angle = (index / 60) * Math.PI * 2 - Math.PI / 2;
    const cardinal = index % 15 === 0;
    const major = index % 5 === 0;
    const inner = r - (cardinal ? 10 * scale : 0);
    const outer = r + (cardinal ? 26 : major ? 18 : 9) * scale;
    const [x1, y1, x2, y2] = [c + inner * Math.cos(angle), c + inner * Math.sin(angle), c + outer * Math.cos(angle), c + outer * Math.sin(angle)].map(round);
    ticks.push(`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${FROST}" stroke-opacity="${cardinal ? 0.95 : major ? 0.7 : 0.3}" stroke-width="${cardinal ? 2.6 : 2.2}" stroke-linecap="round"/>`);
  }
  const ring = (radius: number, extra = "") => `<circle cx="${c}" cy="${c}" r="${round(radius)}" fill="none" stroke="${DARK.line}" stroke-width="1.5"${extra}/>`;
  const body = [
    options.dashed === false ? "" : ring(r + 40 * scale, ` stroke-dasharray="2 10"`),
    ring(r - 22 * scale),
    options.orbit === undefined ? "" : ring(options.orbit),
    ...ticks,
  ].join("");
  return img(svgUri(extent * 2, extent * 2, body), extent * 2, at(cx - extent, cy - extent, extent * 2, extent * 2));
}

/** A round plate that lifts the subject off the ground. */
export const plate = (cx: number, cy: number, radius: number, style: Style = {}) =>
  h("div", { ...at(cx - radius, cy - radius, radius * 2, radius * 2), borderRadius: radius, background: DARK.raised, ...style });

/**
 * A registered logo clipped to the site's round treatment. A dark mark without
 * a disc of its own sits on a light plate, as the site's dark mode does.
 */
export function logoDisc(assets: SocialCardAssets, logoPath: string, size: number, options: { grey?: boolean; where: string; style?: Style }): SocialCardElement {
  const logo = assets.logos.get(logoPath);
  const src = options.grey ? logo?.grey : logo?.color;
  if (!logo || !src) throw new SocialCardError(`${options.where}: logo ${logoPath}${options.grey ? " (greyscale)" : ""} was not loaded`);
  if (!logo.lightPlate) return img(src, size, { borderRadius: size / 2, objectFit: "contain", ...options.style });
  const inner = Math.round(size * 0.76);
  return h("div", { width: size, height: size, borderRadius: size / 2, background: options.grey ? DARK.muted : DARK.lightPlate, alignItems: "center", justifyContent: "center", ...options.style },
    img(src, inner, { objectFit: "contain" }));
}

/** A logo on its own raised disc with a hairline edge, for clusters and orbits. */
export function logoChip(assets: SocialCardAssets, logoPath: string, cx: number, cy: number, size: number, where: string): SocialCardElement {
  const pad = Math.max(3, Math.round(size * 0.06));
  return h("div", { ...at(cx - size / 2 - pad, cy - size / 2 - pad, size + pad * 2, size + pad * 2), alignItems: "center", justifyContent: "center", borderRadius: size, background: DARK.raised, border: `1.5px solid ${DARK.lineStrong}` },
    logoDisc(assets, logoPath, size, { where }));
}

/** Identity without a registered logo: the ticker in a dashed ring, as large as it fits. */
export function monogram(measure: SocialCardMeasurer, symbol: string, size: number, ring: string, where: string): SocialCardElement {
  const letters = symbol.replace(/[^\p{L}\p{N}]/gu, "");
  const candidates = [letters.length <= 5 ? letters : "", letters.slice(0, 4), letters.slice(0, 3)].filter(Boolean);
  const width = Math.round(size * 0.74);
  let fitted: FittedBlock | null = null;
  for (const candidate of candidates.length ? candidates : [symbol.slice(0, 2)]) {
    try {
      fitted = fitBlock(measure, where, { field: "monogram", text: candidate, face: "display-800", sizes: steps(Math.round(size * 0.42), Math.round(size * 0.26)), lineHeight: 1, tracking: -0.03, width, maxLines: 1 });
      break;
    } catch (error) {
      if (!(error instanceof SocialCardError)) throw error;
    }
  }
  if (!fitted) throw new SocialCardError(`${where}: no monogram fits for ${symbol}`);
  return h("div", { width: size, height: size, borderRadius: size / 2, border: `3px dashed ${ring}`, alignItems: "center", justifyContent: "center" },
    text(fitted, DARK.text, { justifyContent: "center", textAlign: "center" }));
}

/** Descending sizes from `max` to `min` in `step` px. */
export function steps(max: number, min: number, step = 2): number[] {
  const sizes: number[] = [];
  for (let size = max; size > min; size -= step) sizes.push(size);
  sizes.push(min);
  return sizes;
}

const chipPad = (size: number) => [Math.round(size * 0.3), Math.round(size * 0.55)] as const;

/** A short mono fact in a hairline pill. */
export function chip(value: string, size: number): SocialCardElement {
  const [y, x] = chipPad(size);
  return h("div", {
    ...font("mono-500"), fontSize: size, lineHeight: 1.2, whiteSpace: "nowrap", flexShrink: 0,
    color: DARK.soft, border: `1.5px solid ${DARK.lineStrong}`, borderRadius: 999, padding: `${y}px ${x}px`,
  }, value);
}

export const chipWidth = (measure: SocialCardMeasurer, value: string, size: number) =>
  Math.ceil(measure.width(value, "mono-500", size)) + chipPad(size)[1] * 2 + 3;
export const chipHeight = (size: number) => Math.round(size * 1.2) + chipPad(size)[0] * 2 + 3;

/** A rubber stamp over the lens for lifecycles that are not plainly active. */
export function stamp(value: string, color: string, cx: number, top: number): SocialCardElement {
  return h("div", { ...at(cx - 230, top, 460, 80), justifyContent: "center", alignItems: "center", transform: "rotate(-6deg)" },
    h("div", { ...font("mono-700"), fontSize: 25, lineHeight: 1.2, letterSpacing: 1, color, whiteSpace: "nowrap", border: `3px solid ${color}`, borderRadius: 10, padding: "8px 20px", background: DARK.ground }, value));
}

const STROKE = `fill="none" stroke="${DARK.text}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"`;
const FILLED = `fill="${DARK.raised}" stroke="${DARK.text}" stroke-width="10" stroke-linejoin="round"`;

const polar = (cx: number, cy: number, radius: number, degrees: number) =>
  [cx + radius * Math.cos((degrees * Math.PI) / 180), cy - radius * Math.sin((degrees * Math.PI) / 180)].map(round).join(" ");

function arc(cx: number, cy: number, radius: number, from: number, to: number): string {
  return `M${polar(cx, cy, radius, from)}A${radius} ${radius} 0 0 1 ${polar(cx, cy, radius, to)}`;
}

/** An annular band between two radii, clockwise from `from` to `to` degrees. */
function band(cx: number, cy: number, inner: number, outer: number, from: number, to: number): string {
  return `M${polar(cx, cy, outer, from)}A${outer} ${outer} 0 0 1 ${polar(cx, cy, outer, to)}L${polar(cx, cy, inner, to)}A${inner} ${inner} 0 0 0 ${polar(cx, cy, inner, from)}Z`;
}

/** Line glyphs on a 200-unit grid, one stroke weight, drawn inside the lens plate. */
const GLYPHS: Readonly<Record<SocialCardGlyph, string>> = {
  // The lighthouse mark as line art: lamp on the horizon, beam rays, tower, all inside the disc.
  mark: `<circle cx="100" cy="100" r="88" ${STROKE}/><path d="M14 116H186M100 30V78M50 54L80 88M150 54L120 88M92 116L64 180M108 116L136 180" ${STROKE}/><path d="M78 116A22 22 0 0 1 122 116" ${FILLED}/>`,
  lock: `<path d="M68 88V66a32 32 0 0 1 64 0v22" ${STROKE}/><rect x="42" y="88" width="116" height="88" rx="18" ${FILLED}/><circle cx="100" cy="124" r="11" ${STROKE}/><path d="M100 135v17" ${STROKE}/>`,
  // Stability Index: five bands, no needle.
  gauge: [0, 1, 2, 3, 4].map((index) => `<path d="${band(100, 140, 54, 88, 177.6 - index * 37.2, 151.2 - index * 37.2)}" ${FILLED}/>`).join("")
    + `<path d="${arc(100, 140, 32, 174, 6)}" fill="none" stroke="${DARK.muted}" stroke-width="6" stroke-linecap="round" stroke-dasharray="0.1 12.3"/>`,
  graph: `<path d="M100 100L48 58M100 100L152 58M100 100L44 150M100 100L156 150M48 58L152 58M44 150L156 150" ${STROKE}/>`
    + [[100, 100, 18], [48, 58, 13], [152, 58, 13], [44, 150, 13], [156, 150, 13]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" ${FILLED}/>`).join(""),
  flows: `<path d="M30 76H164M140 52L166 76L140 100M170 128H36M60 104L34 128L60 152" ${STROKE}/>`,
  timeline: `<path d="M20 146H180M46 146V112M84 146V80M120 146V122M156 146V94" ${STROKE}/>`
    + [[46, 112], [84, 80], [120, 122], [156, 94]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${DARK.text}"/>`).join(""),
  filter: `<path d="M28 56H172M28 100H172M28 144H172" ${STROKE}/>` + [[72, 56], [132, 100], [96, 144]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="14" ${FILLED}/>`).join(""),
  portfolio: `<path d="M76 68V56a12 12 0 0 1 12-12h24a12 12 0 0 1 12 12v12" ${STROKE}/><rect x="28" y="68" width="144" height="100" rx="18" ${FILLED}/><path d="M28 112H86M114 112H172" ${STROKE}/><rect x="86" y="100" width="28" height="24" rx="5" ${FILLED}/>`,
  code: `<path d="M66 58L26 100L66 142M134 58L174 100L134 142M114 44L86 156" ${STROKE}/>`,
  telegram: `<path d="M24 98L174 38L146 164L100 128Z" ${FILLED}/><path d="M100 128L174 38M100 128V164L122 144" ${STROKE}/>`,
};

export function glyph(name: SocialCardGlyph, cx: number, cy: number, size: number): SocialCardElement {
  return img(svgUri(200, 200, GLYPHS[name]), size, at(cx - size / 2, cy - size / 2, size, size));
}

/** Safety Scores: a frost-edged shield; the "?" is a text node laid over it. */
export const shield = (cx: number, cy: number) => img(svgUri(300, 340,
  `<path d="M150 8L286 58V160C286 246 226 304 150 332C74 304 14 246 14 160V58Z" fill="${DARK.raised}" stroke="${FROST}" stroke-width="5" stroke-linejoin="round"/><path d="M150 34L262 75V160C262 232 212 282 150 306C88 282 38 232 38 160V75Z" fill="none" stroke="${DARK.lineStrong}" stroke-width="2"/>`),
  270, at(cx - 135, cy - 153, 270, 306), 306);
