import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  formatOgWriteStatus,
  promoteGeneratedPngIfChanged,
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
});
