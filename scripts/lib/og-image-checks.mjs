import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";

const DEFAULT_TOLERANCE = {
  maxMeanAbsPerChannel: 2.5,
  maxChangedPixelRatio: 0.04,
  changedPixelThreshold: 8,
};

export async function comparePngContent(expectedPath, actualPath, tolerance = DEFAULT_TOLERANCE) {
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

export async function stalePngCheckLabel({ fileLabel, expectedPath, actualPath }) {
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

export function formatOgWriteStatus({ check, publicPath, suffix = "" }) {
  return `${check ? "Checked" : "Wrote"} ${publicPath}${suffix}`;
}

export function assertNoStaleOgOutputs({ family, staleFiles, refreshCommand }) {
  if (staleFiles.length === 0) return;
  throw new Error(
    `${family} OG images are stale: ${staleFiles.join(", ")}. Run \`${refreshCommand}\` to refresh them.`,
  );
}
