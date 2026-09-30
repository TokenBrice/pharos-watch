import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCemeteryLogoUrl } from "@shared/lib/cemetery-merged";
import {
  buildAtlasManifest,
  buildCemeteryLogoAtlas,
  checkCemeteryLogoAtlas,
  planCemeteryLogoAtlas,
  readAtlasInputs,
  toCssGrayscale,
  type AtlasInputRow,
  type AtlasPaths,
} from "../maintenance/build-cemetery-logo-atlas";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("resolveCemeteryLogoUrl", () => {
  it("keeps absolute paths and maps bare file names under /logos/cemetery/", () => {
    expect(resolveCemeteryLogoUrl("/logos/10-mim.png")).toBe("/logos/10-mim.png");
    expect(resolveCemeteryLogoUrl("ust.png")).toBe("/logos/cemetery/ust.png");
  });

  it("treats absent and empty logos as missing", () => {
    expect(resolveCemeteryLogoUrl(undefined)).toBeUndefined();
    expect(resolveCemeteryLogoUrl("")).toBeUndefined();
  });
});

describe("planCemeteryLogoAtlas", () => {
  const rows: AtlasInputRow[] = [
    { id: "zeta", logoUrl: "/logos/cemetery/z.png", sourceSha256: HASH_B },
    { id: "alpha", logoUrl: "/logos/cemetery/a.png", sourceSha256: HASH_A },
    { id: "mid-none", logoUrl: undefined },
    { id: "beta-copy", logoUrl: "/logos/cemetery/a-copy.png", sourceSha256: HASH_A },
  ];

  it("produces the same layout regardless of input order", () => {
    const forward = planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: [] });
    const reversed = planCemeteryLogoAtlas([...rows].reverse(), { pixelArtLogoUrls: [] });
    expect(buildAtlasManifest(reversed)).toEqual(buildAtlasManifest(forward));
    expect(reversed.inputSha256).toBe(forward.inputSha256);
    expect(Object.keys(buildAtlasManifest(forward).entries)).toEqual(["alpha", "beta-copy", "zeta"]);
  });

  it("lists logo-less rows as missing instead of assigning cells", () => {
    const manifest = buildAtlasManifest(planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: [] }));
    expect(manifest.missing).toEqual(["mid-none"]);
    expect(manifest.entries["mid-none"]).toBeUndefined();
  });

  it("shares cells between rows whose source bytes are identical", () => {
    const plan = planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: [] });
    const manifest = buildAtlasManifest(plan);
    expect(plan.sources).toHaveLength(2);
    expect(manifest.entries["beta-copy"]).toEqual(manifest.entries.alpha);
    expect(manifest.entries.zeta).not.toEqual(manifest.entries.alpha);
  });

  it("packs colour and gray cells side by side without overlap and inside the atlas", () => {
    const many: AtlasInputRow[] = Array.from({ length: 13 }, (_, index) => ({
      id: `coin-${String(index).padStart(2, "0")}`,
      logoUrl: `/logos/cemetery/${index}.png`,
      sourceSha256: index.toString(16).padStart(64, "0"),
    }));
    const plan = planCemeteryLogoAtlas(many, { cellSize: 10, gutter: 2, pixelArtLogoUrls: [] });
    const manifest = buildAtlasManifest(plan);
    const seen = new Set<string>();
    for (const { color, gray } of Object.values(manifest.entries)) {
      expect(gray[1]).toBe(color[1]);
      expect(gray[0]).toBe(color[0] + 12);
      for (const [x, y] of [color, gray]) {
        expect(x + 10).toBeLessThanOrEqual(manifest.width);
        expect(y + 10).toBeLessThanOrEqual(manifest.height);
        seen.add(`${x},${y}`);
      }
    }
    expect(seen.size).toBe(26);
  });

  it("rotates the input signature when a source changes and only then", () => {
    const base = planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: [] });
    expect(planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: [] }).inputSha256).toBe(base.inputSha256);
    const edited = rows.map((row) => (row.id === "zeta" ? { ...row, sourceSha256: "c".repeat(64) } : row));
    expect(planCemeteryLogoAtlas(edited, { pixelArtLogoUrls: [] }).inputSha256).not.toBe(base.inputSha256);
  });

  it("renders pixel-art overrides with nearest-neighbour and rejects stale overrides", () => {
    const plan = planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: ["/logos/cemetery/z.png"] });
    expect(plan.sources.find((source) => source.logoUrl === "/logos/cemetery/z.png")?.kernel).toBe("nearest");
    expect(plan.sources.find((source) => source.logoUrl === "/logos/cemetery/a.png")?.kernel).toBe("lanczos3");
    expect(() => planCemeteryLogoAtlas(rows, { pixelArtLogoUrls: ["/logos/gone.png"] })).toThrow(/gone\.png/);
  });

  it("rejects duplicate ids", () => {
    expect(() => planCemeteryLogoAtlas([rows[1], rows[1]], { pixelArtLogoUrls: [] })).toThrow(/Duplicate/);
  });
});

describe("toCssGrayscale", () => {
  it("applies the CSS grayscale(1) luminance weights and preserves alpha", () => {
    const out = toCssGrayscale(Uint8Array.from([255, 0, 0, 128, 0, 255, 0, 255, 255, 255, 255, 0]));
    expect([...out]).toEqual([54, 54, 54, 128, 182, 182, 182, 255, 255, 255, 255, 0]);
  });
});

