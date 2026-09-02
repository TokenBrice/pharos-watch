import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  contentSha256,
  formatOgWriteStatus,
  promoteGeneratedPngIfChanged,
  runOgArtifactBuild,
  runOgPlaywrightFamily,
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
  it("pins deterministic artifact filenames and content hashes", () => {
    expect([{ file: "og-editorial-digest.png" }, { file: "og-learn-case-ust.png" }].map((entry) => entry.file))
      .toEqual(["og-editorial-digest.png", "og-learn-case-ust.png"]);
    expect(contentSha256("pharos")).toBe("8653057a4b57183ce71278ca80dbd82a61196fa182652f4cba355614b768d063");
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

  it("uses an exact PNG-bound signature manifest to skip Firefox", async () => {
    const root = makeTempDir();
    const publicDir = join(root, "public");
    const stagingDir = join(root, "staging");
    const signaturePath = join(root, "state", "signatures.json");
    mkdirSync(publicDir);
    mkdirSync(join(root, "state"));
    const publicPath = join(publicDir, "card.png");
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    }).png().toFile(publicPath);
    const roster = [{ file: "card.png", label: "Card" }];
    const buildManifest = (cards: Array<{
      file: string;
      label: string;
      svgSha256: string;
      pngSha256?: string | null;
    }>) => `${JSON.stringify({ generatedBy: "test", cards }, null, 2)}\n`;
    writeFileSync(signaturePath, buildManifest([{
      file: "card.png",
      label: "Card",
      svgSha256: contentSha256("<svg/>"),
      pngSha256: contentSha256(readFileSync(publicPath)),
    }]));
    const results: string[] = [];

    await expect(runOgPlaywrightFamily({
      background: "#fff",
      buildRenderInput: (entry) => ({
        file: entry.file,
        signature: { file: entry.file, label: entry.label, svgSha256: contentSha256("<svg/>") },
        sourceBasename: "card",
        svg: "<svg/>",
      }),
      buildSignatureManifest: buildManifest,
      check: true,
      family: "Test",
      fonts: [],
      includePngSignatures: true,
      onResult: (entry) => results.push(entry.file),
      publicDir,
      refreshCommand: "refresh",
      roster,
      signatureFastPath: true,
      signaturePath,
      signatureStaleLabel: "signatures.json",
      stagingDir,
    })).resolves.toMatchObject({ skipped: true, staleFiles: [] });
    expect(results).toEqual(["card.png"]);
  });
});
