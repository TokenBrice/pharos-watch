import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  comparePngContent,
  contentSha256,
  runOgArtifactBuild,
} from "../lib/og-image-checks.mts";
import * as socialPreviewCatalog from "../lib/social-preview-catalog";
import {
  buildSocialPreviewImages,
  discoverSocialPreviewPages,
  publishImmutablePng,
  readSocialPreviewLogo,
  SOCIAL_PREVIEW_GENERATOR,
  SOCIAL_PREVIEW_MAP_PATH,
  SOCIAL_PREVIEW_SIGNATURE_PATH,
  socialPreviewAssetUrl,
  verifyImmutableSocialPreview,
} from "../lib/social-preview-build";
import { buildSocialPreviewSvg } from "../lib/social-preview-render";
import { buildOgStaticRenderInputs, buildOgStaticSourceFingerprint } from "../lib/og-static-runner.mts";
import { OG_RESVG_RUNTIME_SOURCE_PATHS, renderSvgPngWithResvg } from "../lib/og-resvg-render.mts";
import { DIGEST_ENTRIES } from "../../src/lib/digest-registry";
import { SOCIAL_PREVIEW_REVISION, type SocialPreviewSpec } from "../../shared/lib/social-preview";

import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot: makeTempDir, cleanup } = createTempRepoTracker("pharos-og-image-checks");
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

const mark = '<svg viewBox="0 0 400 400"><circle cx="200" cy="200" r="200"/></svg>';
const fontBuffers = [readFileSync(new URL("../../src/assets/fonts/originals/Geist-Regular.ttf", import.meta.url))];
const png = (background: string, width = 1200, height = 630) =>
  sharp({ create: { width, height, channels: 4, background } }).png();

function artifactFixture<T extends { file: string }>(
  roster: T[],
  render: (entry: T, context: { stagedPath: string }) => Promise<void>,
) {
  const root = makeTempDir();
  const publicDir = join(root, "public"), stagingDir = join(root, "staging");
  const build = (overrides: { check?: boolean; roster?: T[]; render?: typeof render } = {}) =>
    runOgArtifactBuild({ check: false, family: "Test", publicDir, stagingDir,
      refreshCommand: "refresh", roster, render, ...overrides });
  return { publicDir, stagingDir, build };
}

describe("OG image file promotion", () => {
  it.each([
    [1, 1, 0, true], [0.99, 1, 0, false],
    [2, 0.5, 0, true], [2, 0.49, 0, false], [2, 0, 2, true],
  ] as const)("compares tolerance boundaries %j / %j / %j", async (maxMeanAbsPerChannel, maxChangedPixelRatio, changedPixelThreshold, matches) => {
    const tolerance = { maxMeanAbsPerChannel, maxChangedPixelRatio, changedPixelThreshold };
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
    const { build, publicDir, stagingDir } = artifactFixture([{ file: "card.png", color: 25 }],
      async (entry, { stagedPath }) => {
        await png(`rgb(${entry.color}, 0, 0)`, 2, 2).toFile(stagedPath);
      });
    expect((await build()).changedFiles).toEqual(["card.png"]);
    const published = join(publicDir, "card.png");
    const bytes = readFileSync(published);
    const unchanged = () => expect(readFileSync(published)).toEqual(bytes);
    const cleaned = () => expect(existsSync(stagingDir)).toBe(false);
    expect((await build()).changedFiles).toEqual([]);
    unchanged();

    await expect(build({ check: true, roster: [{ file: "card.png", color: 255 }] }))
      .rejects.toThrow("Test OG images are stale: card.png");
    unchanged();
    cleaned();
    await expect(build({ render: async (_entry, { stagedPath }) => { writeFileSync(stagedPath, ""); } }))
      .rejects.toThrow("Generated PNG is missing or empty");
    unchanged();
    cleaned();
    await expect(build({ check: true })).resolves.toMatchObject({ staleFiles: [] });
    await expect(build({ check: true, roster: [{ file: "missing.png", color: 10 }] }))
      .rejects.toThrow("Test OG images are stale: missing.png");
    await expect(build({ render: async () => { throw new Error("render failed"); } })).rejects.toThrow("render failed");
    cleaned();
  });

  it("never treats a changed semantic source as harmless raster drift", async () => {
    const { publicDir, build: run } = artifactFixture([{ file: "card.png", sourceFingerprint: "", color: 0 }],
      async (entry, { stagedPath }) => {
        await png("#ffffff", 100, 100).composite([{
          input: await png(`rgb(${entry.color}, 0, 0)`, 4, 4).toBuffer(),
          left: 48, top: 48,
        }]).toFile(stagedPath);
      });
    const build = (check: boolean, sourceFingerprint: string, color: number) =>
      run({ check, roster: [{ file: "card.png", sourceFingerprint, color }] });

    await build(false, "a".repeat(64), 0);
    const oldBytes = readFileSync(join(publicDir, "card.png"));
    await expect(build(true, "b".repeat(64), 255))
      .rejects.toThrow("source fingerprint changed");
    expect(readFileSync(join(publicDir, "card.png"))).toEqual(oldBytes);

    await build(false, "b".repeat(64), 255);
    const published = join(publicDir, "card.png");
    const pixels = await sharp(published).ensureAlpha().raw().toBuffer();
    expect(pixels[(49 * 100 + 49) * 4]).toBe(255);

    // Identical semantic inputs may retain insignificant browser raster drift.
    const currentBytes = readFileSync(published);
    await build(false, "b".repeat(64), 254);
    expect(readFileSync(published)).toEqual(currentBytes);
  });
});

