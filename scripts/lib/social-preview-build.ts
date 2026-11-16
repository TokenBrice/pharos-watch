import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
  SOCIAL_PREVIEW_HEIGHT,
  SOCIAL_PREVIEW_REVISION,
  SOCIAL_PREVIEW_WIDTH,
  socialPreviewAlt,
  socialPreviewDescription,
  type SocialPreviewImage,
  type SocialPreviewSpec,
} from "../../shared/lib/social-preview";
import { getRouteCapabilities } from "../../src/lib/route-capabilities";
import { atomicWriteFileSync } from "./atomic-artifact-write.mts";
import { contentSha256, readPngSourceFingerprint } from "./og-image-checks.mts";
import { buildOgStaticRenderInputs, buildOgStaticSourceFingerprint, runOgStaticBuild, type OgStaticFont } from "./og-static-runner.mts";
import { OG_RESVG_RUNTIME_SOURCE_PATHS } from "./og-resvg-render.mts";
import { collectModuleSpecifiers, resolveModulePattern, resolveModuleSpecifier } from "./pr-import-graph.mts";
import { buildSocialPreviewCatalog } from "./social-preview-catalog";
import { buildSocialPreviewSvg, SOCIAL_PREVIEW_BACKGROUND, type SocialPreviewLogo } from "./social-preview-render";

export const SOCIAL_PREVIEW_GENERATOR = "scripts/maintenance/build-og-evergreen.ts";
export const SOCIAL_PREVIEW_MAP_PATH = "src/generated/social-preview-images.json";
export const SOCIAL_PREVIEW_SIGNATURE_PATH = "scripts/maintenance/state/social-preview-images.json";
const HASH = /^[a-f0-9]{64}$/;
const ASSET_URL = /^\/og\/v2\/[a-z0-9-]+-[a-f0-9]{64}\.png$/;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type SourceSha256 = `sha256:${string}`;

interface RetainedImage {
  kind: "rendered" | "authored";
  pngSha256: string;
  sourceFingerprint: string;
}
interface PreviewBuildCard {
  kind: RetainedImage["kind"];
  path: string;
  url: string;
  sourceFingerprint: string;
  semanticHash: string;
}
interface PreviewManifest {
  generatedBy: typeof SOCIAL_PREVIEW_GENERATOR;
  revision: typeof SOCIAL_PREVIEW_REVISION;
  toolchainFingerprint: string;
  sources: Record<string, SourceSha256>;
  cards: PreviewBuildCard[];
  retained: Record<string, RetainedImage>;
}

/** Static leaves are discovered, not copied into another hand-maintained route inventory. */
export function discoverSocialPreviewPages(repoRoot: string): { paths: string[]; files: string[] } {
  const paths: string[] = [];
  const files: string[] = [];
  function visit(directory: string, segments: string[]): void {
    const route = `/${segments.filter((segment) => !segment.startsWith("(")).join("/")}/`.replace(/^\/\//, "/");
    if (getRouteCapabilities(route).chrome !== "public") return;
    for (const entry of readdirSync(resolve(repoRoot, directory), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("@") && !entry.name.startsWith("_")) {
        visit(`${directory}/${entry.name}`, [...segments, entry.name]);
      } else if (entry.isFile() && entry.name === "page.tsx") {
        files.push(`${directory}/${entry.name}`);
        if (segments.every((segment) => !segment.startsWith("["))) paths.push(route);
      }
    }
  }
  visit("src/app", []);
  return { paths: [...new Set(paths)].sort(), files: files.sort() };
}

function fonts(repoRoot: string): OgStaticFont[] {
  return [
    { key: "display", family: "Geist", file: resolve(repoRoot, "src/assets/fonts/originals/Geist-Bold.ttf"), weight: 700 },
    { key: "editorial", family: "Newsreader", file: resolve(repoRoot, "src/assets/fonts/originals/Newsreader-Variable.ttf"), weight: "200 800" },
    { key: "body", family: "Geist", file: resolve(repoRoot, "src/assets/fonts/originals/Geist-Regular.ttf"), weight: 400 },
    { key: "mono", family: "Geist Mono", file: resolve(repoRoot, "src/assets/fonts/originals/GeistMono-Regular.ttf"), weight: 400 },
  ];
}

/** Runtime import closure plus the exact files read outside imports (shards, brand, fonts, covers, page membership). */
function sourceManifest(repoRoot: string, exactFiles: readonly string[]): Record<string, SourceSha256> {
  const pending = [SOCIAL_PREVIEW_GENERATOR];
  const files = new Set(exactFiles);
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    files.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const parsed = collectModuleSpecifiers(readFileSync(resolve(repoRoot, file), "utf8"));
    if (parsed.unterminated) throw new Error(`Cannot close social preview source inputs: ${file}: ${parsed.unterminated}`);
    for (const specifier of parsed.specifiers) {
      const target = resolveModuleSpecifier(specifier, file, { cwd: repoRoot });
      if (target.kind === "unresolved") throw new Error(`Cannot close social preview source inputs: ${target.reason}`);
      if (target.kind === "file") pending.push(target.file);
    }
    for (const pattern of parsed.patterns) {
      const expanded = resolveModulePattern(pattern, file, { cwd: repoRoot });
      if (expanded.unresolved) throw new Error(`Cannot close social preview source inputs: ${expanded.unresolved}`);
      pending.push(...expanded.files);
    }
  }
  return Object.fromEntries([...files].sort().map((file): [string, SourceSha256] => [file, `sha256:${contentSha256(readFileSync(resolve(repoRoot, file)))}`]));
}

