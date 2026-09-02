/* eslint-disable security/detect-non-literal-fs-filename -- helpers operate on explicit caller-selected generated asset paths. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { firefox } from "playwright";
import sharp from "sharp";
import { buildSvgBrowserDocument } from "./og-svg.mts";

interface PngComparisonTolerance {
  maxMeanAbsPerChannel: number;
  maxChangedPixelRatio: number;
  changedPixelThreshold: number;
}

interface PngComparison {
  matches: boolean;
  summary: string;
}

const DEFAULT_TOLERANCE: PngComparisonTolerance = {
  maxMeanAbsPerChannel: 2.5,
  maxChangedPixelRatio: 0.04,
  changedPixelThreshold: 8,
};

export async function comparePngContent(
  expectedPath: string,
  actualPath: string,
  tolerance: PngComparisonTolerance = DEFAULT_TOLERANCE,
): Promise<PngComparison> {
  const expected = await sharp(expectedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const actual = await sharp(actualPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (
    expected.info.width !== actual.info.width ||
    expected.info.height !== actual.info.height ||
    expected.info.channels !== actual.info.channels
  ) {
    return {
      matches: false,
      summary: `dimension/channel mismatch expected ${expected.info.width}x${expected.info.height}x${expected.info.channels}, got ${actual.info.width}x${actual.info.height}x${actual.info.channels}`,
    };
  }

  let totalAbs = 0;
  let changedPixels = 0;
  const { data: expectedData } = expected;
  const { data: actualData } = actual;
  const channels = expected.info.channels;
  const pixelCount = expected.info.width * expected.info.height;
  for (let offset = 0; offset < expectedData.length; offset += channels) {
    let pixelDelta = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const channelDelta = Math.abs(expectedData[offset + channel] - actualData[offset + channel]);
      pixelDelta += channelDelta;
      totalAbs += channelDelta;
    }
    if (pixelDelta / channels > tolerance.changedPixelThreshold) {
      changedPixels += 1;
    }
  }

  const meanAbsPerChannel = totalAbs / expectedData.length;
  const changedPixelRatio = changedPixels / pixelCount;
  return {
    matches:
      meanAbsPerChannel <= tolerance.maxMeanAbsPerChannel &&
      changedPixelRatio <= tolerance.maxChangedPixelRatio,
    summary: `meanAbsPerChannel=${meanAbsPerChannel.toFixed(3)}, changedPixels=${(changedPixelRatio * 100).toFixed(2)}%`,
  };
}

export async function stalePngCheckLabel({
  fileLabel,
  expectedPath,
  actualPath,
}: { fileLabel: string; expectedPath: string; actualPath: string }): Promise<string | null> {
  const expected = existsSync(expectedPath) ? readFileSync(expectedPath) : null;
  const actual = readFileSync(actualPath);
  if (!expected) {
    return fileLabel;
  }
  if (!actual.equals(expected)) {
    const comparison = await comparePngContent(expectedPath, actualPath);
    if (comparison.matches) {
      console.warn(`${fileLabel}: byte-level PNG drift tolerated (${comparison.summary})`);
      return null;
    }
    return `${fileLabel} (${comparison.summary})`;
  }
  return null;
}

export async function promoteGeneratedPngIfChanged({
  stagedPath,
  publicPath,
}: { stagedPath: string; publicPath: string }): Promise<boolean> {
  const staged = readFileSync(stagedPath);
  const existing = existsSync(publicPath) ? readFileSync(publicPath) : null;
  if (existing?.equals(staged)) {
    unlinkSync(stagedPath);
    return false;
  }
  if (existing) {
    const comparison = await comparePngContent(publicPath, stagedPath);
    if (comparison.matches) {
      unlinkSync(stagedPath);
      return false;
    }
  }

  renameSync(stagedPath, publicPath);
  return true;
}

export function writeFileIfChanged(path: string, contents: string | Uint8Array): boolean {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const existing = existsSync(path) ? readFileSync(path) : null;
  if (existing?.equals(next)) return false;
  writeFileSync(path, next);
  return true;
}

export function formatOgWriteStatus({
  check,
  changed = true,
  publicPath,
  suffix = "",
}: { check: boolean; changed?: boolean; publicPath: string; suffix?: string }): string {
  const action = check ? "Checked" : changed ? "Wrote" : "Unchanged";
  return `${action} ${publicPath}${suffix}`;
}

export function assertNoStaleOgOutputs({
  family,
  staleFiles,
  refreshCommand,
}: { family: string; staleFiles: readonly string[]; refreshCommand: string }): void {
  if (staleFiles.length === 0) return;
  throw new Error(
    `${family} OG images are stale: ${staleFiles.join(", ")}. Run \`${refreshCommand}\` to refresh them.`,
  );
}

export function contentSha256(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function validateGeneratedPng(path: string): Promise<void> {
  if (!existsSync(path) || readFileSync(path).length === 0) throw new Error(`Generated PNG is missing or empty: ${path}`);
  const metadata = await sharp(path).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) {
    throw new Error(`Generated artifact is not a valid PNG: ${path}`);
  }
}

export interface OgArtifactRosterEntry {
  file: string;
}

export interface OgArtifactRenderContext {
  stagedPath: string;
  stagingDir: string;
  publicPath: string;
}

export async function runOgArtifactBuild<T extends OgArtifactRosterEntry>({
  check,
  family,
  publicDir,
  refreshCommand,
  roster,
  stagingDir,
  render,
  onResult,
  cleanup = true,
  assertStale = true,
}: {
  check: boolean;
  family: string;
  publicDir: string;
  refreshCommand: string;
  roster: readonly T[];
  stagingDir: string;
  render: (entry: T, context: OgArtifactRenderContext) => Promise<void>;
  onResult?: (entry: T, result: { changed: boolean; publicPath: string; staleLabel: string | null }) => void;
  cleanup?: boolean;
  assertStale?: boolean;
}): Promise<{ changedFiles: string[]; staleFiles: string[] }> {
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  const changedFiles: string[] = [];
  const staleFiles: string[] = [];
  try {
    for (const entry of roster) {
      const publicPath = resolve(publicDir, entry.file);
      const stagedPath = resolve(stagingDir, `${entry.file}.${check ? "check" : `write-${process.pid}`}.png`);
      await render(entry, { stagedPath, stagingDir, publicPath });
      await validateGeneratedPng(stagedPath);
      let changed = false;
      let staleLabel: string | null = null;
      if (check) {
        staleLabel = await stalePngCheckLabel({ fileLabel: entry.file, expectedPath: publicPath, actualPath: stagedPath });
        if (staleLabel) staleFiles.push(staleLabel);
        unlinkSync(stagedPath);
      } else {
        changed = await promoteGeneratedPngIfChanged({ stagedPath, publicPath });
        if (changed) changedFiles.push(entry.file);
      }
      onResult?.(entry, { changed, publicPath, staleLabel });
    }
    if (assertStale) assertNoStaleOgOutputs({ family, staleFiles, refreshCommand });
    return { changedFiles, staleFiles };
  } finally {
    if (cleanup) rmSync(stagingDir, { recursive: true, force: true });
  }
}

interface OgPlaywrightSignature extends OgArtifactRosterEntry {
  pngSha256?: string | null;
}

interface OgPlaywrightRenderInput<TSignature extends OgPlaywrightSignature> extends OgArtifactRosterEntry {
  sourceBasename: string;
  signature: TSignature;
  svg: string;
}

function withPngSignatures<TSignature extends OgPlaywrightSignature>(
  signatures: readonly TSignature[],
  publicDir: string,
): Array<TSignature & { pngSha256: string | null }> {
  return signatures.map((signature) => {
    const publicPath = resolve(publicDir, signature.file);
    return {
      ...signature,
      pngSha256: existsSync(publicPath) ? contentSha256(readFileSync(publicPath)) : null,
    };
  });
}

function stripPngSignatures<TSignature extends OgPlaywrightSignature>(
  manifest: string | null,
  signatures: readonly TSignature[],
): string | null {
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(manifest) as { cards: Array<Record<string, unknown>> };
    parsed.cards = parsed.cards.map((signature, index) => Object.fromEntries(
      Object.keys(signatures[index] ?? {}).map((key) => [key, signature[key]]),
    ));
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return null;
  }
}

function stalePngSignatureLabels(
  manifest: string | null,
  roster: readonly OgArtifactRosterEntry[],
  publicDir: string,
): string[] {
  if (!manifest) return roster.map((entry) => entry.file);
  try {
    const parsed = JSON.parse(manifest) as { cards: OgPlaywrightSignature[] };
    return parsed.cards
      .filter((signature) => {
        const publicPath = resolve(publicDir, signature.file);
        return !signature.pngSha256 || signature.pngSha256 !== contentSha256(readFileSync(publicPath));
      })
      .map((signature) => signature.file);
  } catch {
    return roster.map((entry) => entry.file);
  }
}

function buildCompactSvgBrowserDocument({
  background,
  fonts,
  svg,
}: {
  background: string;
  fonts: readonly { family: string; file: string; weight: string | number; style?: string }[];
  svg: string;
}): string {
  const fontFaces = fonts.map(({ family, file, weight, style = "normal" }) =>
    `  @font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; src: url('${pathToFileURL(file).href}') format('woff2'); font-display: block; }`,
  ).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
${fontFaces}
  html, body { margin: 0; padding: 0; background: ${background}; } svg { display: block; }
</style></head><body>${svg}</body></html>`;
}

export async function runOgPlaywrightFamily<T extends OgArtifactRosterEntry, TSignature extends OgPlaywrightSignature>({
  background,
  buildRenderInput,
  buildSignatureManifest,
  check,
  compactDocument = false,
  cleanupSources = false,
  cleanupStaging = true,
  family,
  fonts,
  includePngSignatures = false,
  onResult,
  publicDir,
  refreshCommand,
  roster,
  signatureFastPath = false,
  signaturePath,
  signatureStaleLabel,
  skippedMessage,
  stagingDir,
  waitAfterFontsMs = 0,
}: {
  background: string;
  buildRenderInput: (entry: T) => OgPlaywrightRenderInput<TSignature>;
  buildSignatureManifest: (signatures: TSignature[]) => string;
  check: boolean;
  compactDocument?: boolean;
  cleanupSources?: boolean;
  cleanupStaging?: boolean;
  family: string;
  fonts: readonly { family: string; file: string; weight: string | number; style?: string }[];
  includePngSignatures?: boolean;
  onResult: (entry: T, result: { changed: boolean; publicPath: string }) => void;
  publicDir: string;
  refreshCommand: string;
  roster: readonly T[];
  signatureFastPath?: boolean;
  signaturePath: string;
  signatureStaleLabel: string;
  skippedMessage?: string;
  stagingDir: string;
  waitAfterFontsMs?: number;
}): Promise<{ changedFiles: string[]; staleFiles: string[]; skipped: boolean }> {
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(dirname(signaturePath), { recursive: true });

  const renderInputs = roster.map((entry) => ({ entry, ...buildRenderInput(entry) }));
  const signatures = renderInputs.map(({ signature }) => signature);
  const inputSignatureManifest = buildSignatureManifest(signatures);
  const expectedSignatureManifest = includePngSignatures
    ? buildSignatureManifest(withPngSignatures(signatures, publicDir))
    : inputSignatureManifest;
  const existingSignatureManifest = existsSync(signaturePath) ? readFileSync(signaturePath, "utf8") : null;
  const allPublicOutputsExist = roster.every((entry) => existsSync(resolve(publicDir, entry.file)));

  if (
    check &&
    signatureFastPath &&
    existingSignatureManifest === expectedSignatureManifest &&
    allPublicOutputsExist
  ) {
    for (const entry of roster) onResult(entry, { changed: false, publicPath: resolve(publicDir, entry.file) });
    if (skippedMessage) console.log(skippedMessage);
    return { changedFiles: [], staleFiles: [], skipped: true };
  }

  if (
    check &&
    signatureFastPath &&
    allPublicOutputsExist &&
    stripPngSignatures(existingSignatureManifest, signatures) === inputSignatureManifest
  ) {
    assertNoStaleOgOutputs({
      family,
      staleFiles: stalePngSignatureLabels(existingSignatureManifest, roster, publicDir),
      refreshCommand,
    });
  }

  const browser = await firefox.launch({ headless: true });
  const staleFiles: string[] = [];
  try {
    const artifactResult = await runOgArtifactBuild({
      check,
      family,
      publicDir,
      refreshCommand,
      roster: renderInputs,
      stagingDir,
      cleanup: cleanupStaging,
      assertStale: false,
      render: async (input, { stagedPath }) => {
        const svgPath = resolve(stagingDir, `${input.sourceBasename}.svg`);
        const htmlPath = resolve(stagingDir, `${input.sourceBasename}.html`);
        writeFileSync(svgPath, input.svg);
        writeFileSync(
          htmlPath,
          compactDocument
            ? buildCompactSvgBrowserDocument({ svg: input.svg, background, fonts })
            : buildSvgBrowserDocument({ svg: input.svg, background, fonts }),
        );
        const page = await browser.newPage({ viewport: { width: 1200, height: 628 } });
        try {
          await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
          await page.evaluate(() => document.fonts.ready);
          if (waitAfterFontsMs > 0) await page.waitForTimeout(waitAfterFontsMs);
          await page.screenshot({
            path: stagedPath,
            omitBackground: false,
            clip: { x: 0, y: 0, width: 1200, height: 628 },
            timeout: 30000,
          });
        } finally {
          await page.close();
          if (cleanupSources) {
            try {
              unlinkSync(svgPath);
              unlinkSync(htmlPath);
            } catch {
              /* swallow */
            }
          }
        }
      },
      onResult: (input, result) => {
        onResult(input.entry, result);
      },
    });
    staleFiles.push(...artifactResult.staleFiles);

    if (check) {
      if (existingSignatureManifest !== expectedSignatureManifest) staleFiles.push(signatureStaleLabel);
    } else {
      const nextManifest = includePngSignatures
        ? buildSignatureManifest(withPngSignatures(signatures, publicDir))
        : inputSignatureManifest;
      writeFileIfChanged(signaturePath, nextManifest);
    }

    assertNoStaleOgOutputs({ family, staleFiles, refreshCommand });
    return { ...artifactResult, skipped: false };
  } finally {
    await browser.close();
  }
}

export function inspectPublishedOgRoster<T extends OgArtifactRosterEntry>(
  roster: readonly T[],
  publicDir: string,
): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const entry of roster) {
    const path = resolve(publicDir, entry.file);
    if (!existsSync(path)) missing.push(entry.file);
    else if (readFileSync(path).length === 0) empty.push(entry.file);
  }
  return { missing, empty };
}

export function writeOgSourceRoster<T extends OgArtifactRosterEntry>({
  roster,
  stagingDir,
  render,
}: {
  roster: readonly T[];
  stagingDir: string;
  render: (entry: T) => { file: string; contents: string | Uint8Array };
}): string[] {
  mkdirSync(stagingDir, { recursive: true });
  return roster.map((entry) => {
    const artifact = render(entry);
    const path = resolve(stagingDir, artifact.file);
    writeFileSync(path, artifact.contents);
    return path;
  });
}