describe("buildCemeteryLogoAtlas + checkCemeteryLogoAtlas", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function makeFixture(): Promise<{ paths: AtlasPaths; rows: { id: string; logo?: string }[] }> {
    const root = mkdtempSync(join(tmpdir(), "cemetery-logo-atlas-"));
    roots.push(root);
    const publicDir = join(root, "public");
    mkdirSync(join(publicDir, "logos/cemetery"), { recursive: true });
    await sharp({ create: { width: 50, height: 50, channels: 4, background: "#ff0000" } })
      .png()
      .toFile(join(publicDir, "logos/cemetery/red.png"));
    // Non-square vector: exercises SVG rasterisation and transparent "contain" padding.
    writeFileSync(
      join(publicDir, "logos/blue.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#0000ff"/></svg>',
    );
    return {
      paths: {
        publicDir,
        imagePath: resolve(publicDir, "logos/atlas/test-atlas.webp"),
        manifestPath: join(root, "manifest.generated.json"),
        signaturePath: join(root, "state/signature.json"),
      },
      rows: [{ id: "red-coin", logo: "red.png" }, { id: "blue-coin", logo: "/logos/blue.svg" }, { id: "no-logo" }],
    };
  }

  const build = (fixture: { paths: AtlasPaths; rows: { id: string; logo?: string }[] }, force = false) =>
    buildCemeteryLogoAtlas({ ...fixture, force, pixelArtLogoUrls: [], image: "/logos/atlas/test-atlas.webp" });

  async function problemKinds(fixture: { paths: AtlasPaths; rows: { id: string; logo?: string }[] }): Promise<string[]> {
    const { inputs } = readAtlasInputs(fixture.rows, fixture.paths.publicDir);
    const plan = planCemeteryLogoAtlas(inputs, { pixelArtLogoUrls: [] });
    const problems = await checkCemeteryLogoAtlas(plan, fixture.paths, "/logos/atlas/test-atlas.webp");
    return problems.map((problem) => problem.kind);
  }

  it("writes colour and grayscale cells that match the manifest", async () => {
    const fixture = await makeFixture();
    expect((await build(fixture)).status).toBe("written");
    const manifest = JSON.parse(readFileSync(fixture.paths.manifestPath, "utf8"));
    expect(manifest.missing).toEqual(["no-logo"]);

    const { data, info } = await sharp(fixture.paths.imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([manifest.width, manifest.height]);
    const pixel = ([x, y]: [number, number], dx = manifest.cellSize / 2, dy = manifest.cellSize / 2) => {
      const offset = ((y + dy) * info.width + (x + dx)) * 4;
      return [...data.subarray(offset, offset + 4)];
    };

    const [r, g, b] = pixel(manifest.entries["red-coin"].color);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g, b)).toBeLessThan(60);
    const [gr, gg, gb] = pixel(manifest.entries["red-coin"].gray);
    expect(Math.max(gr, gg, gb) - Math.min(gr, gg, gb)).toBeLessThan(12);
    expect(gr).toBeGreaterThan(30);
    expect(gr).toBeLessThan(80);

    const [, , blue, alpha] = pixel(manifest.entries["blue-coin"].color);
    expect(blue).toBeGreaterThan(200);
    expect(alpha).toBeGreaterThan(240);
    expect(pixel(manifest.entries["blue-coin"].color, 1, 1)[3]).toBeLessThan(16);

    expect(await problemKinds(fixture)).toEqual([]);
  });

  it("is a no-op when inputs are unchanged, so another platform's encoder never churns the WebP", async () => {
    const fixture = await makeFixture();
    await build(fixture);
    const before = readFileSync(fixture.paths.imagePath);
    expect((await build(fixture)).status).toBe("current");
    expect(readFileSync(fixture.paths.imagePath).equals(before)).toBe(true);
    expect((await build(fixture, true)).status).toBe("written");
  });

  it("flags a changed source logo as stale inputs", async () => {
    const fixture = await makeFixture();
    await build(fixture);
    await sharp({ create: { width: 50, height: 50, channels: 4, background: "#00ff00" } })
      .png()
      .toFile(join(fixture.paths.publicDir, "logos/cemetery/red.png"));
    expect(await problemKinds(fixture)).toEqual(expect.arrayContaining(["stale-inputs", "stale-manifest"]));
  });

  it("flags a hand-edited atlas and a missing manifest", async () => {
    const fixture = await makeFixture();
    await build(fixture);
    writeFileSync(fixture.paths.imagePath, await sharp(fixture.paths.imagePath).webp({ quality: 10 }).toBuffer());
    unlinkSync(fixture.paths.manifestPath);
    expect(await problemKinds(fixture)).toEqual(["image-modified", "stale-manifest"]);
  });

  it("fails loudly when a referenced logo file is absent", async () => {
    const fixture = await makeFixture();
    unlinkSync(join(fixture.paths.publicDir, "logos/blue.svg"));
    await expect(build(fixture)).rejects.toThrow(/blue-coin.*\/logos\/blue\.svg/);
  });
});
