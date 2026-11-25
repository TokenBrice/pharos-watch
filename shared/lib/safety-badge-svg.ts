import { GRADE_ON_DARK_HEX, GRADE_RADAR_COLORS } from "./classification/grades";
import { DARK, PAPER } from "./social-card/tokens";
import type { ReportCardGradeRange } from "../types/report-card-grade";

export type SafetyBadgeStyle = "flat" | "card";
export type SafetyBadgeTheme = "dark" | "light";

export type SafetyBadgeState =
  | { kind: "rated"; symbol: string; name?: string; grade: string; score: number }
  | { kind: "not-rated"; symbol: string; name?: string }
  | { kind: "tokenized-fund"; symbol: string; name?: string }
  | { kind: "unavailable"; symbol?: string; name?: string };

export interface SafetyBadgeRenderOptions {
  style?: SafetyBadgeStyle;
  theme?: SafetyBadgeTheme;
}

const SANS_FONT = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// Lighthouse mark path derived from shared/lib/social-card/brand.ts (400x400 viewBox).
const PHAROS_MARK_PATH =
  "M199.744 -0.045C310.305 -0.045 399.932 89.582 399.932 200.142C399.932 282.445 350.263 353.143 279.267 383.908L199.804 225.049L120.332 383.956C49.277 353.216 -0.443 282.487 -0.443 200.142C-0.443 89.582 89.184 -0.045 199.744 -0.045ZM199.811 49.988C196.924 72.823 194.083 95.659 191.197 118.494C191.038 121.28 189.037 151.411 171.312 157.546C161.789 160.833 151.698 155.837 139.812 148.496C121.881 137.451 96.11 118.778 68.565 87.748C83.519 108.325 96.587 126.909 107.609 142.972C123.245 165.719 129.654 175.889 126.063 185.925C123.382 193.376 116.131 197.979 97.065 205.277C79.815 211.895 55.474 219.718 24.589 225.043H159.76C159.762 202.926 177.693 184.997 199.811 184.997C221.928 184.997 239.859 202.926 239.861 225.043H375.01C344.147 219.718 319.784 211.895 302.534 205.277C283.467 197.979 276.24 193.376 273.559 185.925C269.946 175.889 276.377 165.719 291.989 142.972C303.034 126.909 316.08 108.325 331.033 87.748C303.489 118.779 277.717 137.451 259.786 148.496C247.9 155.837 237.809 160.833 228.287 157.546C210.562 151.41 208.561 121.28 208.401 118.494C205.538 95.659 202.674 72.823 199.811 49.988Z";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function gradeToRange(grade: string): ReportCardGradeRange {
  const upper = grade.trim().toUpperCase();
  if (upper.startsWith("A")) return "A";
  if (upper.startsWith("B")) return "B";
  if (upper.startsWith("C")) return "C";
  if (upper.startsWith("D")) return "D";
  if (upper.startsWith("F")) return "F";
  return "NR";
}

function resolveGradeAccentHex(state: SafetyBadgeState, theme: SafetyBadgeTheme): string {
  if (state.kind === "unavailable") {
    return theme === "dark" ? DARK.muted : PAPER.muted;
  }
  const range: ReportCardGradeRange = state.kind === "rated" ? gradeToRange(state.grade) : "NR";
  return theme === "dark" ? GRADE_ON_DARK_HEX[range] : GRADE_RADAR_COLORS[range];
}

function approxTextWidth(text: string, charWidth: number): number {
  return Math.ceil(text.length * charWidth);
}

function renderMark(x: number, y: number, size: number, theme: SafetyBadgeTheme): string {
  const scale = (size / 400).toFixed(4);
  const discBg = theme === "dark" ? "#0a0a0a" : "#0f1820";
  const fg = "#eeeeee";
  return `<g transform="translate(${x} ${y}) scale(${scale})">`
    + `<circle cx="200" cy="200" r="200" fill="${discBg}"/>`
    + `<path d="${PHAROS_MARK_PATH}" fill="${fg}"/>`
    + `</g>`;
}

/**
 * Pure SVG Safety Score badge renderer using presentation attributes only
 * (no `<style>` blocks or inline `style=""`) so strict `default-src 'none'`
 * CSP holds on both Worker responses and inline page previews.
 */
