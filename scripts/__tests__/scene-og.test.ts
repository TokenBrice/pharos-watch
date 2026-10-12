import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import { buildSignedPng, checkSignedPng, cssModuleClassMap, unwrapCssModule, woff2FontFace, type SignedPngSpec } from "../lib/scene-og";

describe("scene OG CSS modules", () => {
  const kit = ".tokens { --edge: red; }\n.scene .e { stroke: var(--edge); }";
  const art = `.tokens { composes: tokens from "../scene/scene-tokens.module.css"; --c: blue; }\n.map { composes: scene from "../scene/scene-tokens.module.css"; }\n.hero { color: var(--c); }`;

  it("maps a composing class to itself plus the composed identity names", () => {
    expect(cssModuleClassMap(kit)).toEqual({ e: "e", scene: "scene", tokens: "tokens" });
    expect(cssModuleClassMap(art)).toEqual({ hero: "hero", map: "map scene", tokens: "tokens" });
  });

  it("drops composes (and a rule left empty) from the inlined stylesheet", () => {
    const css = unwrapCssModule(art);
    expect(css).not.toContain("composes");
    expect(css).not.toContain(".map");
    expect(css).toContain("--c: blue");
  });

  it("inlines WOFF2 fonts as data URIs", () => {
    expect(woff2FontFace("Geist", "400", new Uint8Array([1, 2]))).toBe(
      '@font-face{font-family:"Geist";font-style:normal;font-weight:400;font-display:block;src:url("data:font/woff2;base64,AQI=") format("woff2");}',
    );
  });
});

describe("signed PNG", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const paths = () => {
    const root = mkdtempSync(join(tmpdir(), "scene-og-"));
    dirs.push(root);
    return { imagePath: join(root, "card.png"), signaturePath: join(root, "signature.json") };
  };
  const spec = (html: string): SignedPngSpec => ({
    html,
    signature: (image) => ({ documentSha256: sha256Hex(html), image }),
    width: 40,
    height: 21,
    staleHint: "fixture changed",
    label: "fixture",
  });
  const png = (height = 21) => sharp({ create: { width: 40, height, channels: 3, background: "#fff" } }).png().toBuffer();

  it("judges freshness by the document hash, never by re-rendering", async () => {
    const p = paths();
    expect((await checkSignedPng(spec("<p>a</p>"), p)).map((x) => x.kind)).toEqual(["missing-signature"]);
    const render = vi.fn(() => png());
    expect((await buildSignedPng({ spec: spec("<p>a</p>"), paths: p, render })).status).toBe("written");
    expect((await buildSignedPng({ spec: spec("<p>a</p>"), paths: p, render })).status).toBe("current");
    expect(render).toHaveBeenCalledOnce();
    expect((await checkSignedPng(spec("<p>b</p>"), p)).map((x) => x.kind)).toEqual(["stale-inputs", "stale-signature"]);
  });

  it("refuses a render of the wrong size", async () => {
    await expect(buildSignedPng({ spec: spec("<p>a</p>"), paths: paths(), render: () => png(20) })).rejects.toThrow(/fixture: rendered png 40x20, expected png 40x21; nothing written/);
  });
});
