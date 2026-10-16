import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCemeteryLogoAtlas,
  checkCemeteryLogoAtlas,
  planCemeteryLogoAtlas,
  readAtlasInputs,
  type AtlasInputRow,
  type AtlasPaths,
} from "../maintenance/build-cemetery-logo-atlas";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("planCemeteryLogoAtlas", () => {
  const rows: AtlasInputRow[] = [
    { id: "zeta", logoUrl: "/logos/cemetery/z.png", sourceSha256: HASH_B },
    { id: "alpha", logoUrl: "/logos/cemetery/a.png", sourceSha256: HASH_A },
    { id: "mid-none", logoUrl: undefined },
    { id: "beta-copy", logoUrl: "/logos/cemetery/a-copy.png", sourceSha256: HASH_A },
  ];

  it("rejects duplicate ids", () => {
    expect(() => planCemeteryLogoAtlas([rows[1], rows[1]], { pixelArtLogoUrls: [] })).toThrow(/Duplicate/);
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
});
