/**
 * Scene kit OG rendering: turns a scene's React components and CSS modules into one self-contained HTML document,
 * screenshots it, and keeps the PNG fresh by an input signature instead of re-rendering.
 *
 * Styles without a bundler: `registerCssModuleHook()` lets Node import `*.module.css` as an identity class map
 * (`hero` → `hero`, parsed with PostCSS; `composes:` resolved to the composed names), and the stylesheet is the
 * module with its `:global(…)` wrappers unwrapped and `composes:` dropped (`unwrapCssModule`), so every class the
 * components emit matches a rule verbatim. Inline the modules in the order the app imports them (kit tokens first).
 * Global tokens a module reads are resolved from the light `:root` blocks of the token sheets
 * (`rootCustomProperties` + `resolveRootTokens`, only the ones referenced plus their `var()` closure). Fonts and
 * images go in as data URIs.
 *
 * Freshness: Firefox and libvips output differs across platforms, so a check hashes the DOCUMENT (no browser) and
 * compares it with the committed signature, then verifies the committed PNG still hashes to the value recorded when
 * it was written (`checkSignedPng`). `buildSignedPng` is a no-op when that check passes, avoiding PNG churn on
 * another OS.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";
import postcss, { AtRule, type Declaration } from "postcss";
import sharp, { type PngOptions } from "sharp";
import { sha256Hex, sha256HexFromBytes } from "@shared/lib/sha256";

// ---------------------------------------------------------------------------
// CSS: module class map, global unwrapping, token closure (pure)
// ---------------------------------------------------------------------------

const CLASS_IN_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;
const GLOBAL_WRAPPER = /:global\(([^()]*)\)/g;
const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;
const CUSTOM_PROPERTY = /^--[\w-]+$/;
const COMPOSES = /^\s*([\w\s-]+?)\s+from\s+["']([^"']+)["']\s*$/;

/** `composes: a b from "./x.module.css"` → the composed names and the (unresolved) source, or a same-file list. */
function parseComposes(decl: Declaration): { names: string[]; from: string | null } {
  const match = COMPOSES.exec(decl.value);
  return match ? { names: match[1].trim().split(/\s+/), from: match[2] } : { names: decl.value.trim().split(/\s+/), from: null };
}

/**
 * Identity class map for a CSS module: every local class name the module declares maps to itself. Classes that
 * only appear inside `:global(…)` are global in the module, so they are not exported. A class with `composes:`
 * maps to itself followed by the composed names (identity names, so the composed module's rules match verbatim).
 */
export function cssModuleClassMap(css: string): Record<string, string> {
  const names = new Set<string>();
  const composed = new Map<string, string[]>();
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent instanceof AtRule && /keyframes$/i.test(rule.parent.name)) return;
    for (const match of rule.selector.replace(GLOBAL_WRAPPER, "").matchAll(CLASS_IN_SELECTOR)) names.add(match[1]);
    rule.walkDecls("composes", (decl) => {
      const target = /^\.(-?[_a-zA-Z][\w-]*)$/.exec(rule.selector.trim());
      if (!target) throw new Error(`composes is only allowed in a single-class rule: ${rule.selector}`);
      composed.set(target[1], [...(composed.get(target[1]) ?? []), ...parseComposes(decl).names]);
    });
  });
  return Object.fromEntries([...names].sort().map((name) => [name, [...new Set([name, ...(composed.get(name) ?? [])])].join(" ")]));
}

/** The module as a plain stylesheet under the identity class map: `:global(.dark) .tokens` → `.dark .tokens`. */
export function unwrapCssModule(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(GLOBAL_WRAPPER, "$1");
  });
  root.walkDecls("composes", (decl) => {
    const rule = decl.parent;
    decl.remove();
    if (rule && "nodes" in rule && rule.nodes?.length === 0) rule.remove();
  });
  return root.toString();
}

/** Custom properties declared on top-level (or `@layer`-wrapped) `:root` rules, later sheets and rules winning. */
export function rootCustomProperties(sheets: readonly string[]): Map<string, string> {
  const props = new Map<string, string>();
  for (const css of sheets) {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      if (rule.selector.trim() !== ":root") return;
      for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
        if (!(parent instanceof AtRule) || parent.name !== "layer") return;
      }
      rule.walkDecls((decl) => {
        if (CUSTOM_PROPERTY.test(decl.prop)) props.set(decl.prop, decl.value);
      });
    });
  }
  return props;
}