function assertPngDimensions(bytes: Buffer, label: string): void {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== SOCIAL_PREVIEW_WIDTH || bytes.readUInt32BE(20) !== SOCIAL_PREVIEW_HEIGHT) {
    throw new Error(`Social preview must be a ${SOCIAL_PREVIEW_WIDTH}×${SOCIAL_PREVIEW_HEIGHT} PNG: ${label}`);
  }
}

/** Existing hash URLs are verified or rejected, never repaired by overwriting/rebaselining their bytes. */
export function verifyImmutableSocialPreview(bytes: Buffer, expected: { sourceFingerprint: string; pngSha256?: string; kind?: RetainedImage["kind"] }, label: string): RetainedImage {
  assertPngDimensions(bytes, label);
  const kind = expected.kind ?? "rendered";
  const pngSha256 = contentSha256(bytes);
  const actualSource = kind === "authored" ? pngSha256 : readPngSourceFingerprint(bytes);
  if (!HASH.test(expected.sourceFingerprint) || actualSource !== expected.sourceFingerprint) {
    throw new Error(`Immutable social preview source mismatch: ${label}. Restore its original bytes; changed source needs a new URL.`);
  }
  if (expected.pngSha256 !== undefined && pngSha256 !== expected.pngSha256) {
    throw new Error(`Immutable social preview bytes changed: ${label}. Restore the retained artifact; generation cannot rebaseline it.`);
  }
  return { kind, pngSha256, sourceFingerprint: expected.sourceFingerprint };
}

function readRetainedManifest(path: string): Record<string, RetainedImage> {
  if (!existsSync(path)) return {};
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || typeof manifest !== "object" || !("generatedBy" in manifest) || manifest.generatedBy !== SOCIAL_PREVIEW_GENERATOR
    || !("revision" in manifest) || manifest.revision !== SOCIAL_PREVIEW_REVISION || !("retained" in manifest)
    || !manifest.retained || typeof manifest.retained !== "object" || Array.isArray(manifest.retained)) {
    throw new Error("Invalid retained social preview manifest; restore it rather than discarding immutable history.");
  }
  const retained: Record<string, RetainedImage> = {};
  for (const [url, value] of Object.entries(manifest.retained)) {
    if (!ASSET_URL.test(url) || !value || typeof value !== "object" || !("pngSha256" in value) || typeof value.pngSha256 !== "string"
      || !HASH.test(value.pngSha256) || !("sourceFingerprint" in value) || typeof value.sourceFingerprint !== "string" || !HASH.test(value.sourceFingerprint)
      || !("kind" in value) || (value.kind !== "rendered" && value.kind !== "authored")) {
      throw new Error(`Invalid retained social preview record: ${url}`);
    }
    retained[url] = { kind: value.kind, pngSha256: value.pngSha256, sourceFingerprint: value.sourceFingerprint };
  }
  return retained;
}

function assetUrl(hash: string): string {
  return `/og/v2/image-${hash}.png`;
}

export function socialPreviewAssetUrl(spec: SocialPreviewSpec, sourceFingerprint: string, toolchainFingerprint: string): { url: string; semanticHash: string } {
  const semanticHash = contentSha256(JSON.stringify({ revision: SOCIAL_PREVIEW_REVISION, spec, sourceFingerprint, toolchainFingerprint }));
  return { url: assetUrl(semanticHash), semanticHash };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function publishJson(path: string, content: string, check: boolean): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  if (check) throw new Error(`Social preview artifact is stale: ${path}. Run npm run build:og-evergreen.`);
  mkdirSync(resolve(path, ".."), { recursive: true });
  atomicWriteFileSync(path, content);
  return true;
}

