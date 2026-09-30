#!/usr/bin/env node
/**
 * Generate the `/cemetery/` OG image, `public/og-cemetery.png` (1200×630), from the real plot map.
 *
 * The desktop plan is rendered exactly as the hero ships it: register rows → `buildCemeteryPlotMap` (desktop preset)
 * → `desktopPlotLayout` → `PlotMapScene`, rendered to static markup with `react-dom/server` inside the hero's own
 * `.tokens` / `.hero` / `.head` / `.figure` classes, light theme ("surveyor's daylight") at rest. The card keeps the
 * route head ("Stablecoin Cemetery" in Newsreader plus the `{first}–{latest} · each with cause, date, obituary and
 * source` sub-line) and the frost `113` figure, and frames the plan so the colossi and the lighthouse stay in view.
 *
 * Styles without a bundler: the CSS module is loaded through an in-thread Node load hook that returns an identity
 * class map (`hero` → `hero`, parsed from the module with PostCSS), and the stylesheet is the same module with its
 * `:global(…)` wrappers unwrapped, so every class the components emit matches a rule verbatim. The global tokens the
 * module reads (`--foreground`, `--frost-blue`, …) are resolved from the light `:root` blocks of the design-token
 * sheets and `globals.css`, only the ones the module references plus their `var()` closure. Fonts (Newsreader for the
 * title, Geist for text, JetBrains Mono for figures) and the logo atlas are inlined as data URIs, so the page is one
 * self-contained HTML document.
 *
 * Freshness is judged on an INPUT signature, never by re-rendering: Firefox and libvips output differs across
 * platforms. `--check` rebuilds that document (no browser) and compares its SHA-256 with the signature, then verifies
 * the committed PNG still hashes to the value recorded when it was written. Default mode is a no-op when the check
 * passes, so the pre-commit hook never churns the PNG on another OS; `--force` re-renders anyway. Rendering uses
 * Playwright Firefox (the other OG generators' browser) at 1440 px CSS width and 2× device pixels, downscaled to
 * 1200×630 with sharp.
 *
 *   npm run build:og-cemetery
 *   npm run build:og-cemetery -- --check
 *   npm run check:generated-artifacts -- --only=og-cemetery
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";
import postcss, { AtRule } from "postcss";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { sha256Hex, sha256HexFromBytes } from "@shared/lib/sha256";
import { formatRegisterDeathDate } from "@/components/cemetery/cemetery-register-model";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput, type PlotLogoAtlasManifest } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const GENERATED_BY = "scripts/maintenance/build-og-cemetery.ts";
const REFRESH_COMMAND = "npm run build:og-cemetery";

/** Bump when the composition, crop or rendering pipeline changes so the signature rotates. */
export const OG_CEMETERY_GENERATOR_VERSION = 1;

export const OG_CEMETERY_WIDTH = 1200;
export const OG_CEMETERY_HEIGHT = 630;

/**
 * The page is laid out at the 1440 px desktop band (page padding 36 px), the width the hero was tuned at; the card
 * is a 1440 × 756 CSS px crop (1200:630) from just above the route head, captured at 2× and downscaled.
 */
export const OG_CEMETERY_RENDER = {
  viewportWidth: 1440,
  pagePad: 36,
  deviceScaleFactor: 2,
  /** CSS px kept above the route head's top edge. */
  cropAboveHead: 30,
} as const;

/** Repo-relative inputs the document is built from (besides the TypeScript modules it imports). */
export const OG_CEMETERY_FILES = {
  cssModule: "src/components/cemetery/plot-map.module.css",
  tokenSheets: ["src/styles/tokens/primitives.css", "src/styles/tokens/semantic.css", "src/app/globals.css"],
  atlasManifest: "src/lib/cemetery-logo-atlas.generated.json",
  fonts: {
    newsreader: "src/assets/fonts/Newsreader-Variable.subset.woff2",
    geistRegular: "src/assets/fonts/Geist-Regular.woff2",
    geistBold: "src/assets/fonts/Geist-Bold.woff2",
    jetbrainsMono: "src/assets/fonts/JetBrainsMono-Variable.woff2",
  },
} as const;

// ---------------------------------------------------------------------------
// CSS: module class map, global unwrapping, token closure (pure)
// ---------------------------------------------------------------------------

const CLASS_IN_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;
const GLOBAL_WRAPPER = /:global\(([^()]*)\)/g;
const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;
const CUSTOM_PROPERTY = /^--[\w-]+$/;

