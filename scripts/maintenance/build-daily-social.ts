/** Render a validated Pharos daily edition using local assets; never fetch or rank data. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firefox } from "playwright";
import { DailySocialSnapshotSchema, buildDailySocialAltText, formatDailySocialValue, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { escapeXml } from "../lib/og-svg.mts";
import { parseStrictCliArgs, requireCliString, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WIDTH = 1600;
const HEIGHT = 1000;
const BG = "#101d29";
const INK = "#f3eee3";
const MUTED = "#b2c0c8";
const RULE = "#354653";
const THEMES: Record<DailySocialSnapshot["topic"], { accent: string; label: string }> = {
  "market-growth": { accent: "#edc77c", label: "THE WEEKLY FLOW" },
  "yield-watch": { accent: "#bed2ac", label: "THE YIELD DESK" },
  "liquidity-growth": { accent: "#a7c8c5", label: "LIQUIDITY HARBOR" },
  "market-share": { accent: "#e5b39b", label: "SHIFTING TIDES" },
  stability: { accent: "#c9cbdc", label: "THE PEG REPORT" },
  safety: { accent: "#dfce9c", label: "THE SAFETY REVIEW" },
  "market-overview": { accent: "#abc3da", label: "THE SUNDAY ATLAS" },
};

function asset(path: string): string {
  const mime = extname(path) === ".svg" ? "image/svg+xml" : extname(path) === ".jpg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function text(x: number, y: number, value: string, size: number, fill = INK, extra = ""): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(value)}</text>`;
}

function wrap(value: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    if (line && (line.length + word.length + 1) > max) { lines.push(line); line = ""; }
    line += `${line ? " " : ""}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

function lines(x: number, y: number, value: string, max: number, size = 20, fill = MUTED, limit = 2): string {
  const wrapped = wrap(value, max);
  return wrapped.slice(0, limit).map((line, index) => text(x, y + index * (size + 7),
    index === limit - 1 && wrapped.length > limit ? `${line}…` : line, size, fill)).join("");
}

function logo(id: string, x: number, y: number, size: number, logos: Record<string, string>): string {
  const local = logos[id] ? resolve(ROOT, "public", logos[id].replace(/^\//, "")) : null;
  // Only registry-owned paths inside public may become embedded assets.
  return local && local.startsWith(`${resolve(ROOT, "public")}/`) && existsSync(local)
    ? `<image href="${asset(local)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`
    : `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${RULE}"/>`;
}

export function renderDailySocialSvg(raw: DailySocialSnapshot): string {
  const input = DailySocialSnapshotSchema.parse(raw);
  const { accent, label } = THEMES[input.topic];
  const logos = JSON.parse(readFileSync(resolve(ROOT, "data/logos.json"), "utf8")) as Record<string, string>;
  const fontCss = [["Bricolage Grotesque", "BricolageGrotesque-Variable.woff2"], ["Newsreader", "Newsreader-Variable.subset.woff2"]]
    .map(([family, file]) => `@font-face{font-family:'${family}';font-weight:200 800;src:url(data:font/woff2;base64,${readFileSync(resolve(ROOT, "src/assets/fonts", file)).toString("base64")}) format('woff2');}`).join("");
  const max = input.unit === "score" ? 100 : Math.max(...input.rows.map((row) => Math.abs(row.value)), 1e-9);
  const value = (row: DailySocialSnapshot["rows"][number]) => formatDailySocialValue(row.value, input.unit);
  const rowName = (row: DailySocialSnapshot["rows"][number]) => row.symbol ?? row.name;
  const scaleLabel = input.unit === "usd" ? "USD / SHARED LINEAR SCALE"
    : input.unit === "percentage-points" ? "PERCENTAGE POINTS / SHARED LINEAR SCALE"
      : input.unit === "score" ? "SCORE / SHARED LINEAR SCALE"
        : `${input.unit.toUpperCase()} / SHARED LINEAR SCALE`;
  let chart = "";

  if (input.topic === "market-growth") {
    const slot = 1472 / input.rows.length;
    chart = input.rows.map((row, index) => {
      const x = 64 + index * slot;
      const height = Math.abs(row.value) / max * 270;
      return `<g data-row="${index + 1}">
        ${text(x, 393, `0${index + 1}`, 24, MUTED)}
        <rect data-value="${row.value}" x="${x}" y="${714 - height}" width="${Math.min(slot - 35, 230)}" height="${height}" fill="${accent}" opacity="${1 - index * 0.12}"/>
        ${text(x, 696 - height, value(row), 35, INK, 'font-weight="600"')}
        ${logo(row.id, x, 734, 36, logos)}
        ${text(x + 48, 763, rowName(row).slice(0, 13), 27)}
        ${lines(x, 802, row.context, Math.floor((slot - 25) / 11), 19, MUTED, 3)}
      </g>`;
    }).join("");
    chart += `<line x1="64" y1="715" x2="1536" y2="715" stroke="${RULE}"/>`;
  } else if (input.topic === "market-share") {
    const zero = 1060;
    chart = `<line x1="${zero}" y1="390" x2="${zero}" y2="859" stroke="${accent}" stroke-dasharray="3 7"/>`;
    chart += text(756, 391, "SHARE LOST", 15, MUTED) + text(1250, 391, "SHARE GAINED", 15, MUTED);
    chart += input.rows.map((row, index) => {
      const y = 417 + index * 87;
      const width = Math.abs(row.value) / max * 230;
      return `<g data-row="${index + 1}">${logo(row.id, 64, y, 38, logos)}
        ${text(122, y + 28, rowName(row).slice(0, 24), 28)}
        ${lines(122, y + 57, row.context, 52, 18, MUTED, 1)}
        <rect data-value="${row.value}" x="${row.value < 0 ? zero - width : zero}" y="${y + 7}" width="${width}" height="30" fill="${accent}" opacity="${row.value < 0 ? 0.55 : 1}"/>
        ${text(row.value < 0 ? zero - width - 16 : zero + width + 16, y + 32, value(row), 28, INK, `text-anchor="${row.value < 0 ? "end" : "start"}"`)}
      </g>`;
    }).join("");
  } else if (input.topic === "market-overview") {
    const total = input.rows.reduce((sum, row) => sum + Math.max(row.value, 0), 0);
    let x = 64;
    chart = input.rows.map((row, index) => {
      const width = total > 0 ? Math.max(row.value, 0) / total * 1472 : 0;
      const segment = `<rect data-value="${row.value}" x="${x}" y="387" width="${width}" height="137" fill="${accent}" opacity="${1 - index * 0.14}" stroke="${BG}" stroke-width="3"/>`;
      x += width;
      return segment;
    }).join("");
    chart += text(64, 555, "COMPOSITION OF THE DISPLAYED MARKET CAPS", 16, MUTED, 'letter-spacing="1.5"');
    chart += input.rows.map((row, index) => {
      const y = 600 + index * 55;
      return `${text(64, y, `0${index + 1}`, 22, accent)}${logo(row.id, 120, y - 28, 32, logos)}
        ${text(168, y, rowName(row).slice(0, 23), 26)}${text(580, y, value(row), 28, INK, 'font-weight="600"')}
        ${lines(885, y, row.context, 54, 19, MUTED, 1)}`;
    }).join("");
  } else if (input.topic === "stability") {
    // The isobars are an illustration; only the labeled row values encode observations.
    chart = `<g opacity="0.22" fill="none" stroke="${accent}">${[110, 155, 200, 245].map((r) => `<ellipse cx="305" cy="607" rx="${r}" ry="${r * 0.76}"/>`).join("")}</g>`;
    chart += text(305, 587, "PEG", 84, accent, 'text-anchor="middle" style="font-family:Newsreader"');
    chart += text(305, 649, "CONDITIONS", 25, INK, 'text-anchor="middle" letter-spacing="5"');
    chart += input.rows.map((row, index) => {
      const y = 412 + index * 91;
      return `<line x1="630" y1="${y + 65}" x2="1536" y2="${y + 65}" stroke="${RULE}"/>
        ${text(630, y + 9, rowName(row).slice(0, 33), 27)}
        ${text(1536, y + 14, value(row), 36, accent, 'text-anchor="end"')}
        ${lines(630, y + 41, row.context, 84, 19, MUTED, 1)}`;
    }).join("");
  } else {
    chart = input.rows.map((row, index) => {
      const y = 394 + index * 95;
      const width = Math.abs(row.value) / max * 540;
      const safety = input.topic === "safety";
      const yieldWatch = input.topic === "yield-watch";
      const track = safety
        ? `<line x1="620" y1="${y + 26}" x2="1160" y2="${y + 26}" stroke="${RULE}" stroke-width="2"/>
          ${[0, 1, 2, 3, 4].map((tick) => `<line x1="${620 + tick * 135}" y1="${y + 17}" x2="${620 + tick * 135}" y2="${y + 35}" stroke="${RULE}"/>`).join("")}
          <circle data-value="${row.value}" cx="${620 + width}" cy="${y + 26}" r="10" fill="${accent}"/>`
        : `<rect x="620" y="${y + 17}" width="540" height="${yieldWatch ? 8 : 28}" fill="#203340"/>
          <rect data-value="${row.value}" x="620" y="${y + 17}" width="${width}" height="${yieldWatch ? 8 : 28}" fill="${accent}" opacity="${1 - index * 0.1}"/>`;
      return `<g data-row="${index + 1}">
        ${text(64, y + 30, `0${index + 1}`, 25, accent)}${logo(row.id, 124, y, 42, logos)}
        ${text(188, y + 30, rowName(row).slice(0, 23), 29)}${track}
        ${text(1536, y + 36, value(row), 39, accent, 'text-anchor="end" font-weight="600"')}
        ${lines(188, y + 59, row.context, 128, 18, MUTED, 2)}
        <line x1="64" y1="${y + 86}" x2="1536" y2="${y + 86}" stroke="${RULE}"/>
      </g>`;
    }).join("");
  }

  const asOf = new Date(input.asOf * 1000).toISOString().slice(0, 16).replace("T", " ");
  const highlights = input.highlights.map((item, index) => {
    const slot = 1472 / Math.max(input.highlights.length, 1);
    const x = 64 + index * slot;
    return text(x, 290, item.label.toUpperCase(), Math.min(16, (slot - 28) / Math.max(item.label.length * 0.65, 1)), MUTED, 'letter-spacing="1"')
      + text(x, 326, item.value, Math.min(29, (slot - 28) / Math.max(item.value.length * 0.56, 1)), accent, 'font-weight="600"');
  }).join("");
  const sourceLine = `${input.editionDate} EDITION · AS OF ${asOf} UTC · ${input.source}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
    <title id="title">${escapeXml(input.title)}</title><desc id="description">${escapeXml(buildDailySocialAltText(input))}</desc>
    <style>${fontCss}text{font-family:'Bricolage Grotesque',sans-serif;font-variant-numeric:tabular-nums}</style>
    <rect width="1600" height="1000" fill="${BG}"/>
    <path d="M1190 0 L1600 0 L1600 242 Z" fill="${accent}" opacity="0.07"/>
    <path d="M1250 0 L1600 210 M1370 0 L1600 137 M1490 0 L1600 65" stroke="${accent}" opacity="0.16"/>
    <image href="${asset(resolve(ROOT, "public/pharos-mark-on-dark.svg"))}" x="64" y="35" width="43" height="43"/>
    ${text(124, 66, "PHAROS", 27, INK, 'letter-spacing="4" font-weight="650"')}
    ${text(1536, 65, label, 20, accent, 'text-anchor="end" letter-spacing="2"')}
    <line x1="64" y1="101" x2="1536" y2="101" stroke="${RULE}"/>
    ${text(64, 186, input.title, Math.min(71, 2380 / Math.max(input.title.length, 1)), INK, 'style="font-family:Newsreader"')}
    ${lines(64, 233, input.subtitle, 129, 23, MUTED, 1)}
    ${highlights}
    <line x1="64" y1="351" x2="1536" y2="351" stroke="${accent}"/>
    ${text(1536, 377, input.topic === "stability" ? "OBSERVED PEG CONDITIONS" : input.unit === "score" ? "SCORE / 0–100 SCALE" : scaleLabel, 14, MUTED, 'text-anchor="end" letter-spacing="1"')}
    ${chart}
    <line x1="64" y1="898" x2="1536" y2="898" stroke="${RULE}"/>
    ${lines(64, 920, input.methodology, 150, 16, MUTED, 3)}
    ${text(64, 989, sourceLine, Math.min(15, 1200 / (sourceLine.length * 0.55)), MUTED)}
    ${text(1536, 975, "pharos.watch", 26, accent, 'text-anchor="end" font-weight="600"')}
  </svg>`;
}

const USAGE = "Usage: npx tsx scripts/maintenance/build-daily-social.ts --input snapshot.json --out poster.png";

export async function main(argv: string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, { options: { input: { type: "string" }, out: { type: "string" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const inputPath = requireCliString(values.input, "--input");
  const out = resolve(requireCliString(values.out, "--out"));
  if (!out.endsWith(".png")) throw new Error("--out must end in .png");
  const input = DailySocialSnapshotSchema.parse(JSON.parse(readFileSync(inputPath, "utf8")));
  const svg = renderDailySocialSvg(input);
  const base = out.slice(0, -4);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${base}.svg`, svg);
  writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:${BG}}svg{display:block}</style>${svg}`);
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    // All poster resources must be embedded, including fonts and coin logos.
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.goto(pathToFileURL(`${base}.html`).href, { waitUntil: "load" });
    const fontsLoaded = await page.evaluate(async () => {
      const fonts = ["24px 'Newsreader'", "24px 'Bricolage Grotesque'"];
      await Promise.all(fonts.map((font) => document.fonts.load(font)));
      await document.fonts.ready;
      return fonts.every((font) => document.fonts.check(font));
    });
    if (!fontsLoaded) throw new Error("Poster fonts failed to load");
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  } finally {
    await browser.close();
  }
  writeFileSync(`${base}.alt.txt`, `${buildDailySocialAltText(input)}\n`);
  console.log(`Rendered ${out}`);
}

if (isDirectRun(import.meta.url, process.argv[1])) void runCliEntrypoint(() => main(process.argv.slice(2)), { label: "daily-social", usage: USAGE });