export function publishImmutablePng(publicDir: string, url: string, bytes: Buffer, expected: RetainedImage): RetainedImage {
  verifyImmutableSocialPreview(bytes, expected, url);
  const destination = resolve(publicDir, url.slice(1));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  try {
    writeFileSync(destination, bytes, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return verifyImmutableSocialPreview(readFileSync(destination), expected, url);
}

/** Admit local resources once; resvg cannot decode every browser-supported raster format. */
export async function readSocialPreviewLogo(repoRoot: string, path: string): Promise<SocialPreviewLogo> {
  const match = /^\/logos\/[a-z0-9-]+\.(png|jpe?g|webp|svg)$/i.exec(path);
  if (!match) throw new Error(`Social preview logo must be a registered local image: ${path}`);
  const bytes = readFileSync(resolve(repoRoot, `public${path}`));
  const isSvg = match[1].toLowerCase() === "svg";
  if (isSvg) {
    const svg = bytes.toString("utf8");
    const references = [...svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi), ...svg.matchAll(/url\(\s*["']?([^"')\s]+)/gi)];
    if (/<(?:script|foreignObject)\b|@import/i.test(svg) || references.some((reference) => !reference[1].startsWith("#") && !reference[1].startsWith("data:image/"))) {
      throw new Error(`Social preview logo has an external or executable resource: ${path}`);
    }
  }
  let encoded = bytes;
  if (!isSvg) {
    try {
      encoded = await sharp(bytes).rotate().png().toBuffer();
    } catch (cause) {
      throw new Error(`Social preview logo could not be decoded: ${path}`, { cause });
    }
  }
  return {
    dataUri: `data:${isSvg ? "image/svg+xml" : "image/png"};base64,${encoded.toString("base64")}`,
    sourceSha256: contentSha256(bytes),
  };
}

export async function buildSocialPreviewImages({ repoRoot, check }: { repoRoot: string; check: boolean }): Promise<{ routes: number; rendered: number }> {
  const pages = discoverSocialPreviewPages(repoRoot);
  const catalog = buildSocialPreviewCatalog(pages.paths);
  const brandPath = "public/pharos-mark-on-dark.svg";
  const brand = readFileSync(resolve(repoRoot, brandPath), "utf8");
  const logoPaths = new Set(catalog.specs.flatMap(({ visual }) => visual.kind === "identity"
    ? visual.logoPath ? [visual.logoPath] : []
    : visual.kind === "contrast" ? [visual.left.logoPath, visual.right.logoPath].filter((path): path is string => path !== undefined) : []));
  const logoAssets = new Map<string, SocialPreviewLogo>();
  for (const path of logoPaths) {
    logoAssets.set(path, await readSocialPreviewLogo(repoRoot, path));
  }
  const renderFonts = fonts(repoRoot);
  const renderInputs = buildOgStaticRenderInputs({ fonts: renderFonts, background: SOCIAL_PREVIEW_BACKGROUND, width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, renderer: "resvg" });
  const toolchainFingerprint = renderInputs.runtimeFingerprint;
  const cards = catalog.specs.map((spec) => {
    const svg = buildSocialPreviewSvg(spec, brand, logoAssets);
    const sourceFingerprint = buildOgStaticSourceFingerprint(svg, renderInputs);
    const identity = socialPreviewAssetUrl(spec, sourceFingerprint, toolchainFingerprint);
    return { ...identity, kind: "rendered" as const, path: spec.path, sourceFingerprint, svg, spec, file: identity.url.slice("/og/v2/".length) };
  });
  const authored = catalog.preserved.map((entry) => {
    if (!entry.url.startsWith("/") || entry.url.startsWith("//") || entry.url.split("/").includes("..") || !entry.url.endsWith(".png")) throw new Error(`Invalid authored social preview path: ${entry.url}`);
    const sourceFile = `public${entry.url}`;
    const bytes = readFileSync(resolve(repoRoot, sourceFile));
    assertPngDimensions(bytes, entry.url);
    const pngSha256 = contentSha256(bytes);
    return { ...entry, sourceFile, bytes, kind: "authored" as const, url: assetUrl(pngSha256), semanticHash: pngSha256, sourceFingerprint: pngSha256, pngSha256 };
  });
  const allCards = [...cards, ...authored];
  if (new Set(allCards.map((card) => card.url)).size !== allCards.length) throw new Error("Social preview asset identity collision");

  const publicDir = resolve(repoRoot, "public");
  const assetDir = resolve(publicDir, "og/v2");
  const signaturePath = resolve(repoRoot, SOCIAL_PREVIEW_SIGNATURE_PATH);
  const retained = readRetainedManifest(signaturePath);
  for (const [url, record] of Object.entries(retained)) {
    const path = resolve(publicDir, url.slice(1));
    if (!existsSync(path)) throw new Error(`Retained social preview is missing: ${url}. Restore its original bytes.`);
    verifyImmutableSocialPreview(readFileSync(path), record, url);
  }
  const currentUrls = new Set(allCards.map((card) => card.url));
  if (existsSync(assetDir)) {
    for (const file of readdirSync(assetDir)) {
      const url = `/og/v2/${file}`;
      if (!statSync(join(assetDir, file)).isFile() || (!retained[url] && !currentUrls.has(url))) {
        throw new Error(`Unregistered immutable social preview: ${url}. Restore its retained manifest; assets are never pruned.`);
      }
    }
  }
  const missing = cards.filter((card) => !existsSync(resolve(publicDir, card.url.slice(1))));
  for (const card of allCards) {
    const path = resolve(publicDir, card.url.slice(1));
    if (existsSync(path)) retained[card.url] = verifyImmutableSocialPreview(readFileSync(path), { kind: card.kind, sourceFingerprint: card.sourceFingerprint, pngSha256: retained[card.url]?.pngSha256 }, card.url);
  }
  const missingAuthored = authored.filter((card) => !existsSync(resolve(publicDir, card.url.slice(1))));
  if (check && (missing.length || missingAuthored.length)) {
    throw new Error(`Social previews are missing: ${(missing[0] ?? missingAuthored[0]).url}. Run npm run build:og-evergreen.`);
  }

  const exactFiles = [
    ...pages.files, ...authored.map((card) => card.sourceFile), brandPath, "package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", ...OG_RESVG_RUNTIME_SOURCE_PATHS,
    ...[...logoPaths].map((path) => `public${path}`),
    ...renderFonts.map((font) => font.file.slice(repoRoot.length + 1)),
    ...readdirSync(resolve(repoRoot, "data/depeg-events")).filter((file) => /^(?:index|\d{4})\.json$/.test(file)).map((file) => `data/depeg-events/${file}`),
  ];
  const sources = sourceManifest(repoRoot, exactFiles);

  if (missing.length) {
    mkdirSync(resolve(repoRoot, "agents"), { recursive: true });
    const temporary = mkdtempSync(resolve(repoRoot, "agents/social-preview-"));
    try {
      const renderedDir = resolve(temporary, "rendered");
      await runOgStaticBuild({
        check: false, family: "Evergreen social previews", fonts: renderFonts, generatedBy: SOCIAL_PREVIEW_GENERATOR,
        publicDir: renderedDir, refreshCommand: "npm run build:og-evergreen", roster: missing,
        signaturePath: resolve(temporary, "render-signatures.json"), stagingDir: resolve(temporary, "staging"),
        width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, background: SOCIAL_PREVIEW_BACKGROUND, renderer: "resvg",
      });
      for (const card of missing) {
        const bytes = readFileSync(resolve(renderedDir, card.file));
        retained[card.url] = publishImmutablePng(publicDir, card.url, bytes, { kind: card.kind, sourceFingerprint: card.sourceFingerprint, pngSha256: contentSha256(bytes) });
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  for (const card of missingAuthored) retained[card.url] = publishImmutablePng(publicDir, card.url, card.bytes, card);

  const imageFields = { width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, type: "image/png" } as const;
  const map: Record<string, SocialPreviewImage> = Object.fromEntries([
    ...cards.map((card): [string, SocialPreviewImage] => [card.path, {
      title: card.spec.subject, description: socialPreviewDescription(card.spec),
      url: card.url, alt: socialPreviewAlt(card.spec), ...imageFields,
    }]),
    ...authored.map((entry): [string, SocialPreviewImage] => [entry.path, {
      title: entry.title, description: entry.description, url: entry.url, alt: entry.alt, ...imageFields,
    }]),
  ].sort(([left], [right]) => left.localeCompare(right)));
  const manifest: PreviewManifest = {
    generatedBy: SOCIAL_PREVIEW_GENERATOR, revision: SOCIAL_PREVIEW_REVISION, sources, toolchainFingerprint,
    cards: allCards.map(({ kind, path, url, sourceFingerprint, semanticHash }) => ({ kind, path, url, sourceFingerprint, semanticHash })),
    retained: Object.fromEntries(Object.entries(retained).sort(([left], [right]) => left.localeCompare(right))),
  };
  // Images precede the manifest; the route map is promoted last, never advertising an unretained asset.
  publishJson(signaturePath, serialize(manifest), check);
  publishJson(resolve(repoRoot, SOCIAL_PREVIEW_MAP_PATH), serialize(map), check);
  return { routes: Object.keys(map).length, rendered: missing.length };
}