export function renderSafetyBadgeSvg(
  state: SafetyBadgeState,
  options: SafetyBadgeRenderOptions = {},
): string {
  const style: SafetyBadgeStyle = options.style === "card" ? "card" : "flat";
  const theme: SafetyBadgeTheme = options.theme === "light" ? "light" : "dark";
  const accent = resolveGradeAccentHex(state, theme);

  const bg = theme === "dark" ? DARK.ground : PAPER.ground;
  const surface = theme === "dark" ? DARK.raised : "#ffffff";
  const border = theme === "dark" ? DARK.lineStrong : PAPER.line;
  const fg = theme === "dark" ? DARK.text : PAPER.text;
  const muted = theme === "dark" ? DARK.muted : PAPER.muted;

  const rawSymbol = (state.symbol ?? "").trim().slice(0, 16);
  const symbolEsc = escapeXml(rawSymbol);
  const nameEsc = escapeXml((state.name ?? rawSymbol).trim().slice(0, 28));

  const ariaLabel = state.kind === "rated"
    ? `Pharos Safety Score for ${rawSymbol}: grade ${state.grade}, score ${Math.round(state.score)} out of 100`
    : state.kind === "tokenized-fund"
      ? `Pharos Safety Score for ${rawSymbol}: Tokenized fund (not graded)`
      : state.kind === "not-rated"
        ? `Pharos Safety Score for ${rawSymbol}: Not Rated`
        : rawSymbol
          ? `Pharos Safety Score for ${rawSymbol}: Unavailable`
          : "Pharos Safety Score: Unavailable";
  const ariaEsc = escapeXml(ariaLabel);

  if (style === "flat") {
    const height = 26;
    const leftText = "PHAROS";
    const leftSectionWidth = 8 + 14 + 6 + approxTextWidth(leftText, 6.4) + 10;

    let rightText: string;
    if (state.kind === "rated") {
      const scoreNum = Math.round(state.score);
      rightText = rawSymbol ? `${rawSymbol}  ${state.grade} \u00B7 ${scoreNum}` : `${state.grade} \u00B7 ${scoreNum}`;
    } else if (state.kind === "tokenized-fund") {
      rightText = rawSymbol ? `${rawSymbol}  Not graded` : "Not graded";
    } else if (state.kind === "not-rated") {
      rightText = rawSymbol ? `${rawSymbol}  NR` : "NR";
    } else {
      rightText = rawSymbol ? `${rawSymbol} | Unavailable` : "Unavailable";
    }

    const rightEsc = escapeXml(rightText);
    const gradePillWidth = state.kind === "rated"
      ? approxTextWidth(`${state.grade} \u00B7 ${Math.round(state.score)}`, 6.8) + 12
      : state.kind === "tokenized-fund"
        ? approxTextWidth("Not graded", 6.6) + 12
        : state.kind === "not-rated"
          ? approxTextWidth("NR", 6.8) + 12
          : approxTextWidth("Unavailable", 6.5) + 12;
    const symbolWidth = rawSymbol ? approxTextWidth(rawSymbol, 6.8) + 12 : 0;
    const rightSectionWidth = state.kind === "unavailable"
      ? approxTextWidth(rightText, 6.6) + 18
      : symbolWidth + gradePillWidth + 14;
    const totalWidth = Math.max(150, leftSectionWidth + rightSectionWidth);

    const pillX = totalWidth - gradePillWidth - 5;
    const pillText = state.kind === "rated"
      ? `${escapeXml(state.grade)} &#xB7; ${Math.round(state.score)}`
      : state.kind === "tokenized-fund"
        ? "Not graded"
        : state.kind === "not-rated"
          ? "NR"
          : "Unavailable";

    const rightMarkup = state.kind === "unavailable"
      ? `<text x="${leftSectionWidth + Math.round(rightSectionWidth / 2)}" y="16.5" text-anchor="middle" fill="${muted}" font-family="${SANS_FONT}" font-size="11" font-weight="600">${rightEsc}</text>`
      : `${rawSymbol ? `<text x="${leftSectionWidth + 9}" y="16.5" fill="${fg}" font-family="${SANS_FONT}" font-size="11" font-weight="600">${symbolEsc}</text>` : ""}`
        + `<rect x="${pillX}" y="4" width="${gradePillWidth}" height="18" rx="4" fill="${accent}" fill-opacity="${theme === "dark" ? "0.18" : "0.14"}" stroke="${accent}" stroke-opacity="0.55" stroke-width="1"/>`
        + `<text x="${pillX + Math.round(gradePillWidth / 2)}" y="16.5" text-anchor="middle" fill="${accent}" font-family="${MONO_FONT}" font-size="11" font-weight="700">${pillText}</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" role="img" aria-label="${ariaEsc}">`
      + `<title>${ariaEsc}</title>`
      + `<rect x="0.5" y="0.5" width="${totalWidth - 1}" height="${height - 1}" rx="6" fill="${bg}" stroke="${border}" stroke-width="1"/>`
      + `<rect x="1" y="1" width="${leftSectionWidth - 1}" height="${height - 2}" rx="5" fill="${surface}"/>`
      + `<line x1="${leftSectionWidth}" y1="1" x2="${leftSectionWidth}" y2="${height - 1}" stroke="${border}" stroke-width="1"/>`
      + renderMark(8, 6, 14, theme)
      + `<text x="27" y="16.5" fill="${fg}" font-family="${SANS_FONT}" font-size="10" font-weight="700" letter-spacing="0.8">${leftText}</text>`
      + rightMarkup
      + `</svg>`;
  }

  // Card style (64px height compact badge card)
  const height = 64;
  const pillLabel = state.kind === "rated"
    ? escapeXml(state.grade)
    : state.kind === "tokenized-fund"
      ? "Not graded"
      : state.kind === "not-rated"
        ? "NR"
        : "Unavailable";
  const subMetric = state.kind === "rated"
    ? `${Math.round(state.score)}/100`
    : state.kind === "tokenized-fund"
      ? "Tokenized fund"
      : state.kind === "not-rated"
        ? "Not rated"
        : "Temporarily unavailable";
  const subMetricEsc = escapeXml(subMetric);

  const labelWidth = Math.max(
    approxTextWidth(rawSymbol || "PHAROS", 8.5),
    approxTextWidth(state.name ?? "Pharos Safety Score", 6.5),
    approxTextWidth("PHAROS SAFETY SCORE", 5.8),
  );
  const badgeBoxWidth = state.kind === "unavailable" ? 104 : state.kind === "tokenized-fund" ? 96 : 84;
  const totalWidth = Math.max(256, 14 + 26 + 12 + labelWidth + 16 + badgeBoxWidth + 14);
  const badgeBoxX = totalWidth - badgeBoxWidth - 12;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" role="img" aria-label="${ariaEsc}">`
    + `<title>${ariaEsc}</title>`
    + `<rect x="0.5" y="0.5" width="${totalWidth - 1}" height="${height - 1}" rx="10" fill="${bg}" stroke="${border}" stroke-width="1"/>`
    + renderMark(14, 19, 26, theme)
    + `<text x="52" y="20" fill="${muted}" font-family="${SANS_FONT}" font-size="9" font-weight="700" letter-spacing="0.9">PHAROS SAFETY SCORE</text>`
    + `<text x="52" y="38" fill="${fg}" font-family="${SANS_FONT}" font-size="14" font-weight="700">${symbolEsc || "PHAROS"}</text>`
    + `<text x="52" y="52" fill="${muted}" font-family="${SANS_FONT}" font-size="11" font-weight="500">${nameEsc || "Independent stablecoin analytics"}</text>`
    + `<rect x="${badgeBoxX}" y="11" width="${badgeBoxWidth}" height="42" rx="8" fill="${surface}" stroke="${accent}" stroke-opacity="0.55" stroke-width="1"/>`
    + `<text x="${badgeBoxX + Math.round(badgeBoxWidth / 2)}" y="31" text-anchor="middle" fill="${accent}" font-family="${MONO_FONT}" font-size="${state.kind === "unavailable" || state.kind === "tokenized-fund" ? "11" : "16"}" font-weight="700">${pillLabel}</text>`
    + `<text x="${badgeBoxX + Math.round(badgeBoxWidth / 2)}" y="46" text-anchor="middle" fill="${muted}" font-family="${MONO_FONT}" font-size="10" font-weight="500">${subMetricEsc}</text>`
    + `</svg>`;
}