/**
 * Identity class map for a CSS module: every local class name the module declares maps to itself. Classes that
 * only appear inside `:global(…)` are global in the module, so they are not exported.
 */
export function cssModuleClassMap(css: string): Record<string, string> {
  const names = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent instanceof AtRule && /keyframes$/i.test(rule.parent.name)) return;
    for (const match of rule.selector.replace(GLOBAL_WRAPPER, "").matchAll(CLASS_IN_SELECTOR)) names.add(match[1]);
  });
  return Object.fromEntries([...names].sort().map((name) => [name, name]));
}

/** The module as a plain stylesheet under the identity class map: `:global(.dark) .tokens` → `.dark .tokens`. */
export function unwrapCssModule(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(GLOBAL_WRAPPER, "$1");
  });
  return root.toString();
}

/** Custom properties declared on top-level (or `@layer`-wrapped) `:root` rules, later sheets and rules winning. */
export function rootCustomProperties(sheets: readonly string[]): Map<string, string> {
  const props = new Map<string, string>();
  for (const css of sheets) {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      if (rule.selector.trim() !== ":root") return;
      for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
        if (!(parent instanceof AtRule) || parent.name !== "layer") return;
      }
      rule.walkDecls((decl) => {
        if (CUSTOM_PROPERTY.test(decl.prop)) props.set(decl.prop, decl.value);
      });
    });
  }
  return props;
}

/**
 * The light-theme root tokens a stylesheet needs: every `var(--x)` it reads that it does not declare itself and that
 * `:root` defines, plus the `var()` closure of those values. Properties set inline by the components (the layout
 * variables) are neither declared by the sheet nor on `:root` and are left alone. Throws on a dangling reference
 * inside the closure, which would otherwise render as an unstyled fallback.
 */
export function resolveRootTokens(css: string, rootProps: ReadonlyMap<string, string>): Record<string, string> {
  const declared = new Set<string>();
  const referenced = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    if (CUSTOM_PROPERTY.test(decl.prop)) declared.add(decl.prop);
    for (const match of decl.value.matchAll(VAR_REFERENCE)) referenced.add(match[1]);
  });
  const out = new Map<string, string>();
  const visit = (name: string, from: string | null): void => {
    if (out.has(name)) return;
    const value = rootProps.get(name);
    if (value === undefined) {
      if (from === null) return;
      throw new Error(`Root token ${from} references ${name}, which no :root block defines`);
    }
    out.set(name, value);
    for (const match of value.matchAll(VAR_REFERENCE)) visit(match[1], name);
  };
  for (const name of [...referenced].sort()) if (!declared.has(name)) visit(name, null);
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// Document (server render, no browser)
// ---------------------------------------------------------------------------

let cssModuleHookRegistered = false;

/**
 * Lets Node import `*.module.css` as an identity class map (the bundler's job in the app). In-thread hook, so it
 * applies whether tsx compiles the components to CommonJS or ESM.
 */
function registerCssModuleHook(): void {
  if (cssModuleHookRegistered) return;
  cssModuleHookRegistered = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith(".module.css")) return nextLoad(url, context);
      const classes = cssModuleClassMap(readFileSync(fileURLToPath(url), "utf8"));
      return { format: "commonjs", shortCircuit: true, source: `module.exports = ${JSON.stringify(classes)};\n` };
    },
  });
}

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface OgCemeteryDocument {
  html: string;
  summary: {
    total: number;
    firstYear: number;
    latestYear: number;
    asOf: string;
    atlasImageSha256: string;
  };
}

