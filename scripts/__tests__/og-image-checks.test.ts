import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  comparePngContent,
  runOgArtifactBuild,
} from "../lib/og-image-checks.mts";

const tempDirs: string[] = [];

function makeTempDir() {
  const path = mkdtempSync(join(tmpdir(), "pharos-og-image-checks-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("OG image file promotion", () => {
  it.each([
    { maxMeanAbsPerChannel: 1, maxChangedPixelRatio: 1, changedPixelThreshold: 0, matches: true },
    { maxMeanAbsPerChannel: 0.99, maxChangedPixelRatio: 1, changedPixelThreshold: 0, matches: false },
    { maxMeanAbsPerChannel: 2, maxChangedPixelRatio: 0.5, changedPixelThreshold: 0, matches: true },
    { maxMeanAbsPerChannel: 2, maxChangedPixelRatio: 0.49, changedPixelThreshold: 0, matches: false },
    { maxMeanAbsPerChannel: 2, maxChangedPixelRatio: 0, changedPixelThreshold: 2, matches: true },
  ])("compares independent tolerance boundaries: %j", async ({ matches, ...tolerance }) => {
    const root = makeTempDir();
    const expected = join(root, "expected.png");
    const actual = join(root, "actual.png");
    const raw = { width: 2, height: 1, channels: 4 as const };
    await sharp(Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]), { raw }).png().toFile(expected);
    // Eight channel units / eight channels = mean 1; one of two pixels changes.
    await sharp(Buffer.from([8, 0, 0, 255, 0, 0, 0, 255]), { raw }).png().toFile(actual);
    expect((await comparePngContent(expected, actual, tolerance)).matches).toBe(matches);
  });

  it("shares missing, unchanged, changed, check, and render-failure lifecycle", async () => {
    const root = makeTempDir();
    const publicDir = join(root, "public");
    const stagingDir = join(root, "staging");
    const roster = [{ file: "card.png", color: 25 }];
    const render = async (entry: (typeof roster)[number], { stagedPath }: { stagedPath: string }) => {
      await sharp({
        create: { width: 2, height: 2, channels: 4, background: { r: entry.color, g: 0, b: 0, alpha: 1 } },
      }).png().toFile(stagedPath);
    };

    const first = await runOgArtifactBuild({
      check: false, family: "Test", publicDir, refreshCommand: "refresh", roster, stagingDir, render,
    });
    expect(first.changedFiles).toEqual(["card.png"]);
    const bytes = readFileSync(join(publicDir, "card.png"));
    const unchanged = await runOgArtifactBuild({
      check: false, family: "Test", publicDir, refreshCommand: "refresh", roster, stagingDir, render,
    });
    expect(unchanged.changedFiles).toEqual([]);
    expect(readFileSync(join(publicDir, "card.png"))).toEqual(bytes);

    await expect(runOgArtifactBuild({
      check: true, family: "Test", publicDir, refreshCommand: "refresh",
      roster: [{ file: "card.png", color: 255 }], stagingDir, render,
    })).rejects.toThrow("Test OG images are stale: card.png");
    expect(readFileSync(join(publicDir, "card.png"))).toEqual(bytes);
    expect(existsSync(stagingDir)).toBe(false);

    await expect(runOgArtifactBuild({
      check: false, family: "Test", publicDir, refreshCommand: "refresh", roster, stagingDir,
      render: async (_entry, { stagedPath }) => { writeFileSync(stagedPath, ""); },
    })).rejects.toThrow("Generated PNG is missing or empty");
    expect(readFileSync(join(publicDir, "card.png"))).toEqual(bytes);
    expect(existsSync(stagingDir)).toBe(false);

    await expect(runOgArtifactBuild({
      check: true, family: "Test", publicDir, refreshCommand: "refresh", roster, stagingDir, render,
    })).resolves.toMatchObject({ staleFiles: [] });
    await expect(runOgArtifactBuild({
      check: true,
      family: "Test",
      publicDir,
      refreshCommand: "refresh",
      roster: [{ file: "missing.png", color: 10 }],
      stagingDir,
      render,
    })).rejects.toThrow("Test OG images are stale: missing.png");

    await expect(runOgArtifactBuild({
      check: false,
      family: "Test",
      publicDir,
      refreshCommand: "refresh",
      roster,
      stagingDir,
      render: async () => { throw new Error("render failed"); },
    })).rejects.toThrow("render failed");
    expect(existsSync(stagingDir)).toBe(false);
  });
});
