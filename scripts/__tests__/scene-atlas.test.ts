import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toSceneAtlas } from "@shared/lib/scene/atlas";
import {
  buildSceneAtlas,
  buildSceneAtlasManifest,
  checkSceneAtlas,
  planSceneAtlas,
  readSceneAtlasInputs,
  type AtlasPaths,
  type SceneAtlasParams,
} from "../lib/scene-atlas";

const PARAMS: SceneAtlasParams = {
  generatedBy: "scripts/__tests__/scene-atlas.test.ts",
  generatorVersion: 1,
  cellSize: 16,
  gutter: 2,
  webp: { quality: 70, alphaQuality: 80, effort: 4 },
  byteBudget: 50_000,
  image: "/logos/atlas/fixture.webp",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two logos (a red and a blue square), three rows: one shares the red bytes, one has none. */
async function fixture(): Promise<{ paths: AtlasPaths; rows: { id: string; logoUrl: string | undefined }[] }> {
  const root = mkdtempSync(join(tmpdir(), "scene-atlas-"));
  dirs.push(root);
  const publicDir = join(root, "public");
  mkdirSync(join(publicDir, "logos"), { recursive: true });
  const square = (background: string) => sharp({ create: { width: 32, height: 32, channels: 4, background } }).png().toBuffer();
  writeFileSync(join(publicDir, "logos/red.png"), await square("#ff0000"));
  writeFileSync(join(publicDir, "logos/red-copy.png"), await square("#ff0000"));
  writeFileSync(join(publicDir, "logos/blue.png"), await square("#0000ff"));
  return {
    paths: {
      publicDir,
      imagePath: join(publicDir, "logos/atlas/fixture.webp"),
      manifestPath: join(root, "manifest.json"),
      signaturePath: join(root, "signature.json"),
    },
    rows: [
      { id: "red", logoUrl: "/logos/red.png" },
      { id: "blue", logoUrl: "/logos/blue.png" },
      { id: "red-again", logoUrl: "/logos/red-copy.png" },
      { id: "none", logoUrl: undefined },
    ],
  };
}

describe("scene atlas", () => {
  it("plans colour + grey cell pairs, shares identical bytes, and the manifest reads back through toSceneAtlas", async () => {
    const { paths, rows } = await fixture();
    const { inputs } = readSceneAtlasInputs(rows, paths.publicDir);
    const plan = planSceneAtlas(inputs, PARAMS);
    expect(plan.sources).toHaveLength(2);
    expect(plan.missing).toEqual(["none"]);
    const manifest = buildSceneAtlasManifest(plan, PARAMS);
    expect(manifest.entries["red-again"]).toEqual(manifest.entries.red);
    const atlas = toSceneAtlas(manifest);
    expect(atlas.shift).toBe(PARAMS.cellSize + PARAMS.gutter);
    expect(atlas.href).toBe(`${PARAMS.image}?v=${manifest.revision}`);
    expect(Object.keys(atlas.cells).sort()).toEqual(["blue", "red", "red-again"]);
  });

  it("writes once, is then current, and goes stale when a logo changes", async () => {
    const { paths, rows } = await fixture();
    const build = () => {
      const { inputs, bytesByUrl } = readSceneAtlasInputs(rows, paths.publicDir);
      return buildSceneAtlas({ plan: planSceneAtlas(inputs, PARAMS), bytesByUrl, paths, params: PARAMS });
    };
    expect((await build()).status).toBe("written");
    const { width, height, format } = await sharp(readFileSync(paths.imagePath)).metadata();
    expect({ width, height, format }).toEqual({ width: 2 * 18 - 2, height: 2 * 18 - 2, format: "webp" });
    expect((await build()).status).toBe("current");

    writeFileSync(join(paths.publicDir, "logos/blue.png"), await sharp({ create: { width: 32, height: 32, channels: 4, background: "#00ff00" } }).png().toBuffer());
    const { inputs } = readSceneAtlasInputs(rows, paths.publicDir);
    expect((await checkSceneAtlas(planSceneAtlas(inputs, PARAMS), paths, PARAMS)).map((p) => p.kind)).toEqual(["stale-inputs", "stale-signature", "stale-manifest"]);
  });

  it("fails loudly on a missing logo file", async () => {
    const { paths } = await fixture();
    expect(() => readSceneAtlasInputs([{ id: "ghost", logoUrl: "/logos/ghost.png" }], paths.publicDir)).toThrow(/ghost.*\/logos\/ghost\.png/);
  });
});
