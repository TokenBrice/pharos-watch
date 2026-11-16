import { firefox } from "playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSvgBrowserDocument } from "./og-svg.mts";
import { OG_RESVG_RUNTIME_SOURCE_PATHS, renderSvgPngWithResvg } from "./og-resvg-render.mts";
import {
  assertNoStaleOgOutputs,
  contentSha256,
  formatOgWriteStatus,
  runOgArtifactBuild,
  writeFileIfChanged,
} from "./og-image-checks.mts";

export interface OgStaticFont {
  key: string;
  family: string;
  file: string;
  weight: string | number;
  style?: string;
}

export interface OgStaticCard {
  file: string;
  sourceFingerprint?: string;
  svg: string;
  signature?: Record<string, unknown>;
}

export interface OgStaticRunnerOptions {
  check: boolean;
  family: string;
  fonts: readonly OgStaticFont[];
  generatedBy: string;
  publicDir: string;
  refreshCommand: string;
  roster: readonly OgStaticCard[];
  signaturePath: string;
  stagingDir: string;
  manifestFields?: Record<string, unknown>;
  background?: string;
  width?: number;
  height?: number;
  renderer?: "firefox" | "resvg";
}

export interface OgStaticCliOptions extends Omit<OgStaticRunnerOptions, "check" | "fonts"> {
  repoRoot: string;
  /** Defaults to the editorial pair (Newsreader + Geist Mono). */
  fonts?: readonly OgStaticFont[];
}

interface OgStaticManifestCard {
  file: string;
  [key: string]: unknown;
}

function buildManifest({
  generatedBy,
  manifestFields = {},
  fonts,
  roster,
  publicDir,
}: {
  generatedBy: string;
  manifestFields?: Record<string, unknown>;
  fonts: readonly OgStaticFont[];
  roster: readonly OgStaticCard[];
  publicDir: string;
}): string {
  const cards: OgStaticManifestCard[] = roster.map((card) => {
    const signature: OgStaticManifestCard = {
      file: card.file,
      ...(card.signature ?? {}),
      svgSha256: contentSha256(card.svg),
      sourceFingerprint: card.sourceFingerprint,
    };
    const publicPath = resolve(publicDir, card.file);
    signature.pngSha256 = existsSync(publicPath)
      ? contentSha256(readFileSync(publicPath))
      : null;
    return signature;
  });

  return `${JSON.stringify(
    {
      generatedBy,
      ...manifestFields,
      fonts: Object.fromEntries(
        fonts.map((font) => [font.key, contentSha256(readFileSync(font.file))]),
      ),
      cards,
    },
    null,
    2,
  )}\n`;
}

export function buildOgStaticRenderInputs({
  fonts,
  background = "#f8f8fa",
  width = 1200,
  height = 628,
  renderer = "firefox",
}: Pick<OgStaticRunnerOptions, "fonts" | "background" | "width" | "height" | "renderer">) {
  return {
    fonts: fonts.map((font) => ({ ...font, file: contentSha256(readFileSync(font.file)) })),
    background,
    width,
    height,
    renderer,
    runtimeFingerprint: contentSha256(Buffer.concat((renderer === "resvg"
      ? OG_RESVG_RUNTIME_SOURCE_PATHS.map((file) => new URL(`../../${file}`, import.meta.url))
      : [new URL("../../node_modules/playwright-core/browsers.json", import.meta.url)]).map((file) => readFileSync(file)))),
    rendererFingerprint: contentSha256(Buffer.concat([
      readFileSync(new URL(import.meta.url)),
      readFileSync(new URL("./og-svg.mts", import.meta.url)),
      readFileSync(new URL("./og-image-checks.mts", import.meta.url)),
      ...(renderer === "resvg" ? [readFileSync(new URL("./og-resvg-render.mts", import.meta.url))] : []),
    ])),
  };
}

