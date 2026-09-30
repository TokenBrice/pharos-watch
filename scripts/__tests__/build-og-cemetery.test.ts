import sharp from "sharp";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOgCemetery,
  checkOgCemetery,
  cssModuleClassMap,
  resolveRootTokens,
  rootCustomProperties,
  unwrapCssModule,
  type OgCemeteryDocument,
  type OgCemeteryPaths,
} from "../maintenance/build-og-cemetery";

describe("CSS module under the identity class map", () => {
  const moduleCss = `
.tokens { --c-ab: var(--c-ab-l); }
:global(.dark) .tokens { --c-ab: var(--c-ab-d); }
:global(.dark) .map .lamp { opacity: 1; }
.hero::before { content: ""; }
.c-ab { --cause: var(--c-ab); }
@media (min-width: 1280px) { .stage .chip:hover { color: red; } }
@keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
`;

  it("exports every local class, including ones only inside media queries, and no global-only class", () => {
    expect(cssModuleClassMap(moduleCss)).toEqual({
      "c-ab": "c-ab",
      chip: "chip",
      hero: "hero",
      lamp: "lamp",
      map: "map",
      stage: "stage",
      tokens: "tokens",
    });
  });

  it("unwraps :global so the theme selector matches the plain class names", () => {
    const css = unwrapCssModule(moduleCss);
    expect(css).toContain(".dark .tokens { --c-ab: var(--c-ab-d); }");
    expect(css).toContain(".dark .map .lamp");
    expect(css).not.toContain(":global");
  });
});

describe("resolveRootTokens", () => {
  const primitives = ":root { --p-neutral-900: oklch(0.2 0 0); --p-blue-500: oklch(0.6 0.2 250); --unused: 1px; }";
  const semantic = `
:root { --text-primary: var(--p-neutral-900); --brand-accent: var(--p-blue-500); }
.dark { --text-primary: white; }
@media (max-width: 767px) { :root { --text-primary: black; } }
`;
  const globals = "@layer base { :root { --foreground: var(--text-primary); --frost-blue: var(--brand-accent); } }";
  const moduleCss = `
.tokens { --beam: color-mix(in oklab, var(--frost-blue) 40%, transparent); --plot-mono: var(--font-geist-mono), monospace; }
.figure { right: calc(var(--lantern-right) + 22px); color: var(--foreground); }
.beam { fill: var(--beam); }
`;

  it("keeps the light :root closure of what the sheet reads and nothing else", () => {
    expect(resolveRootTokens(moduleCss, rootCustomProperties([primitives, semantic, globals]))).toEqual({
      "--brand-accent": "var(--p-blue-500)",
      "--foreground": "var(--text-primary)",
      "--frost-blue": "var(--brand-accent)",
      "--p-blue-500": "oklch(0.6 0.2 250)",
      "--p-neutral-900": "oklch(0.2 0 0)",
      "--text-primary": "var(--p-neutral-900)",
    });
  });

  it("lets a later sheet override an earlier :root token", () => {
    const override = ":root { --p-blue-500: oklch(0.7 0.1 240); }";
    const tokens = resolveRootTokens(moduleCss, rootCustomProperties([primitives, semantic, globals, override]));
    expect(tokens["--p-blue-500"]).toBe("oklch(0.7 0.1 240)");
  });

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

  function makePaths(): OgCemeteryPaths {
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

  async function problemKinds(document: OgCemeteryDocument, paths: OgCemeteryPaths): Promise<string[]> {
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

  it("is a no-op when the document is unchanged, so another platform's renderer never churns the PNG", async () => {
    const paths = makePaths();
    const document = makeDocument("<p>113</p>");
    await buildOgCemetery({ paths, document, render: () => png() });
    const before = readFileSync(paths.imagePath);

    const render = vi.fn(() => png(1200, 630, "#000000"));
    expect((await buildOgCemetery({ paths, document, render })).status).toBe("current");
    expect(render).not.toHaveBeenCalled();
    expect(readFileSync(paths.imagePath).equals(before)).toBe(true);

    expect((await buildOgCemetery({ paths, document, render, force: true })).status).toBe("written");
    expect(render).toHaveBeenCalledOnce();
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