/** Builds the self-contained card page. Deterministic for fixed inputs; needs no browser. */
export async function buildOgCemeteryDocument(repoRoot = REPO_ROOT): Promise<OgCemeteryDocument> {
  registerCssModuleHook();
  // Dynamic on purpose: both modules import `plot-map.module.css`, which Node can load only once the hook above is
  // registered (static imports would be evaluated before it).
  const [{ PlotMapScene, desktopLayoutStyle, desktopPlotLayout }, { PlotMapDefs, plotTokenStyle }] = await Promise.all([
    import("../../src/components/cemetery/plot-map-scene"),
    import("../../src/components/cemetery/plot-map-shapes"),
  ]);
  const read = (path: string) => readFileSync(resolve(repoRoot, path));

  const stats = buildCemeteryStats(CEMETERY_ENTRIES);
  const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
  const asOf = stats.asOf.date;
  const map = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" });
  const layout = desktopPlotLayout(map);
  // Rows arrive newest first, so the first row is the latest recorded death.
  const latest = rows[0];

  const manifest: PlotLogoAtlasManifest = JSON.parse(read(OG_CEMETERY_FILES.atlasManifest).toString("utf8"));
  if (typeof manifest.image !== "string" || !manifest.image.startsWith("/")) {
    throw new Error(`${OG_CEMETERY_FILES.atlasManifest}: image must be a public path`);
  }
  const atlasBytes = read(`public${manifest.image}`);
  const atlas = { ...toPlotLogoAtlas(manifest), href: dataUri("image/webp", atlasBytes) };

  const moduleCss = read(OG_CEMETERY_FILES.cssModule).toString("utf8");
  const tokens = resolveRootTokens(
    moduleCss,
    rootCustomProperties(OG_CEMETERY_FILES.tokenSheets.map((path) => read(path).toString("utf8"))),
  );

  const scene = h(PlotMapScene, {
    map,
    layout,
    atlas,
    state: { hotId: null, hotFocus: false, pinnedId: null, tabId: map.graves[0]?.id ?? "", dim: null, beamAimed: false, zoom: null, flowers: {} },
  });
  const head = h(
    "div",
    { className: "head" },
    h(
      "header",
      { className: "routeHead og-head" },
      h("h1", { className: "title og-title" }, "Stablecoin Cemetery"),
      h("p", { className: "lead og-lead" }, stats.heroSubline),
    ),
    h(
      "div",
      { className: "figure" },
      h("p", { className: "beamLabel" }, "Recorded deaths"),
      h("p", { className: "figureValue og-value" }, String(stats.total)),
      h(
        "div",
        null,
        h("p", { className: "beamPlaque" }, `${stats.total} interred · first recorded death ${stats.firstYear}`),
        latest
          ? h("p", { className: "beamRest" }, "Latest recorded death · ", h("b", null, latest.name), " · ", h("span", { className: "mono" }, formatRegisterDeathDate(latest.deathDate)))
          : null,
      ),
    ),
  );
  const body = renderToStaticMarkup(
    h(
      "div",
      { className: "tokens og-root", style: plotTokenStyle(atlas) },
      h(PlotMapDefs),
      h("main", { className: "og-page" }, h("section", { className: "hero", style: desktopLayoutStyle(layout) }, head, scene)),
    ),
  );

  const font = (family: string, file: string, weight: string) =>
    `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url("${dataUri("font/woff2", read(file))}") format("woff2");}`;
  const { fonts } = OG_CEMETERY_FILES;
  const { viewportWidth, pagePad } = OG_CEMETERY_RENDER;
  const css = [
    font("Newsreader", fonts.newsreader, "200 800"),
    font("Geist", fonts.geistRegular, "400"),
    font("Geist", fonts.geistBold, "700"),
    font("JetBrains Mono", fonts.jetbrainsMono, "100 800"),
    `:root{${Object.entries(tokens).map(([name, value]) => `${name}:${value};`).join("")}--font-geist-mono:"JetBrains Mono",ui-monospace,monospace;}`,
    unwrapCssModule(moduleCss),
    // Card rules come after the module so they win at equal specificity.
    `html,body{margin:0;padding:0;}`,
    `body{width:${viewportWidth}px;color:var(--foreground);font-family:"Geist",system-ui,sans-serif;-webkit-font-smoothing:antialiased;}`,
    `.og-root{background:var(--sky-0);}`,
    `.og-page{padding:48px ${pagePad}px 0;overflow:hidden;}`,
    // The rest pose (`desktopPlotLayout`) is solved for the route head's measured height (`EST.headH` in
    // plot-map-scene.tsx: title, two-line lead, links); the card's head keeps at least that height so the plan and the
    // colossus chips sit where the hero puts them, clear of the figure.
    `.og-head{min-height:118px;max-width:none;}`,
    `.og-title{font-family:"Newsreader",Georgia,serif;font-size:3.25rem;}`,
    `.og-lead{margin-top:10px;font-size:1.0625rem;white-space:nowrap;}`,
    // FeatureHeroSplit's DEFAULT_BEAM_VALUE_CLASS at ≥ 640 px (pharos-numeric text-[2.45rem] font-semibold leading-none
    // tracking-tight text-frost-blue): the page's only frost text.
    `.og-value{font-family:var(--font-geist-mono);font-variant-numeric:tabular-nums slashed-zero;font-size:2.45rem;font-weight:600;line-height:1;letter-spacing:-0.025em;color:var(--frost-blue);}`,
  ].join("\n");

  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"/><title>Stablecoin Cemetery</title><style>\n${css}\n</style></head><body>${body}</body></html>\n`;
  return {
    html,
    summary: {
      total: stats.total,
      firstYear: stats.firstYear,
      latestYear: stats.latestYear,
      asOf,
      atlasImageSha256: sha256HexFromBytes(atlasBytes),
    },
  };
}