export function buildOgStaticSourceFingerprint(
  svg: string,
  renderInputs: ReturnType<typeof buildOgStaticRenderInputs>,
): string {
  return contentSha256(JSON.stringify({ svg, ...renderInputs }));
}

export async function runOgStaticBuild(
  options: OgStaticRunnerOptions,
): Promise<{ changedFiles: string[]; staleFiles: string[] }> {
  const {
    background = "#f8f8fa",
    width = 1200,
    height = 628,
    check,
    family,
    fonts,
    generatedBy,
    manifestFields,
    publicDir,
    refreshCommand,
    roster,
    signaturePath,
    stagingDir,
    renderer = "firefox",
  } = options;
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const renderInputs = buildOgStaticRenderInputs({ fonts, background, width, height, renderer });
  const renderedRoster = roster.map((card) => ({
    ...card,
    sourceFingerprint: buildOgStaticSourceFingerprint(card.svg, renderInputs),
  }));

  const existingManifest = existsSync(signaturePath) ? readFileSync(signaturePath, "utf-8") : null;
  const expectedManifest = buildManifest({
    generatedBy,
    manifestFields,
    fonts,
    roster: renderedRoster,
    publicDir,
  });

  // The checked-in manifest is evidence to compare, not proof that the PNG
  // was rendered from this source: a source-only signature edit can match it.
  // Always render in check mode and compare pixels against the published PNG.
  const browser = renderer === "firefox" ? await firefox.launch({ headless: true }) : null;
  const fontBuffers = renderer === "resvg" ? fonts.map((font) => readFileSync(font.file)) : [];
  const staleFiles: string[] = [];
  try {
    const artifactResult = await runOgArtifactBuild({
      check,
      family,
      publicDir,
      refreshCommand,
      roster: renderedRoster,
      stagingDir,
      assertStale: false,
      render: async (card, { stagedPath }) => {
        if (browser === null) {
          writeFileIfChanged(stagedPath, await renderSvgPngWithResvg({ svg: card.svg, fontBuffers, background, width }));
          return;
        }
        const stem = card.file.replace(/\.png$/, "");
        const svgPath = resolve(stagingDir, `${stem}.svg`);
        const htmlPath = resolve(stagingDir, `${stem}.html`);
        writeFileIfChanged(svgPath, card.svg);
        writeFileIfChanged(htmlPath, buildSvgBrowserDocument({
          svg: card.svg,
          background,
          fonts,
        }));

        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: stagedPath,
            omitBackground: false,
            clip: { x: 0, y: 0, width, height },
            timeout: 30000,
          });
        } finally {
          await page.close();
          unlinkSync(svgPath);
          unlinkSync(htmlPath);
        }
      },
      onResult: (_card, { changed, publicPath }) => {
        console.log(formatOgWriteStatus({ check, changed, publicPath }));
      },
    });
    staleFiles.push(...artifactResult.staleFiles);

    if (check) {
      if (existingManifest !== expectedManifest) staleFiles.push(signaturePath);
    } else {
      writeFileIfChanged(signaturePath, buildManifest({
        generatedBy,
        manifestFields,
        fonts,
        roster: renderedRoster,
        publicDir,
      }));
    }

    assertNoStaleOgOutputs({ family, staleFiles, refreshCommand });
    return { changedFiles: artifactResult.changedFiles, staleFiles };
  } finally {
    await browser?.close();
  }
}

export async function runOgStaticCli({
  repoRoot,
  fonts,
  ...options
}: OgStaticCliOptions): Promise<void> {
  try {
    await runOgStaticBuild({
      ...options,
      check: process.argv.includes("--check"),
      fonts: fonts ?? [
        {
          key: "newsreader",
          family: "Newsreader",
          file: resolve(repoRoot, "src/assets/fonts/Newsreader-Variable.subset.woff2"),
          weight: "200 800",
        },
        {
          key: "geistMono",
          family: "GeistMono",
          file: resolve(repoRoot, "src/assets/fonts/GeistMono-Regular.woff2"),
          weight: "400 700",
        },
      ],
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}