/**
 * The light-theme root tokens a stylesheet needs: every `var(--x)` it reads that it does not declare itself and that
 * `:root` defines, plus the `var()` closure of those values. Properties set inline by the components (layout
 * variables) are neither declared by the sheet nor on `:root` and are left alone. Throws on a dangling reference
 * inside the closure, which would otherwise render as an unstyled fallback.
 */
export function resolveRootTokens(css: string, rootProps: ReadonlyMap<string, string>): Record<string, string> {
  const declared = new Set<string>();
  const referenced = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    if (CUSTOM_PROPERTY.test(decl.prop)) declared.add(decl.prop);
    for (const match of decl.value.matchAll(VAR_REFERENCE)) referenced.add(match[1]);
  });
  const out = new Map<string, string>();
  const visit = (name: string, from: string | null): void => {
    if (out.has(name)) return;
    const value = rootProps.get(name);
    if (value === undefined) {
      if (from === null) return;
      throw new Error(`Root token ${from} references ${name}, which no :root block defines`);
    }
    out.set(name, value);
    for (const match of value.matchAll(VAR_REFERENCE)) visit(match[1], name);
  };
  for (const name of [...referenced].sort()) if (!declared.has(name)) visit(name, null);
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

let cssModuleHookRegistered = false;

/**
 * Lets Node import `*.module.css` as an identity class map (the bundler's job in the app). In-thread hook, so it
 * applies whether tsx compiles the components to CommonJS or ESM. Import components that read CSS modules only after
 * calling it (dynamic `import()`), since static imports are evaluated first.
 */
export function registerCssModuleHook(): void {
  if (cssModuleHookRegistered) return;
  cssModuleHookRegistered = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith(".module.css")) return nextLoad(url, context);
      const classes = cssModuleClassMap(readFileSync(fileURLToPath(url), "utf8"));
      return { format: "commonjs", shortCircuit: true, source: `module.exports = ${JSON.stringify(classes)};\n` };
    },
  });
}