// ---------------------------------------------------------------------------
// Signature and check (pure over files)
// ---------------------------------------------------------------------------

export interface OgCemeteryImageRecord {
  sha256: string;
  bytes: number;
}

export interface OgCemeteryPaths {
  imagePath: string;
  signaturePath: string;
}

export interface OgCemeterySignature {
  generatedBy: string;
  generatorVersion: number;
  render: typeof OG_CEMETERY_RENDER;
  documentSha256: string;
  summary: OgCemeteryDocument["summary"];
  image: OgCemeteryImageRecord & { width: number; height: number };
}

export interface OgCemeteryProblem {
  kind: "missing-signature" | "stale-inputs" | "stale-signature" | "missing-image" | "image-modified" | "image-dimensions";
  message: string;
}

export function buildOgCemeterySignature(document: OgCemeteryDocument, image: OgCemeteryImageRecord): OgCemeterySignature {
  return {
    generatedBy: GENERATED_BY,
    generatorVersion: OG_CEMETERY_GENERATOR_VERSION,
    render: { ...OG_CEMETERY_RENDER },
    documentSha256: sha256Hex(document.html),
    summary: { ...document.summary },
    image: { sha256: image.sha256, bytes: image.bytes, width: OG_CEMETERY_WIDTH, height: OG_CEMETERY_HEIGHT },
  };
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The committed signature's document hash and image record, or null when the file is absent or malformed. */
function readCommittedSignature(path: string): { documentSha256: unknown; image: OgCemeteryImageRecord } | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("image" in parsed)) return null;
  const { image } = parsed;
  if (!image || typeof image !== "object" || !("sha256" in image) || !("bytes" in image)) return null;
  if (typeof image.sha256 !== "string" || typeof image.bytes !== "number") return null;
  return { documentSha256: "documentSha256" in parsed ? parsed.documentSha256 : undefined, image: { sha256: image.sha256, bytes: image.bytes } };
}

/** Platform-stable freshness check: the document hash and the committed PNG hash, never a re-render. */
export async function checkOgCemetery(document: OgCemeteryDocument, paths: OgCemeteryPaths): Promise<OgCemeteryProblem[]> {
  const committed = readCommittedSignature(paths.signaturePath);
  if (!committed) return [{ kind: "missing-signature", message: `${paths.signaturePath} is missing or unreadable` }];

  const problems: OgCemeteryProblem[] = [];
  const documentSha256 = sha256Hex(document.html);
  if (committed.documentSha256 !== documentSha256) {
    problems.push({
      kind: "stale-inputs",
      message: `document signature ${String(committed.documentSha256).slice(0, 12)} != expected ${documentSha256.slice(0, 12)} (a death, the plot map, its styles, fonts or the atlas changed)`,
    });
  }
  if (readFileSync(paths.signaturePath, "utf8") !== serializeJson(buildOgCemeterySignature(document, committed.image))) {
    problems.push({ kind: "stale-signature", message: `${paths.signaturePath} does not match the expected signature` });
  }
  if (!existsSync(paths.imagePath)) {
    problems.push({ kind: "missing-image", message: `${paths.imagePath} is missing` });
    return problems;
  }
  const bytes = readFileSync(paths.imagePath);
  if (sha256HexFromBytes(bytes) !== committed.image.sha256) {
    problems.push({ kind: "image-modified", message: `${paths.imagePath} does not match the hash recorded when it was generated` });
  }
  const { format, width, height } = await sharp(bytes).metadata();
  if (format !== "png" || width !== OG_CEMETERY_WIDTH || height !== OG_CEMETERY_HEIGHT) {
    problems.push({
      kind: "image-dimensions",
      message: `${paths.imagePath} is ${format} ${width}x${height}; expected png ${OG_CEMETERY_WIDTH}x${OG_CEMETERY_HEIGHT}`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Render (browser) and build
// ---------------------------------------------------------------------------

/** Screenshots the document with Playwright Firefox and downscales the 2× capture to the 1200×630 PNG. */
export async function renderOgCemeteryPng(html: string): Promise<Buffer> {
  const { viewportWidth, deviceScaleFactor, cropAboveHead } = OG_CEMETERY_RENDER;
  const cropHeight = Math.round((viewportWidth * OG_CEMETERY_HEIGHT) / OG_CEMETERY_WIDTH);
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: cropHeight + 400 }, deviceScaleFactor });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const headTop = await page.evaluate(() => document.querySelector(".og-head")?.getBoundingClientRect().top ?? null);
    if (headTop === null) throw new Error("og-cemetery: the route head did not render");
    const capture = await page.screenshot({
      clip: { x: 0, y: Math.max(0, headTop - cropAboveHead), width: viewportWidth, height: cropHeight },
      scale: "device",
      timeout: 30_000,
    });
    return await sharp(capture)
      .resize(OG_CEMETERY_WIDTH, OG_CEMETERY_HEIGHT, { fit: "fill", kernel: "lanczos3" })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } finally {
    await browser.close();
  }
}

