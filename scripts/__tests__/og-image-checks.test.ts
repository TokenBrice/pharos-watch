import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  comparePngContent,
  contentSha256,
  formatOgWriteStatus,
  promoteGeneratedPngIfChanged,
  runOgArtifactBuild,
  writeFileIfChanged,
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
  it("computes an independently pinned content hash", () => {
    expect(contentSha256("pharos")).toBe("8653057a4b57183ce71278ca80dbd82a61196fa182652f4cba355614b768d063");
  });

  it("rejects different PNG dimensions", async () => {
    const root = makeTempDir();
    const paths = [join(root, "one.png"), join(root, "two.png")];
    for (const [index, path] of paths.entries()) {
      await sharp({ create: { width: index + 1, height: 1, channels: 4, background: "black" } }).png().toFile(path);
    }
    expect((await comparePngContent(paths[0]!, paths[1]!)).matches).toBe(false);
  });

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

  it("leaves a visually identical public PNG untouched", async () => {
    const root = makeTempDir();
    const staging = join(root, "staging");
    const publicDir = join(root, "public");
    mkdirSync(staging);
    mkdirSync(publicDir);
    const stagedPath = join(staging, "card.png");
    const publicPath = join(publicDir, "card.png");
    const pixels = {
      create: { width: 2, height: 2, channels: 4 as const, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    };
    await sharp(pixels).png({ compressionLevel: 0 }).toFile(publicPath);
    const before = statSync(publicPath).mtimeMs;
    await sharp(pixels).png({ compressionLevel: 9 }).toFile(stagedPath);

    expect(await promoteGeneratedPngIfChanged({ stagedPath, publicPath })).toBe(false);
    expect(statSync(publicPath).mtimeMs).toBe(before);
  });

  it("promotes a materially changed staged PNG", async () => {
    const root = makeTempDir();
    const stagedPath = join(root, "card.staged.png");
    const publicPath = join(root, "card.png");
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).png().toFile(publicPath);
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toFile(stagedPath);

    expect(await promoteGeneratedPngIfChanged({ stagedPath, publicPath })).toBe(true);
    expect((await sharp(publicPath).raw().toBuffer())[0]).toBe(255);
  });

  it("does not rewrite identical manifests", () => {
    const root = makeTempDir();
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, "{}\n");
    const before = statSync(manifestPath).mtimeMs;

    expect(writeFileIfChanged(manifestPath, "{}\n")).toBe(false);
    expect(statSync(manifestPath).mtimeMs).toBe(before);
    expect(writeFileIfChanged(manifestPath, '{"changed":true}\n')).toBe(true);
  });

  it("reports unchanged write-mode outputs clearly", () => {
    expect(formatOgWriteStatus({ check: false, changed: false, publicPath: "/public/card.png" })).toBe(
      "Unchanged /public/card.png",
    );
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
