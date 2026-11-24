import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  buildSocialPreviewImages,
  discoverSocialPreviewPages,
  loadSocialCardValidationAssets,
  loadSocialPreviewEntries,
  renderMissingSocialPreviewBuffers,
  renderSocialPreviewCards,
  SOCIAL_PREVIEW_MAP_PATH,
  type SocialPreviewEntry,
} from "../lib/social-preview-build";
import { assertSocialPreviewPng, socialPreviewAssetIdentity } from "../../shared/lib/social-preview-asset";
import { loadSocialCardAssets, renderSocialCardSvg } from "../lib/social-card-render";
import { renderSvgPngWithResvg } from "../lib/og-resvg-render.mts";
import { DARK } from "../../shared/lib/social-card/tokens";
import type { SocialCardDossier } from "../../shared/lib/social-card/spec";

import { createTempRepoTracker } from "./helpers/test-state";

// Keeps every catalog entry unless a case samples it: the full catalog makes path-parity runs registry-wide.
const catalogSample = vi.hoisted(() => ({ every: 1 }));
vi.mock("../lib/social-card-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/social-card-catalog")>();
  const sample = <T,>(items: readonly T[]) => items.filter((_, index) => index % catalogSample.every === 0);
  return {
    ...actual,
    buildSocialCardCatalog: (paths: readonly string[]) => {
      const catalog = actual.buildSocialCardCatalog(paths);
      return { ...catalog, cards: sample(catalog.cards), authored: sample(catalog.authored) };
    },
  };
});

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
    const altOut = join(makeTempDir(), "custom-og");
    await expect(buildSocialPreviewImages({
      repoRoot: root, mode: "render", outDir: altOut,
      load: async () => ({ entries, fonts: ["font.ttf"], background: "#101e2b" }),
    })).resolves.toMatchObject({ images: 4, rendered: 4 });
    expect(readdirSync(altOut).sort()).toEqual(readdirSync(join(root, "public/og/v2")).sort());
    const sh = makeTempDir();
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(sh, f, ".."), { recursive: true }); writeFileSync(join(sh, f), c); }
    const [s0, s1] = await Promise.all([0, 1].map((index) => buildSocialPreviewImages({ repoRoot: sh, mode: "render", load: async () => ({ entries, fonts: ["font.ttf"], background: "#101e2b" }), shard: { index, count: 2 } })));
    expect([s0.rendered + s1.rendered, existsSync(join(sh, SOCIAL_PREVIEW_MAP_PATH))]).toEqual([4, false]);
    const noise = await sharp(randomBytes(1200 * 630 * 3), { raw: { width: 1200, height: 630, channels: 3 } }).png().toBuffer();
    writeFileSync(join(root, "public/cover.png"), noise);
    await expect(build("check")).rejects.toThrow("Social preview exceeds 500 KB: public/cover.png");
  });

  it("names every route identically on the catalog fast path and the injected-entries path", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src"));
    for (const dir of ["public", "scripts", "shared", "worker", "src/app"]) symlinkSync(join(process.cwd(), dir), join(root, dir));
    const map = async (load?: typeof loadSocialPreviewEntries) => {
      await buildSocialPreviewImages({ repoRoot: root, mode: "map", load });
      return JSON.parse(readFileSync(join(root, SOCIAL_PREVIEW_MAP_PATH), "utf8")) as Record<string, { url: string }>;
    };
    catalogSample.every = 40;
    try {
      const fast = await map();
      expect(Object.keys(fast).length).toBeGreaterThan(30);
      expect(await map((repoRoot) => loadSocialPreviewEntries(repoRoot, { includePngBuffers: false }))).toEqual(fast);
    } finally {
      catalogSample.every = 1;
    }
  });

  it("renders only requested missing drawn and authored keys in memory and rejects unknown keys", async () => {
    expect((await renderMissingSocialPreviewBuffers(process.cwd(), new Set())).size).toBe(0);
    const previewMap = JSON.parse(readFileSync(join(process.cwd(), SOCIAL_PREVIEW_MAP_PATH), "utf8")) as Record<string, { url: string }>;
    const drawnKey = socialPreviewAssetIdentity(previewMap["/about/"]!.url)!.key;
    const authoredKey = socialPreviewAssetIdentity(previewMap["/cemetery/"]!.url)!.key;
    const buffers = await renderMissingSocialPreviewBuffers(process.cwd(), new Set([drawnKey, authoredKey]), { workers: 1 });
    expect([...buffers.keys()].sort()).toEqual([authoredKey, drawnKey].sort());
    for (const buf of buffers.values()) expect(() => assertSocialPreviewPng(buf)).not.toThrow();
    await expect(renderMissingSocialPreviewBuffers(process.cwd(), new Set([`evergreen/v2/image-${"0".repeat(64)}.png`])))
      .rejects.toThrow("unknown social preview identities");
  });

  it("keeps WebP logos visible and matches worker_threads and validation-only mode", async () => {
    const card: SocialCardDossier = {
      template: "dossier", path: "/stablecoin/format-proof/", label: "Stablecoin dossier",
      copy: { title: "F", description: "F.", alt: "F." },
      identity: { symbol: "BLD", name: "Agoric", logoPath: "/chains/agoric.webp" },
      headline: "BLD", subline: "Agoric", hook: "A WebP logo stays visible", chips: [], lifecycle: "active",
    };
    const dark: SocialCardDossier = { ...card, identity: { symbol: "0G", name: "0G", logoPath: "/chains/0g.png" }, lifecycle: "historical", stamp: "HISTORICAL" };
    const assets = await loadSocialCardAssets(process.cwd(), [card, dark]);
    const bytes = await renderSvgPngWithResvg({ svg: await renderSocialCardSvg(card, assets), fontBuffers: [], background: DARK.ground, width: 1200 });
    expect(Math.max(...(await sharp(await sharp(bytes).extract({ left: 760, top: 275, width: 80, height: 80 }).toBuffer()).stats()).channels.slice(0, 3).map((c) => c.mean))).toBeGreaterThan(110);
    const out = makeTempDir(), tasks = [{ url: "/og/v2/w1.png", spec: card }, { url: "/og/v2/w2.png", spec: dark }];
    mkdirSync(join(out, "public/og/v2"), { recursive: true });
    await expect(renderSocialPreviewCards({ repoRoot: out, tasks, renderAssets: assets, workerCount: 2 })).resolves.toEqual({ rendered: 2 });
    expect(Buffer.compare(readFileSync(join(out, "public/og/v2/w1.png")), Buffer.from(bytes))).toBe(0);
    await expect(renderSocialPreviewCards({ repoRoot: out, tasks: [tasks[0]!, { url: "/og/v2/wb.png", spec: { ...card, headline: "≠" } }], renderAssets: assets, workerCount: 2 })).rejects.toThrow('no glyph for "≠"');
    const drawn = (await loadSocialPreviewEntries(process.cwd(), { includePngBuffers: false })).entries.find((e): e is Extract<SocialPreviewEntry, { drawn: unknown }> => "drawn" in e)!;
    expect(() => drawn.validate()).not.toThrow();
    expect(() => drawn.svg()).toThrow(/logo PNG buffers were not loaded/);
    mkdirSync(join(out, "public/logos"), { recursive: true });
    symlinkSync(join(process.cwd(), "worker"), join(out, "worker"));
    writeFileSync(join(out, "public/logos/e.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    writeFileSync(join(out, "public/logos/b.png"), "x");
    for (const [p, err] of [["/logos/e.svg", "external"], ["/logos/b.png", "decoded"], ["/logos/m.png", "missing"]] as const) {
      await expect(loadSocialCardValidationAssets(out, [{ ...card, identity: { symbol: "T", name: "T", logoPath: p } }])).rejects.toThrow(err);
    }
  });
});
