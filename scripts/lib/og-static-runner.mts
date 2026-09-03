/* eslint-disable security/detect-non-literal-fs-filename -- callers provide validated generated paths. */
import { firefox } from "playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDirectRun } from "./smoke-runtime.mjs";
import { buildSvgBrowserDocument } from "./og-svg.mts";
import {
  assertNoStaleOgOutputs,
  contentSha256,
  formatOgWriteStatus,
  inspectPublishedOgRoster,
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
  svg: string;
  signature?: Record<string, unknown>;
  signatureSvg?: string;
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
  sourceDir?: string;
  manifestFields?: Record<string, unknown>;
  background?: string;
  includePngHashes?: boolean;
  settleMs?: number;
}

export interface OgStaticCliOptions extends Omit<OgStaticRunnerOptions, "check" | "fonts"> {
  repoRoot: string;
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
  includePngHashes,
}: {
  generatedBy: string;
  manifestFields?: Record<string, unknown>;
  fonts: readonly OgStaticFont[];
  roster: readonly OgStaticCard[];
  publicDir: string;
  includePngHashes: boolean;
}): string {
  const cards: OgStaticManifestCard[] = roster.map((card) => {
    const signature: OgStaticManifestCard = {
      file: card.file,
      ...(card.signature ?? {}),
      svgSha256: contentSha256(card.signatureSvg ?? card.svg),
    };
    if (includePngHashes) {
      const publicPath = resolve(publicDir, card.file);
      signature.pngSha256 = existsSync(publicPath)
        ? contentSha256(readFileSync(publicPath))
        : null;
    }
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

function allPublicOutputsExist(roster: readonly OgStaticCard[], publicDir: string): boolean {
  const { missing, empty } = inspectPublishedOgRoster(roster, publicDir);
  return missing.length === 0 && empty.length === 0;
}

export async function runOgStaticBuild(
  options: OgStaticRunnerOptions,
): Promise<{ changedFiles: string[]; staleFiles: string[] }> {
  const {
    background = "#f8f8fa",
    check,
    family,
    fonts,
    generatedBy,
    includePngHashes = true,
    manifestFields,
    publicDir,
    refreshCommand,
    roster,
    settleMs = 0,
    signaturePath,
    sourceDir,
    stagingDir,
  } = options;
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const existingManifest = existsSync(signaturePath) ? readFileSync(signaturePath, "utf-8") : null;
  const expectedManifest = buildManifest({
    generatedBy,
    manifestFields,
    fonts,
    roster,
    publicDir,
    includePngHashes,
  });

  if (
    check &&
    includePngHashes &&
    existingManifest === expectedManifest &&
    allPublicOutputsExist(roster, publicDir)
  ) {
    for (const card of roster) {
      console.log(formatOgWriteStatus({
        check: true,
        publicPath: resolve(publicDir, card.file),
      }));
    }
    console.log(`${family} OG signatures and PNGs are current.`);
    return { changedFiles: [], staleFiles: [] };
  }

  const browser = await firefox.launch({ headless: true });
  const staleFiles: string[] = [];
  try {
    const artifactResult = await runOgArtifactBuild({
      check,
      family,
      publicDir,
      refreshCommand,
      roster,
      stagingDir,
      assertStale: false,
      render: async (card, { stagedPath }) => {
        const stem = card.file.replace(/\.png$/, "");
        const svgPath = resolve(stagingDir, `${stem}.svg`);
        const htmlPath = resolve(stagingDir, `${stem}.html`);
        writeFileIfChanged(svgPath, card.svg);
        writeFileIfChanged(htmlPath, buildSvgBrowserDocument({
          svg: card.svg,
          background,
          fonts,
        }));

        const page = await browser.newPage({ viewport: { width: 1200, height: 628 } });
        try {
          await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
          await page.evaluate(() => document.fonts.ready);
          if (settleMs > 0) await page.waitForTimeout(settleMs);
          await page.screenshot({
            path: stagedPath,
            omitBackground: false,
            clip: { x: 0, y: 0, width: 1200, height: 628 },
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

    if (sourceDir && !check) {
      mkdirSync(sourceDir, { recursive: true });
      for (const card of roster) {
        writeFileIfChanged(resolve(sourceDir, card.file.replace(/\.png$/, ".svg")), card.svg);
      }
    }

    if (check) {
      if (existingManifest !== expectedManifest) staleFiles.push(signaturePath);
    } else {
      writeFileIfChanged(signaturePath, buildManifest({
        generatedBy,
        manifestFields,
        fonts,
        roster,
        publicDir,
        includePngHashes,
      }));
    }

    assertNoStaleOgOutputs({ family, staleFiles, refreshCommand });
    return { changedFiles: artifactResult.changedFiles, staleFiles };
  } finally {
    await browser.close();
  }
}

export async function runOgStaticCli({
  repoRoot,
  ...options
}: OgStaticCliOptions): Promise<void> {
  try {
    await runOgStaticBuild({
      ...options,
      check: process.argv.includes("--check"),
      fonts: [
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

export function runOgStaticMain(importMetaUrl: string, main: () => Promise<void>): void {
  if (isDirectRun(importMetaUrl, process.argv[1])) void main();
}