function writeFileEnsuringDir(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export interface BuildOgCemeteryResult {
  status: "current" | "written";
  document: OgCemeteryDocument;
  imageBytes: number;
}

export async function buildOgCemetery({
  paths,
  force = false,
  render = renderOgCemeteryPng,
  document,
}: {
  paths: OgCemeteryPaths;
  force?: boolean;
  render?: (html: string) => Promise<Buffer>;
  document?: OgCemeteryDocument;
}): Promise<BuildOgCemeteryResult> {
  const doc = document ?? (await buildOgCemeteryDocument());
  if (!force && (await checkOgCemetery(doc, paths)).length === 0) {
    return { status: "current", document: doc, imageBytes: readFileSync(paths.imagePath).length };
  }
  const png = await render(doc.html);
  const { format, width, height } = await sharp(png).metadata();
  if (format !== "png" || width !== OG_CEMETERY_WIDTH || height !== OG_CEMETERY_HEIGHT) {
    throw new Error(`og-cemetery: rendered ${format} ${width}x${height}, expected png ${OG_CEMETERY_WIDTH}x${OG_CEMETERY_HEIGHT}; nothing written`);
  }
  writeFileEnsuringDir(paths.imagePath, png);
  writeFileEnsuringDir(paths.signaturePath, serializeJson(buildOgCemeterySignature(doc, { sha256: sha256HexFromBytes(png), bytes: png.length })));
  return { status: "written", document: doc, imageBytes: png.length };
}

export function defaultOgCemeteryPaths(): OgCemeteryPaths {
  return {
    imagePath: resolve(REPO_ROOT, "public/og-cemetery.png"),
    signaturePath: resolve(REPO_ROOT, "scripts/maintenance/state/og-cemetery-signature.json"),
  };
}

const USAGE = `Usage: node --import tsx scripts/maintenance/build-og-cemetery.ts [--check | --force]

  --check  Verify the committed PNG and signature against the current inputs (no browser, no writes).
  --force  Re-render even when the committed outputs are current.`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { check: { type: "boolean" }, force: { type: "boolean" } },
    conflicts: [["check", "force"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const paths = defaultOgCemeteryPaths();

  if (values.check === true) {
    const document = await buildOgCemeteryDocument();
    const problems = await checkOgCemetery(document, paths);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[og-cemetery] ${problem.kind}: ${problem.message}`);
      throw new Error(`Cemetery OG image is stale (${problems.length} problem(s)). Run \`${REFRESH_COMMAND}\`.`);
    }
    console.log(`Cemetery OG image is current (${document.summary.total} deaths, ${document.summary.firstYear}–${document.summary.latestYear}).`);
    return;
  }

  const result = await buildOgCemetery({ paths, force: values.force === true });
  console.log(
    `${result.status === "current" ? "Cemetery OG image already current" : "Wrote cemetery OG image"}: `
      + `${paths.imagePath} (${OG_CEMETERY_WIDTH}x${OG_CEMETERY_HEIGHT}, ${result.imageBytes} B, ${result.document.summary.total} deaths)`,
  );
}

runDirectCli(import.meta.url, main, { label: "build-og-cemetery", usage: USAGE });
