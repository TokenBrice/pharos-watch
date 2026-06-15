#!/usr/bin/env node
/**
 * Generate PWA icons (192 + 512, standard + maskable) from source SVGs.
 *
 * Renders via Playwright Firefox to faithfully reproduce SVG gradients/filters
 * that standard rasterizers (rsvg-convert, Inkscape, ImageMagick) silently
 * break. Mirrors the local `svg-to-png` skill flow.
 *
 * Manual invocation only — not wired into the build chain. Re-run when the
 * source SVGs change.
 *
 * Inputs:
 *   public/favicon.svg                       (any-purpose icon source)
 *   public/icons/icon-maskable-source.svg    (maskable icon source)
 *
 * Outputs:
 *   public/icons/icon-192.png
 *   public/icons/icon-512.png
 *   public/icons/icon-192-maskable.png
 *   public/icons/icon-512-maskable.png
 */
import { firefox } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const RENDERS = [
  {
    source: resolve(REPO_ROOT, "public/favicon.svg"),
    output: resolve(REPO_ROOT, "public/icons/icon-192.png"),
    size: 192,
  },
  {
    source: resolve(REPO_ROOT, "public/favicon.svg"),
    output: resolve(REPO_ROOT, "public/icons/icon-512.png"),
    size: 512,
  },
  {
    source: resolve(REPO_ROOT, "public/icons/icon-maskable-source.svg"),
    output: resolve(REPO_ROOT, "public/icons/icon-192-maskable.png"),
    size: 192,
  },
  {
    source: resolve(REPO_ROOT, "public/icons/icon-maskable-source.svg"),
    output: resolve(REPO_ROOT, "public/icons/icon-512-maskable.png"),
    size: 512,
  },
];

mkdirSync(resolve(REPO_ROOT, "public/icons"), { recursive: true });

const browser = await firefox.launch({ headless: true });

try {
  for (const { source, output, size } of RENDERS) {
    // The source SVGs use a native 88x88 viewBox. Render at native size with
    // deviceScaleFactor = size / 88 so the SVG's vector content is rasterized
    // crisply at the target resolution (rather than nearest-neighbor-upscaled
    // from an 88x88 raster).
    const scale = size / 88;
    const page = await browser.newPage({
      viewport: { width: 88, height: 88 },
      deviceScaleFactor: scale,
    });
    const fileUrl = pathToFileURL(source).href;
    await page.goto(fileUrl, { waitUntil: "load", timeout: 15000 });
    await page.screenshot({ path: output, omitBackground: false, timeout: 30000 });
    await page.close();
    console.log(`Wrote ${output} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
