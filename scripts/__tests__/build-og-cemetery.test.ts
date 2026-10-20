import sharp from "sharp";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOgCemetery,
  checkOgCemetery,
  type OgCemeteryDocument,
} from "../maintenance/build-og-cemetery";
import { resolveRootTokens, rootCustomProperties, type SignedPngPaths } from "../lib/scene-og";

describe("resolveRootTokens", () => {
  const moduleCss = `
.tokens { --beam: color-mix(in oklab, var(--frost-blue) 40%, transparent); --plot-mono: var(--font-geist-mono), monospace; }
.figure { right: calc(var(--lantern-right) + 22px); color: var(--foreground); }
.beam { fill: var(--beam); }
`;

  it("fails on a dangling reference inside the closure instead of rendering an unstyled fallback", () => {
    const broken = ":root { --foreground: var(--text-missing); --frost-blue: blue; }";
    expect(() => resolveRootTokens(moduleCss, rootCustomProperties([broken]))).toThrow(/--foreground references --text-missing/);
  });
});

describe("buildOgCemetery + checkOgCemetery", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makePaths(): SignedPngPaths {
    const root = mkdtempSync(join(tmpdir(), "og-cemetery-"));
    roots.push(root);
    return { imagePath: join(root, "public/og-cemetery.png"), signaturePath: join(root, "state/og-cemetery-signature.json") };
  }

  const makeDocument = (html: string): OgCemeteryDocument => ({
    html,
    summary: { total: 3, firstYear: 2018, latestYear: 2026, asOf: "2026-08-27", atlasImageSha256: "a".repeat(64) },
  });

  const png = (width = 1200, height = 630, background = "#f8f8fa") =>
    sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

  async function problemKinds(document: OgCemeteryDocument, paths: SignedPngPaths): Promise<string[]> {
    return (await checkOgCemetery(document, paths)).map((problem) => problem.kind);
  }

  it("reports a missing signature before the first run, then passes after writing", async () => {
    const paths = makePaths();
    const document = makeDocument("<p>113</p>");
    expect(await problemKinds(document, paths)).toEqual(["missing-signature"]);

    const result = await buildOgCemetery({ paths, document, render: () => png() });
    expect(result.status).toBe("written");
    expect(await problemKinds(document, paths)).toEqual([]);
  });

  it("flags a new death (a changed document) as stale inputs and re-renders on the next run", async () => {
    const paths = makePaths();
    await buildOgCemetery({ paths, document: makeDocument("<p>113</p>"), render: () => png() });
    const next = makeDocument("<p>114</p>");
    expect(await problemKinds(next, paths)).toEqual(["stale-inputs", "stale-signature"]);

    const render = vi.fn(() => png());
    expect((await buildOgCemetery({ paths, document: next, render })).status).toBe("written");
    expect(render).toHaveBeenCalledOnce();
    expect(await problemKinds(next, paths)).toEqual([]);
  });

  it("flags a hand-edited or deleted PNG", async () => {
    const paths = makePaths();
    const document = makeDocument("<p>113</p>");
    await buildOgCemetery({ paths, document, render: () => png() });

    writeFileSync(paths.imagePath, await png(1200, 628));
    expect(await problemKinds(document, paths)).toEqual(["image-modified", "image-dimensions"]);

    unlinkSync(paths.imagePath);
    expect(await problemKinds(document, paths)).toEqual(["missing-image"]);
  });

  it("refuses to write a render with the wrong dimensions", async () => {
    const paths = makePaths();
    await expect(buildOgCemetery({ paths, document: makeDocument("<p>113</p>"), render: () => png(1200, 628) })).rejects.toThrow(
      /1200x628, expected png 1200x630; nothing written/,
    );
    expect(existsSync(paths.imagePath)).toBe(false);
    expect(existsSync(paths.signaturePath)).toBe(false);
  });
});
