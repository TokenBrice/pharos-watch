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
 * The rendering pipeline is the scene kit's (`scripts/lib/scene-og.ts`); this script is the cemetery's configuration
 * and composition. Styles without a bundler: the CSS module is loaded through an in-thread Node load hook that returns
 * an identity class map (`hero` → `hero`), and the stylesheet is the same module with its `:global(…)` wrappers
 * unwrapped, so every class the components emit matches a rule verbatim. The global tokens the
 * module reads (`--foreground`, `--frost-blue`, …) are resolved from the light `:root` blocks of the design-token
 * sheets and `globals.css`, only the ones the module references plus their `var()` closure. Fonts (Newsreader for the
 * title, Geist for text, JetBrains Mono for figures) and the logo atlas are inlined as data URIs, so the page is one
 * self-contained HTML document.
 *
 * Freshness is judged on an INPUT signature, never by re-rendering: Firefox and libvips output differs across
 * platforms. `--check` rebuilds that document (no browser) and compares its SHA-256 with the signature, then verifies
 * the committed PNG still hashes to the value recorded when it was written. Default mode is a no-op when the check
 * passes, avoiding PNG churn on another OS; `--force` re-renders anyway. Rendering uses
 * Playwright Firefox (the other OG generators' browser) at 1440 px CSS width and 2× device pixels, downscaled to
 * 1200×630 with sharp.
 *
 *   npm run build:og-cemetery
 *   npm run build:og-cemetery -- --check
 *   npm run check:generated-artifacts -- --only=og-cemetery
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { sha256Hex, sha256HexFromBytes } from "@shared/lib/sha256";
import { formatRegisterDeathDate } from "@/components/cemetery/cemetery-register-model";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput, type PlotLogoAtlasManifest } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  buildSignedPng,
  checkSignedPng,
  dataUri,
  registerCssModuleHook,
  renderScenePng,
  resolveRootTokens,
  rootCustomProperties,
  unwrapCssModule,
  woff2FontFace,
  type SignedPngImageRecord,
  type SignedPngPaths,
  type SignedPngProblem,
  type SignedPngSpec,
} from "../lib/scene-og";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const GENERATED_BY = "scripts/maintenance/build-og-cemetery.ts";
const REFRESH_COMMAND = "npm run build:og-cemetery";

/** Bump when the composition, crop or rendering pipeline changes so the signature rotates. */
export const OG_CEMETERY_GENERATOR_VERSION = 2;

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

/**
 * 256-colour palette PNG with full Floyd–Steinberg dither: 141 KB instead of 531 KB lossless (measured 2026-09-30:
 * mean |Δ| 0.42 per channel, 0.06 % of pixels off by more than 8), indistinguishable at 100 %.
 */
export const OG_CEMETERY_PNG_OPTIONS = {
  palette: true,
  colours: 256,
  quality: 100,
  dither: 1,
  effort: 10,
  compressionLevel: 9,
} as const;

/** Repo-relative inputs the document is built from (besides the TypeScript modules it imports). */
export const OG_CEMETERY_FILES = {
  /** Inlined in the order the app imports them: the scene kit (which `.tokens` / `.map` compose), then the art. */
  cssModules: ["src/components/scene/scene-tokens.module.css", "src/components/cemetery/plot-map.module.css"],
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
// Document (server render, no browser)
// ---------------------------------------------------------------------------

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

  const moduleCss = OG_CEMETERY_FILES.cssModules.map((path) => read(path).toString("utf8")).join("\n");
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

  const font = (family: string, file: string, weight: string) => woff2FontFace(family, weight, read(file));
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
// Signature, check, render and build (the kit pipeline, cemetery parameters)
// ---------------------------------------------------------------------------

export interface OgCemeterySignature {
  generatedBy: string;
  generatorVersion: number;
  render: typeof OG_CEMETERY_RENDER;
  png: typeof OG_CEMETERY_PNG_OPTIONS;
  documentSha256: string;
  summary: OgCemeteryDocument["summary"];
  image: SignedPngImageRecord & { width: number; height: number };
}

export function buildOgCemeterySignature(document: OgCemeteryDocument, image: SignedPngImageRecord): OgCemeterySignature {
  return {
    generatedBy: GENERATED_BY,
    generatorVersion: OG_CEMETERY_GENERATOR_VERSION,
    render: { ...OG_CEMETERY_RENDER },
    png: { ...OG_CEMETERY_PNG_OPTIONS },
    documentSha256: sha256Hex(document.html),
    summary: { ...document.summary },
    image: { sha256: image.sha256, bytes: image.bytes, width: OG_CEMETERY_WIDTH, height: OG_CEMETERY_HEIGHT },
  };
}

function signedPngSpec(document: OgCemeteryDocument): SignedPngSpec {
  return {
    html: document.html,
    signature: (image) => buildOgCemeterySignature(document, image),
    width: OG_CEMETERY_WIDTH,
    height: OG_CEMETERY_HEIGHT,
    staleHint: "a death, the plot map, its styles, fonts or the atlas changed",
    label: "og-cemetery",
  };
}

/** Platform-stable freshness check (the kit's `checkSignedPng`): the document hash and the committed PNG hash. */
export async function checkOgCemetery(document: OgCemeteryDocument, paths: SignedPngPaths): Promise<SignedPngProblem[]> {
  return checkSignedPng(signedPngSpec(document), paths);
}

/** Screenshots the document with Playwright Firefox and downscales the 2× capture to the 1200×630 PNG. */
export async function renderOgCemeteryPng(html: string): Promise<Buffer> {
  const { viewportWidth, deviceScaleFactor, cropAboveHead } = OG_CEMETERY_RENDER;
  return renderScenePng(html, {
    viewportWidth,
    deviceScaleFactor,
    width: OG_CEMETERY_WIDTH,
    height: OG_CEMETERY_HEIGHT,
    anchorSelector: ".og-head",
    cropAbove: cropAboveHead,
    png: OG_CEMETERY_PNG_OPTIONS,
    label: "og-cemetery",
  });
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
  paths: SignedPngPaths;
  force?: boolean;
  render?: (html: string) => Promise<Buffer>;
  document?: OgCemeteryDocument;
}): Promise<BuildOgCemeteryResult> {
  const doc = document ?? (await buildOgCemeteryDocument());
  const { status, imageBytes } = await buildSignedPng({ spec: signedPngSpec(doc), paths, render, force });
  return { status, document: doc, imageBytes };
}

export function defaultOgCemeteryPaths(): SignedPngPaths {
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
