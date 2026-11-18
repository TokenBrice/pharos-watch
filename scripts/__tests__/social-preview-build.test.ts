import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  buildSocialPreviewImages,
  discoverSocialPreviewPages,
  SOCIAL_PREVIEW_MAP_PATH,
  type SocialPreviewEntry,
} from "../lib/social-preview-build";
import { loadSocialCardAssets, renderSocialCardSvg } from "../lib/social-card-render";
import { renderSvgPngWithResvg } from "../lib/og-resvg-render.mts";
import { DARK } from "../../shared/lib/social-card/tokens";
import type { SocialCardDossier } from "../../shared/lib/social-card/spec";

import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot: makeTempDir, cleanup } = createTempRepoTracker("pharos-social-preview-build");
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

const fontBuffers = [readFileSync(new URL("../../src/assets/fonts/originals/Geist-Regular.ttf", import.meta.url))];

describe("evergreen destination previews", () => {
  it("discovers public static destinations and skips private chrome", () => {
    const pages = discoverSocialPreviewPages(process.cwd());
    expect(pages).toEqual(expect.arrayContaining(["/portfolio/", "/screener/picker/", "/timeline/"]));
    expect(pages.some((path) => path.startsWith("/admin") || path.startsWith("/pharoswatchbot/app/"))).toBe(false);
  });

  it("names images by drawn inputs only, validates without rasterizing and renders each identity once", async () => {
    const root = makeTempDir();
    const cover = await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#eeeeee" } }).png().toBuffer();
    const files: Record<string, string | Buffer> = {
      "scripts/lib/og-resvg-render.mts": "rasterizer", "font.ttf": fontBuffers[0], "art.svg": "art", "other.svg": "other", "public/cover.png": cover,
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    const svg = vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#2b4a5e"/></svg>');
    const validate = vi.fn();
    const copy = (title: string) => ({ title, description: `${title} description.`, alt: `${title} alt.` });
    const drawn = (path: string, value: unknown, inputs = ["art.svg"]): SocialPreviewEntry => ({ path, copy: copy(path), drawn: value, inputs, validate, svg });
    const entries: SocialPreviewEntry[] = [
      drawn("/a/", { hook: "Same", facts: ["x"] }), drawn("/b/", { facts: ["x"], hook: "Same" }),
      drawn("/c/", { hook: "Other", facts: ["x"] }), drawn("/d/", { hook: "Same", facts: ["x"] }, ["other.svg"]),
      { path: "/cover/", copy: copy("Cover"), authored: "public/cover.png" },
    ];
    const build = (mode: "check" | "map" | "render") => buildSocialPreviewImages({
      repoRoot: root, mode, load: async () => ({ entries, fonts: ["font.ttf"], background: "#101e2b" }),
    });
    const map = () => JSON.parse(readFileSync(join(root, SOCIAL_PREVIEW_MAP_PATH), "utf8")) as Record<string, { url: string }>;

    await expect(build("check")).resolves.toEqual({ routes: 5, images: 4, rendered: 0 });
    expect(validate).toHaveBeenCalledTimes(3);
    expect(svg).not.toHaveBeenCalled();
    expect(existsSync(join(root, SOCIAL_PREVIEW_MAP_PATH))).toBe(false);
    await build("map");
    const first = map();
    expect(first["/a/"]).toEqual({ ...copy("/a/"), url: expect.stringMatching(/^\/og\/v2\/image-[a-f0-9]{64}\.png$/), width: 1200, height: 630, type: "image/png" });
    // Path, copy and key order are not identity; drawn fields and input bytes are.
    expect(first["/b/"].url).toBe(first["/a/"].url);
    expect(new Set([first["/a/"].url, first["/c/"].url, first["/d/"].url]).size).toBe(3);
    const admitted = await sharp(cover).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
    expect(first["/cover/"].url).toBe(`/og/v2/image-${createHash("sha256").update(admitted).digest("hex")}.png`);
    expect(existsSync(join(root, "public/og/v2"))).toBe(false);
    writeFileSync(join(root, "font.ttf"), readFileSync(new URL("../../src/assets/fonts/originals/GeistMono-Regular.ttf", import.meta.url)));
    await build("map");
    expect(map()["/a/"].url).not.toBe(first["/a/"].url);
    expect(map()["/cover/"].url).toBe(first["/cover/"].url);

    await expect(build("render")).resolves.toMatchObject({ images: 4, rendered: 4 });
    expect(svg).toHaveBeenCalledTimes(3);
    expect(readdirSync(join(root, "public/og/v2")).sort()).toEqual(Object.values(map()).map(({ url }) => url.slice(7)).filter((url, index, urls) => urls.indexOf(url) === index).sort());
    await expect(build("render")).resolves.toMatchObject({ rendered: 0 });
    const noise = await sharp(randomBytes(1200 * 630 * 3), { raw: { width: 1200, height: 630, channels: 3 } }).png().toBuffer();
    writeFileSync(join(root, "public/cover.png"), noise);
    await expect(build("check")).rejects.toThrow("Social preview exceeds 500 KB: public/cover.png");
  });

  it("keeps WebP logos visibly present through the real card renderer and rasterizer", async () => {
    const card: SocialCardDossier = {
      template: "dossier", path: "/stablecoin/format-proof/", label: "Stablecoin dossier",
      copy: { title: "Format proof", description: "Format proof.", alt: "Format proof." },
      identity: { symbol: "USDS", name: "Sky Dollar", logoPath: "/logos/209-usds.webp" },
      headline: "USDS", subline: "Sky Dollar", hook: "A WebP logo stays visible", chips: [], lifecycle: "active",
    };
    const assets = await loadSocialCardAssets(process.cwd(), [card]);
    const bytes = await renderSvgPngWithResvg({ svg: await renderSocialCardSvg(card, assets), fontBuffers: [], background: DARK.ground, width: 1200 });
    // The lens centre (800, 315) holds the logo; an empty plate would stay near the dark ground.
    const region = await sharp(bytes).extract({ left: 760, top: 275, width: 80, height: 80 }).toBuffer();
    const brightest = Math.max(...(await sharp(region).stats()).channels.slice(0, 3).map((channel) => channel.mean));
    expect(brightest).toBeGreaterThan(110);
  });
});
