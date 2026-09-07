import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

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