export function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** An inlined WOFF2 `@font-face` (`font-display: block`, so the screenshot never catches a fallback face). */
export function woff2FontFace(family: string, weight: string, bytes: Uint8Array): string {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url("${dataUri("font/woff2", bytes)}") format("woff2");}`;
}

// ---------------------------------------------------------------------------
// Render (browser)
// ---------------------------------------------------------------------------

export interface ScenePngRender {
  /** CSS px width the page is laid out at. */
  viewportWidth: number;
  /** Device pixels per CSS px of the capture. */
  deviceScaleFactor: number;
  /** Output PNG size; the capture is a `viewportWidth`-wide crop of the same aspect ratio. */
  width: number;
  height: number;
  /** The crop starts `cropAbove` CSS px above this element's top edge. */
  anchorSelector: string;
  cropAbove: number;
  png: PngOptions;
  /** Prefix for error messages. */
  label: string;
}

/** Screenshots the document with Playwright Firefox (light, reduced motion) and downscales the capture to the PNG. */
export async function renderScenePng(html: string, opts: ScenePngRender): Promise<Buffer> {
  const { viewportWidth, deviceScaleFactor, cropAbove, width, height } = opts;
  const cropHeight = Math.round((viewportWidth * height) / width);
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: cropHeight + 400 }, deviceScaleFactor });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const anchorTop = await page.evaluate((selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null, opts.anchorSelector);
    if (anchorTop === null) throw new Error(`${opts.label}: ${opts.anchorSelector} did not render`);
    const capture = await page.screenshot({
      clip: { x: 0, y: Math.max(0, anchorTop - cropAbove), width: viewportWidth, height: cropHeight },
      scale: "device",
      timeout: 30_000,
    });
    return await sharp(capture).resize(width, height, { fit: "fill", kernel: "lanczos3" }).png(opts.png).toBuffer();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Signature, check and build (pure over files)
// ---------------------------------------------------------------------------

export interface SignedPngImageRecord {
  sha256: string;
  bytes: number;
}

export interface SignedPngPaths {
  imagePath: string;
  signaturePath: string;
}

export interface SignedPngProblem {
  kind: "missing-signature" | "stale-inputs" | "stale-signature" | "missing-image" | "image-modified" | "image-dimensions";
  message: string;
}

/** What a signed PNG is judged against: the document, the full expected signature for an image record, the PNG size. */
export interface SignedPngSpec {
  html: string;
  /** The complete signature file content (before serialisation) for a given image record; must embed `documentSha256`. */
  signature: (image: SignedPngImageRecord) => unknown;
  width: number;
  height: number;
  /** Shown in the stale-inputs message: what changing the document means for this card. */
  staleHint: string;
  /** Prefix for error messages. */
  label: string;
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The committed signature's document hash and image record, or null when the file is absent or malformed. */
function readCommittedSignature(path: string): { documentSha256: unknown; image: SignedPngImageRecord } | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("image" in parsed)) return null;
  const { image } = parsed;
  if (!image || typeof image !== "object" || !("sha256" in image) || !("bytes" in image)) return null;
  if (typeof image.sha256 !== "string" || typeof image.bytes !== "number") return null;
  return { documentSha256: "documentSha256" in parsed ? parsed.documentSha256 : undefined, image: { sha256: image.sha256, bytes: image.bytes } };
}

/** Platform-stable freshness check: the document hash and the committed PNG hash, never a re-render. */
export async function checkSignedPng(spec: SignedPngSpec, paths: SignedPngPaths): Promise<SignedPngProblem[]> {
  const committed = readCommittedSignature(paths.signaturePath);
  if (!committed) return [{ kind: "missing-signature", message: `${paths.signaturePath} is missing or unreadable` }];

  const problems: SignedPngProblem[] = [];
  const documentSha256 = sha256Hex(spec.html);
  if (committed.documentSha256 !== documentSha256) {
    problems.push({
      kind: "stale-inputs",
      message: `document signature ${String(committed.documentSha256).slice(0, 12)} != expected ${documentSha256.slice(0, 12)} (${spec.staleHint})`,
    });
  }
  if (readFileSync(paths.signaturePath, "utf8") !== serializeJson(spec.signature(committed.image))) {
    problems.push({ kind: "stale-signature", message: `${paths.signaturePath} does not match the expected signature` });
  }
  if (!existsSync(paths.imagePath)) {
    problems.push({ kind: "missing-image", message: `${paths.imagePath} is missing` });
    return problems;
  }
  const bytes = readFileSync(paths.imagePath);
  if (sha256HexFromBytes(bytes) !== committed.image.sha256) {
    problems.push({ kind: "image-modified", message: `${paths.imagePath} does not match the hash recorded when it was generated` });
  }
  const { format, width, height } = await sharp(bytes).metadata();
  if (format !== "png" || width !== spec.width || height !== spec.height) {
    problems.push({
      kind: "image-dimensions",
      message: `${paths.imagePath} is ${format} ${width}x${height}; expected png ${spec.width}x${spec.height}`,
    });
  }
  return problems;
}

function writeFileEnsuringDir(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Renders and writes the PNG plus its signature unless the committed outputs are current (or `force`). */
export async function buildSignedPng({
  spec,
  paths,
  render,
  force = false,
}: {
  spec: SignedPngSpec;
  paths: SignedPngPaths;
  render: (html: string) => Promise<Buffer>;
  force?: boolean;
}): Promise<{ status: "current" | "written"; imageBytes: number }> {
  if (!force && (await checkSignedPng(spec, paths)).length === 0) {
    return { status: "current", imageBytes: readFileSync(paths.imagePath).length };
  }
  const png = await render(spec.html);
  const { format, width, height } = await sharp(png).metadata();
  if (format !== "png" || width !== spec.width || height !== spec.height) {
    throw new Error(`${spec.label}: rendered ${format} ${width}x${height}, expected png ${spec.width}x${spec.height}; nothing written`);
  }
  writeFileEnsuringDir(paths.imagePath, png);
  writeFileEnsuringDir(paths.signaturePath, serializeJson(spec.signature({ sha256: sha256HexFromBytes(png), bytes: png.length })));
  return { status: "written", imageBytes: png.length };
}
