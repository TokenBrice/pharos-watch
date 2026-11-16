import {
  SOCIAL_PREVIEW_HEIGHT,
  SOCIAL_PREVIEW_WIDTH,
  type SocialPreviewSpec,
  type SocialPreviewVisual,
} from "../../shared/lib/social-preview";
import { escapeXml } from "./og-svg.mts";
export interface SocialPreviewLogo {
  readonly dataUri: string;
  readonly sourceSha256: string;
}


export const SOCIAL_PREVIEW_BACKGROUND = "#101e2b";
const INK = "#101e2b";
const NAVY = "#193349";
const FROST = "#4bc4de";
const PAPER = "#edf3f5";
const MUTED = "#a9bfcb";
const DISPLAY = "'Geist'";
const SERIF = "'Newsreader'";
const SANS = "'Geist'";
const MONO = "'Geist Mono'";
const SAFE_X = 312;
const SAFE_WIDTH = 576;

/** The tracked fonts cover ASCII, Latin-1 and common punctuation only; resvg would draw a missing-glyph box for anything else. */
const RENDERABLE = /^[\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2026]*$/;
function renderable(value: string): string {
  const output = value.replaceAll("₮", "T");
  if (!RENDERABLE.test(output)) throw new Error(`Social preview text has a glyph outside the tracked fonts: ${value}`);
  return output;
}

function text(value: string, x: number, y: number, size: number, options: { family?: string; weight?: number; fill?: string; anchor?: string } = {}): string {
  return `<text x="${x}" y="${y}" font-family="${options.family ?? SANS}" font-size="${size}" font-weight="${options.weight ?? 400}" fill="${options.fill ?? INK}"${options.anchor ? ` text-anchor="${options.anchor}"` : ""}>${escapeXml(renderable(value))}</text>`;
}