describe("evergreen destination previews", () => {
  it("keeps public noindex destinations specific, private tools generic and historical editorial dated", () => {
    const pages = discoverSocialPreviewPages(process.cwd());
    expect(pages.paths).toEqual(expect.arrayContaining(["/portfolio/", "/screener/picker/", "/timeline/"]));
    expect(pages.paths.some((path) => path.startsWith("/admin") || path.startsWith("/pharoswatchbot/app/"))).toBe(false);
    const catalog = socialPreviewCatalog.buildSocialPreviewCatalog(pages.paths);
    const byPath = new Map(catalog.specs.map((spec) => [spec.path, spec]));
    const daily = DIGEST_ENTRIES.find((entry) => entry.digestType === "daily")!;
    expect(byPath.get(`/digest/${daily.date}/`)?.subject).toBe(daily.title);
    expect(byPath.get("/stablecoin/usdc-circle/")?.visual).toMatchObject({ kind: "identity", symbol: "USDC" });
    expect(byPath.get("/compare/usdt-tether-vs-usdc-circle/")?.visual).toMatchObject({
      kind: "contrast", left: { symbol: "USDT" }, right: { symbol: "USDC" },
    });
    const history = byPath.get("/learn/case-studies/usdc-svb-2023/")!;
    expect(history.facts).toEqual(["10 Mar 2023", "Outcome: Survived"]);
    expect(history.subject).toContain("Silicon Valley Bank");
    for (const path of ["/portfolio/", "/screener/picker/"]) {
      const spec = byPath.get(path)!;
      expect(spec.path).toBe(path);
      expect(JSON.stringify(spec)).not.toMatch(/holdings|balance|wallet|address|\bgrade\b|\bscore\b|[?&]|\d+%/i);
    }
    expect(catalog.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/cemetery/", url: "/og-cemetery.png" }),
      expect.objectContaining({ path: "/blog/safety-score-v10/", url: "/blog/safety-score-v10-cover.png" }),
    ]));
    expect(() => socialPreviewCatalog.buildSocialPreviewCatalog(["/new-public-destination/"])).toThrow("no authored social preview");
  });

  it("rotates semantic URLs for copy, font/render inputs and editorial identity without query revisions", () => {
    const spec: SocialPreviewSpec = {
      path: "/docs/classification/", grammar: "briefing", eyebrow: "Methodology",
      subject: "Backing & control", hook: "Read the evidence rules.", facts: [],
      visual: { kind: "document", labels: ["Classification", "Evidence"] },
    };
    const svg = buildSocialPreviewSvg(spec, mark);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain("Backing &amp; control");
    const inputs = buildOgStaticRenderInputs({ fonts: [], width: 1200, height: 630, renderer: "resvg" });
    const fingerprint = buildOgStaticSourceFingerprint(svg, inputs);
    const identity = socialPreviewAssetUrl(spec, fingerprint, inputs.runtimeFingerprint);
    const semanticHash = contentSha256(JSON.stringify({ revision: SOCIAL_PREVIEW_REVISION, spec, sourceFingerprint: fingerprint, toolchainFingerprint: inputs.runtimeFingerprint }));
    expect(identity).toEqual({ url: `/og/v2/image-${semanticHash}.png`, semanticHash });
    expect(socialPreviewAssetUrl(spec, fingerprint, inputs.runtimeFingerprint)).toEqual(identity);
    for (const path of ["/", "/stablecoin/gldt-gold-token-sa/", "/blog/token-key/"]) {
      expect(socialPreviewAssetUrl({ ...spec, path }, fingerprint, inputs.runtimeFingerprint).url).toMatch(/^\/og\/v2\/image-[a-f0-9]{64}\.png$/);
    }
    expect(socialPreviewAssetUrl({ ...spec, hook: "Inspect the evidence rules." }, fingerprint, inputs.runtimeFingerprint).url).not.toBe(identity.url);
    expect(socialPreviewAssetUrl(spec, "b".repeat(64), inputs.runtimeFingerprint).url).not.toBe(identity.url);
    expect(socialPreviewAssetUrl(spec, fingerprint, "c".repeat(64)).url).not.toBe(identity.url);
    expect(buildOgStaticSourceFingerprint(svg, { ...inputs, height: 628 })).not.toBe(fingerprint);
    expect(buildOgStaticSourceFingerprint(svg, { ...inputs, fonts: [{ key: "changed", family: "Geist", file: "b".repeat(64), weight: 400 }] })).not.toBe(fingerprint);
  });

  it("persists tagged full source digests and opaque authored URLs while retaining old identities", async () => {
    const root = makeTempDir();
    const bytes = await png("#eeeeee").toBuffer(), hash = contentSha256(bytes);
    const preserved = { path: "/blog/token-key/", url: "/blog/token-key-cover.png", alt: "Authored cover", title: "Evidence", description: "Read the evidence." };
    const catalog = vi.spyOn(socialPreviewCatalog, "buildSocialPreviewCatalog").mockReturnValue({ specs: [], preserved: [preserved] });
    const sources: Record<string, string | Buffer> = {
      [SOCIAL_PREVIEW_GENERATOR]: 'import "../lib/fixture";\n',
      "scripts/lib/fixture.ts": "export const evidence = true;\n",
      "src/app/page.tsx": "export default function Page() { return null; }\n",
      "public/pharos-mark-on-dark.svg": mark,
      [`public${preserved.url}`]: bytes,
    };
    for (const file of [
      "package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "data/depeg-events/index.json",
      ...["Geist-Bold.ttf", "Newsreader-Variable.ttf", "Geist-Regular.ttf", "GeistMono-Regular.ttf"].map((name) => `src/assets/fonts/originals/${name}`),
      ...OG_RESVG_RUNTIME_SOURCE_PATHS,
    ]) sources[file] = readFileSync(join(process.cwd(), file));
    for (const [file, content] of Object.entries(sources)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    const legacyUrl = `/og/v2/authored-cover-${hash}.png`;
    const retained = { kind: "authored", sourceFingerprint: hash, pngSha256: hash };
    mkdirSync(join(root, "public/og/v2"), { recursive: true });
    writeFileSync(join(root, `public${legacyUrl}`), bytes);
    mkdirSync(join(root, SOCIAL_PREVIEW_SIGNATURE_PATH, ".."), { recursive: true });
    writeFileSync(join(root, SOCIAL_PREVIEW_SIGNATURE_PATH), JSON.stringify({
      generatedBy: SOCIAL_PREVIEW_GENERATOR, revision: SOCIAL_PREVIEW_REVISION, retained: { [legacyUrl]: retained },
    }));

    await expect(buildSocialPreviewImages({ repoRoot: root, check: false })).resolves.toEqual({ routes: 1, rendered: 0 });
    const manifest = JSON.parse(readFileSync(join(root, SOCIAL_PREVIEW_SIGNATURE_PATH), "utf8")) as {
      sources: Record<string, string>; cards: unknown[]; retained: Record<string, unknown>;
    };
    expect(manifest.sources).toEqual(Object.fromEntries(Object.entries(sources).map(([file, content]) => [file, `sha256:${contentSha256(content)}`])));
    expect(Object.keys(manifest.sources)).toEqual(Object.keys(sources).sort());
    const url = `/og/v2/image-${hash}.png`;
    expect(manifest.cards).toEqual([{ kind: "authored", path: preserved.path, url, semanticHash: hash, sourceFingerprint: hash }]);
    expect(manifest.retained).toEqual({ [legacyUrl]: retained, [url]: retained });
    expect(JSON.parse(readFileSync(join(root, SOCIAL_PREVIEW_MAP_PATH), "utf8"))[preserved.path]).toMatchObject({ url });
    expect(readFileSync(join(root, `public${url}`))).toEqual(bytes);
    await expect(buildSocialPreviewImages({ repoRoot: root, check: true })).resolves.toEqual({ routes: 1, rendered: 0 });
    catalog.mockReturnValue({ specs: [], preserved: [preserved, { ...preserved, path: "/blog/another/" }] });
    await expect(buildSocialPreviewImages({ repoRoot: root, check: true })).rejects.toThrow("identity collision");
  });

  it("renders font-backed glyphs offline without a browser or host fonts", async () => {
    const bytes = await renderSvgPngWithResvg({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="white"/><text x="50" y="130" font-family="Geist" font-size="80" fill="black">Stablecoin evidence</text></svg>',
      fontBuffers, background: "#ffffff", width: 1200,
    });
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1200, height: 630, format: "png" });
    expect((await sharp(bytes).stats()).channels[0].min).toBe(0);
  });

  it("keeps WebP logos visibly present through the actual evergreen rasterizer", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "public/logos"), { recursive: true });
    const path = "/logos/format-proof.webp";
    const webp = await png("#dc2328", 16, 16).webp().toBuffer();
    writeFileSync(join(root, `public${path}`), webp);
    const spec: SocialPreviewSpec = {
      path: "/stablecoin/format-proof/", grammar: "dossier", eyebrow: "Stablecoin dossier",
      subject: "Logo visibility", hook: "Inspect the evidence.", facts: [],
      visual: { kind: "identity", symbol: "COIN", name: "Logo visibility", logoPath: path, facets: ["Backing", "Control"] },
    };
    const asset = await readSocialPreviewLogo(root, path);
    const bytes = await renderSvgPngWithResvg({
      svg: buildSocialPreviewSvg(spec, mark, new Map([[path, asset]])),
      fontBuffers, background: "#101e2b", width: 1200,
    });
    const region = await sharp(bytes).extract({ left: 380, top: 175, width: 30, height: 30 }).toBuffer();
    const channels = (await sharp(region).stats()).channels;
    expect(channels[0].mean).toBeGreaterThan(150);
    expect(channels[1].mean).toBeLessThan(90);
    expect(channels[2].mean).toBeLessThan(90);
  });

  it("cannot rebaseline an old hash URL or mutate an authored cover while publishing", async () => {
    const first = "a".repeat(64), second = "b".repeat(64);
    const { publicDir: root, build } = artifactFixture([
      { file: "first.png", sourceFingerprint: first, background: "#eeeeee" },
      { file: "second.png", sourceFingerprint: second, background: "#ffffff" },
    ], async (entry, { stagedPath }) => { await png(entry.background).toFile(stagedPath); });
    await build();
    const original = readFileSync(join(root, "first.png"));
    const changed = readFileSync(join(root, "second.png"));
    const url = `/og/v2/immutable-${first}.png`;
    const record = { kind: "rendered" as const, sourceFingerprint: first, pngSha256: contentSha256(original) };
    publishImmutablePng(root, url, original, record);
    expect(() => verifyImmutableSocialPreview(original, { ...record, sourceFingerprint: second }, url)).toThrow("source mismatch");
    expect(() => verifyImmutableSocialPreview(changed, { sourceFingerprint: second, pngSha256: record.pngSha256 }, url)).toThrow("bytes changed");
    expect(() => publishImmutablePng(root, url, changed, {
      kind: "rendered", sourceFingerprint: second, pngSha256: contentSha256(changed),
    })).toThrow("source mismatch");
    expect(readFileSync(join(root, url.slice(1)))).toEqual(original);
    const authored = { kind: "authored" as const, sourceFingerprint: contentSha256(original), pngSha256: contentSha256(original) };
    publishImmutablePng(root, `/og/v2/authored-${authored.pngSha256}.png`, original, authored);
    expect(readFileSync(join(root, `og/v2/authored-${authored.pngSha256}.png`))).toEqual(original);
    const wrongSize = await png("#ffffff", 1200, 628).toBuffer();
    expect(() => verifyImmutableSocialPreview(wrongSize, authored, "wrong-size")).toThrow("1200×630");
  });
});