function estimatedWidth(value: string, size: number): number {
  return [...value].reduce((sum, char) => sum + (/\s/.test(char) ? 0.29 : /[ilI.,'`:;!|]/.test(char) ? 0.30 : /[MW@%&]/.test(char) ? 0.91 : /[A-Z0-9]/.test(char) ? 0.67 : /[^\u0000-\u024f]/.test(char) ? 0.95 : 0.56), 0) * size;
}

/** Conservative line breaking; never silently drops a word or editorial outcome. */
function lines(value: string, size: number, width: number): string[] {
  const output: string[] = [];
  let current = "";
  for (const word of value.trim().split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimatedWidth(candidate, size) > width) {
      output.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) output.push(current);
  return output;
}

/** Facts wrap between items before any single item breaks across rows. */
function factLines(facts: readonly string[], size: number, width: number): string[] {
  const rows: string[] = [];
  for (const fact of facts) {
    const joined = rows.length ? `${rows[rows.length - 1]} · ${fact}` : fact;
    if (rows.length && estimatedWidth(joined, size) <= width) rows[rows.length - 1] = joined;
    else rows.push(...lines(fact, size, width));
  }
  return rows;
}

function fitted(value: string, width: number, maxLines: number, startSize: number, minimum: number, maxHeight = Infinity): { rows: string[]; size: number } {
  for (let size = startSize; size >= minimum; size -= 2) {
    const rows = lines(value, size, width);
    if (rows.length <= maxLines && rows.length * size * 1.04 <= maxHeight
      && rows.every((row) => estimatedWidth(row, size) <= width)) return { rows, size };
  }
  throw new Error(`Social preview copy exceeds its readable text budget: ${value}`);
}

function block(rows: readonly string[], x: number, top: number, size: number, options: Parameters<typeof text>[4] = {}): string {
  return rows.map((row, index) => text(row, x, top + size * 0.9 + index * size * 1.08, size, options)).join("");
}

function rule(x1: number, y1: number, x2: number, y2: number, stroke = FROST, width = 3): string {
  return `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
}

function circle(x: number, y: number, r: number, fill = "none", stroke = FROST, width = 3): string {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function brand(mark: string): string {
  const icon = mark.trim().replace(/^<svg\b[^>]*>/, `<svg x="${SAFE_X}" y="30" width="44" height="44" viewBox="0 0 400 400" fill="none">`);
  return `${icon}${text("PHAROS", SAFE_X + 58, 62, 27, { weight: 700, fill: PAPER })}${text("pharos.watch", SAFE_X + SAFE_WIDTH, 59, 19, { family: MONO, fill: MUTED, anchor: "end" })}`;
}

/** Text and brand stay inside x285..915, including in a center-square crop. */
function copy(spec: SocialPreviewSpec, options: { top: number; bottom: number; titleSize: number; minimum?: number; serif?: boolean; dark?: boolean; facts?: readonly string[] }): string {
  const facts = options.facts ?? spec.facts;
  const factRows = factLines(facts, 24, SAFE_WIDTH);
  if (factRows.length > 3 || factRows.some((row) => estimatedWidth(row, 24) > SAFE_WIDTH)) throw new Error(`Social preview evidence exceeds its readable text budget: ${spec.path}`);
  for (let titleSize = options.titleSize; titleSize >= (options.minimum ?? 42); titleSize -= 2) {
    const titleRows = lines(spec.subject, titleSize, SAFE_WIDTH);
    if (titleRows.length > 6 || titleRows.some((row) => estimatedWidth(row, titleSize) > SAFE_WIDTH)) continue;
    for (let hookSize = options.serif ? 30 : 32; hookSize >= 26; hookSize -= 2) {
      const hookRows = lines(spec.hook, hookSize, SAFE_WIDTH);
      const titleHeight = titleRows.length * titleSize * 1.08;
      const hookHeight = hookRows.length * hookSize * 1.08;
      const factsHeight = factRows.length ? 24 + factRows.length * 27 : 0;
      if (hookRows.length > 5 || hookRows.some((row) => estimatedWidth(row, hookSize) > SAFE_WIDTH)
        || titleHeight + 24 + hookHeight + factsHeight > options.bottom - options.top) continue;
      const foreground = options.dark ? PAPER : INK;
      const secondary = options.dark ? MUTED : "#425c6c";
      const hookTop = options.top + titleHeight + 24;
      return `<g data-safe-copy="${spec.grammar}">${block(titleRows, 600, options.top, titleSize, { family: options.serif ? SERIF : DISPLAY, weight: options.serif ? 500 : 700, fill: foreground, anchor: "middle" })}${block(hookRows, 600, hookTop, hookSize, { fill: secondary, anchor: "middle" })}${block(factRows, 600, hookTop + hookHeight + 24, 24, { family: MONO, fill: secondary, anchor: "middle" })}</g>`;
    }
  }
  throw new Error(`Social preview copy exceeds its readable text budget: ${spec.path}: ${spec.subject}`);
}

/** Oversized, unscaled mechanism art: no invented price line, chart or live state. */
function mechanism(visual: SocialPreviewVisual): string {
  const stroke = `fill="none" stroke="${FROST}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"`;
  switch (visual.kind) {
    case "lighthouse":
      return `<path d="M176 128L-260 10V264Z" fill="${NAVY}"/><path d="M176 128L-200 62" ${stroke}/><path d="M150 402L178 176H244L276 402Z" fill="${PAPER}"/><path d="M164 294H260M171 238H251" stroke="${INK}" stroke-width="12"/><path d="M157 170H266M167 121H254L243 170H178Z" ${stroke}/><path d="M177 118L211 74L246 118" ${stroke}/>${rule(128, 407, 300, 407, FROST, 12)}`;
    case "peg":
      return `${circle(215, 220, 170, "none", NAVY, 30)}${circle(215, 220, 112, "none", FROST, 9)}${circle(215, 220, 30, PAPER, PAPER)}${rule(5, 220, 135, 220, FROST, 9)}${rule(295, 220, 425, 220, FROST, 9)}${rule(215, 10, 215, 140, FROST, 9)}${rule(215, 300, 215, 430, FROST, 9)}`;
    case "reserves":
      return `<path d="M36 123L215 24L394 123Z" fill="${PAPER}"/><path d="M57 142H373M35 375H396M23 410H407" ${stroke}/>${[93, 215, 337].map((x) => `<path d="M${x - 27} 164H${x + 27}V350H${x - 27}Z" fill="${NAVY}" stroke="${FROST}" stroke-width="7"/>`).join("")}${circle(215, 89, 16, INK, INK)}`;
    case "network":
      return `<path d="M75 74L218 220L372 75M218 220L68 365M218 220L376 365" ${stroke}/>${[[75, 74], [372, 75], [68, 365], [376, 365]].map(([x, y]) => circle(x, y, 45, NAVY, FROST, 7)).join("")}${circle(218, 220, 70, PAPER, PAPER)}${circle(218, 220, 24, INK, INK)}`;
    case "chain":
      return `<g transform="rotate(-38 215 220)"><rect x="45" y="117" width="222" height="166" rx="83" fill="none" stroke="${PAPER}" stroke-width="24"/><rect x="175" y="192" width="222" height="166" rx="83" fill="${INK}" stroke="${FROST}" stroke-width="24"/><path d="M202 196L237 219" ${stroke}/></g>`;
    case "control":
      return `<path d="M117 182V120C117 7 316 7 316 120V182" fill="none" stroke="${PAPER}" stroke-width="22"/><rect x="60" y="181" width="314" height="228" rx="28" fill="${NAVY}" stroke="${FROST}" stroke-width="9"/>${circle(217, 274, 28, PAPER, PAPER)}<path d="M217 292V344" stroke="${PAPER}" stroke-width="19"/><path d="M30 75L75 121M365 75L320 121" ${stroke}/>`;
    case "flows":
      return `<path d="M-40 113H355L296 55M355 113L296 171M465 325H75L134 267M75 325L134 383" ${stroke}/><path d="M101 181H329V255H101Z" fill="${PAPER}"/><path d="M146 218H285" stroke="${INK}" stroke-width="9"/>`;
    case "liquidity":
      return `${circle(67, 220, 67, NAVY, PAPER, 9)}${circle(373, 220, 67, NAVY, PAPER, 9)}<path d="M113 170H315L278 134M315 170L278 207M322 275H120L157 239M120 275L157 312" ${stroke}/><path d="M67 310V385H373V310" ${stroke}/>`;
    case "yield":
      return `<path d="M55 96H255V313H55Z" fill="${NAVY}" stroke="${PAPER}" stroke-width="9"/>${circle(155, 204, 50, "none", FROST, 8)}<path d="M155 157V250M123 179H170C198 179 198 206 171 206H139C111 206 111 232 138 232H187" ${stroke}/><path d="M278 182H401L366 147M401 182L366 217" ${stroke}/>${circle(340, 326, 62, PAPER, PAPER)}<path d="M340 297V356M311 326H369" stroke="${INK}" stroke-width="9"/>`;
    case "filter":
      return `${[94, 220, 346].map((y, index) => `<path d="M0 ${y}H435" stroke="${PAPER}" stroke-width="8"/><rect x="${66 + index * 95}" y="${y - 35}" width="46" height="70" rx="9" fill="${INK}" stroke="${FROST}" stroke-width="8"/>`).join("")}`;
    case "portfolio":
      return `<rect x="25" y="95" width="375" height="280" rx="32" fill="${NAVY}" stroke="${PAPER}" stroke-width="9"/><path d="M60 95V52H327V95" ${stroke}/><rect x="278" y="194" width="132" height="95" rx="16" fill="${INK}" stroke="${FROST}" stroke-width="9"/>${circle(320, 242, 9, PAPER, PAPER)}<path d="M68 155H214M68 202H176" stroke="${FROST}" stroke-width="8"/>`;
    case "code":
      return `<path d="M145 111L34 219L145 327M295 111L406 219L295 327M246 58L191 382" ${stroke}/>`;
    default:
      throw new Error(`Non-signal visual cannot be mechanism art: ${visual.kind}`);
  }
}

function logo(identity: { symbol: string; logoPath?: string }, x: number, y: number, size: number, logoAssets?: ReadonlyMap<string, SocialPreviewLogo>): string {
  const plate = circle(x, y, size / 2 + 8, PAPER, identity.logoPath ? PAPER : NAVY, identity.logoPath ? 2 : 6);
  if (!identity.logoPath) {
    const glyph = fitted(identity.symbol.slice(0, 2), size * 0.83, 2, Math.min(50, size * 0.3), 18);
    return `${plate}${block(glyph.rows, x, y - glyph.rows.length * glyph.size * 0.54, glyph.size, { weight: 700, anchor: "middle" })}`;
  }
  const image = logoAssets?.get(identity.logoPath);
  if (!image) throw new Error(`Trusted local social preview logo was not loaded: ${identity.logoPath}`);
  // Match the site's rounded-full logo treatment so square artwork never spills past the plate.
  const clip = `logo-clip-${x}`;
  return `${plate}<clipPath id="${clip}"><circle cx="${x}" cy="${y}" r="${size / 2}"/></clipPath><image clip-path="url(#${clip})" data-logo-source="${escapeXml(identity.logoPath)}" data-logo-source-sha256="${image.sourceSha256}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" href="${escapeXml(image.dataUri)}" preserveAspectRatio="xMidYMid meet"/>`;
}

function dossier(spec: SocialPreviewSpec, logoAssets?: ReadonlyMap<string, SocialPreviewLogo>): string {
  const visual = spec.visual;
  if (visual.kind === "identity") {
    const symbol = fitted(visual.symbol, 380, 2, 68, 30, 114);
    // Rings recede to a pale tone on paper so long names stay legible where they cross them.
    const rings = (stroke: string) => `${circle(110, 228, 240, "none", stroke, 45)}${circle(1110, 228, 240, "none", stroke, 45)}`;
    return `<defs><clipPath id="dossier-band"><rect width="1200" height="266"/></clipPath><clipPath id="dossier-paper"><rect y="266" width="1200" height="364"/></clipPath></defs><rect y="266" width="1200" height="364" fill="${PAPER}"/><g clip-path="url(#dossier-band)">${rings(NAVY)}</g><g clip-path="url(#dossier-paper)">${rings("#d6e2e7")}</g>${logo(visual, 395, 191, 160, logoAssets)}${block(symbol.rows, 500, 191 - symbol.rows.length * symbol.size * 0.54, symbol.size, { weight: 700, fill: PAPER })}${copy(spec, { top: 293, bottom: 576, titleSize: 58, minimum: 36 })}`;
  }
  if (visual.kind !== "contrast") throw new Error(`Dossier requires asset identities: ${spec.path}`);
  const hook = fitted(spec.hook, SAFE_WIDTH, 2, 32, 28);
  return `<rect y="110" width="1200" height="520" fill="${PAPER}"/><path d="M0 110H272V630H0ZM928 110H1200V630H928Z" fill="${NAVY}"/>${[visual.left, visual.right].map((side, index) => {
    const x = index === 0 ? 448 : 752;
    const symbol = fitted(side.symbol, 240, 2, 44, 22, 70);
    const label = fitted(side.label, 240, 3, 26, 22, 88);
    const labelTop = 301 + symbol.rows.length * symbol.size * 1.08 + 18;
    return `${logo(side, x, 212, 130, logoAssets)}${block(symbol.rows, x, 301, symbol.size, { weight: 700, anchor: "middle" })}${block(label.rows, x, labelTop, label.size, { fill: "#425c6c", anchor: "middle" })}`;
  }).join("")}${circle(600, 212, 33, INK, INK)}${text("VS", 600, 221, 24, { family: MONO, fill: PAPER, anchor: "middle" })}${block(hook.rows, 600, 490, hook.size, { anchor: "middle" })}`;
}

function briefingArt(visual: SocialPreviewVisual): { artwork: string; stamp: string; date: string | null } {
  if (visual.kind === "edition") {
    const date = new Date(`${visual.date}T00:00:00Z`);
    const calendar = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase();
    const month = date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase();
    return {
      artwork: `${text(String(date.getUTCDate()).padStart(2, "0"), 156, 380, 196, { family: SERIF, anchor: "middle" })}${text(month, 156, 446, 46, { family: MONO, anchor: "middle" })}${text(String(date.getUTCFullYear()), 1080, 350, 78, { family: SERIF, anchor: "middle" })}${rule(978, 385, 1182, 385, INK, 5)}${rule(978, 405, 1118, 405, INK, 5)}`,
      stamp: calendar,
      date: calendar,
    };
  }
  if (visual.kind !== "document") throw new Error("Briefing requires an editorial visual");
  return {
    artwork: `<path d="M-60 178C70 128 170 164 256 224V553C150 494 50 469-60 514ZM1260 178C1130 128 1030 164 944 224V553C1050 494 1150 469 1260 514Z" fill="${INK}"/><path d="M-50 207C70 169 156 195 231 244M1250 207C1130 169 1044 195 969 244" fill="none" stroke="${FROST}" stroke-width="7"/><path d="M-20 276L176 319M-20 323L176 366M1220 276L1024 319M1220 323L1024 366" fill="none" stroke="${PAPER}" stroke-width="5"/>`,
    stamp: visual.labels[0],
    date: null,
  };
}

export function buildSocialPreviewSvg(spec: SocialPreviewSpec, brandMark: string, logoAssets?: ReadonlyMap<string, SocialPreviewLogo>): string {
  let composition: string;
  if (spec.grammar === "signal") {
    const facts = spec.facts.length ? spec.facts : "labels" in spec.visual ? spec.visual.labels : [];
    composition = `<path d="M0 120L272 210V514L0 610Z" fill="${NAVY}"/><path d="M0 189L238 272" stroke="${FROST}" stroke-width="6"/><defs><clipPath id="signal-art"><rect x="906" y="110" width="294" height="475"/></clipPath></defs><g clip-path="url(#signal-art)"><g transform="translate(906 143)">${mechanism(spec.visual)}</g></g>${copy(spec, { top: 165, bottom: 567, titleSize: 76, dark: true, facts })}`;
  } else if (spec.grammar === "dossier") composition = dossier(spec, logoAssets);
  else {
    const art = briefingArt(spec.visual);
    const stamp = fitted(art.stamp.toUpperCase(), SAFE_WIDTH, 2, 23, 19);
    const stampHeight = stamp.rows.length * stamp.size * 1.08;
    composition = `<rect y="110" width="1200" height="520" fill="${PAPER}"/>${art.artwork}${block(stamp.rows, 600, 132, stamp.size, { family: MONO, fill: "#425c6c", anchor: "middle" })}${copy(spec, { top: 132 + stampHeight + 22, bottom: 576, titleSize: 70, serif: true, facts: spec.facts.filter((fact) => fact.toUpperCase() !== art.date) })}`;
  }
  const eyebrow = fitted(spec.eyebrow.toUpperCase(), SAFE_WIDTH, 1, 21, 17);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_PREVIEW_WIDTH}" height="${SOCIAL_PREVIEW_HEIGHT}" viewBox="0 0 ${SOCIAL_PREVIEW_WIDTH} ${SOCIAL_PREVIEW_HEIGHT}">
<title>${escapeXml(spec.subject)}</title><desc>${escapeXml(spec.hook)}</desc>
<rect width="1200" height="630" fill="${SOCIAL_PREVIEW_BACKGROUND}"/>
${composition}
${brand(brandMark)}${text(eyebrow.rows[0], 600, 99, eyebrow.size, { family: MONO, fill: MUTED, anchor: "middle" })}
${rule(SAFE_X, 594, SAFE_X + SAFE_WIDTH, 594, spec.grammar === "signal" ? NAVY : "#cad8de", 2)}${text(spec.grammar === "briefing" ? "Evidence, with context." : "Look past the peg.", 600, 619, 19, { family: MONO, fill: spec.grammar === "signal" ? MUTED : "#425c6c", anchor: "middle" })}
</svg>`;
}
