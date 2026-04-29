#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const assetRoot = resolve(repoRoot, "public/pharosville/assets");
const manifestPath = join(assetRoot, "manifest.json");
const pharosVilleSrcRoot = resolve(repoRoot, "src/app/pharosville");
const forbiddenPattern = /(Bearer|PIXELLAB|NEXT_PUBLIC_PIXELLAB|pixellab\.ai|https?:\/\/)/i;
const placeholderPattern = /(placeholder|checker|debug|sample)/i;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const allowedCategories = new Set(["terrain", "landmark", "dock", "ship", "prop", "overlay"]);
const allowedPriorities = new Set(["critical", "deferred"]);
const hexColorPattern = /^#[0-9a-f]{6}$/i;
const assetIdPattern = /^(building|dock|landmark|overlay|prop|ship|terrain)\.[a-z0-9-]+$/;
const pharosVilleSourceExtensionPattern = /\.(?:ts|tsx)$/;
const pharosVilleTestFilePattern = /(?:^|\/)(?:__tests__|tests?)\/|\.test\.(?:ts|tsx)$/;

const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const errors = [];

if (manifest.schemaVersion !== 1) errors.push("Manifest schemaVersion must be 1.");
validateStyle(manifest.style);
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) errors.push("Manifest assets array is required.");
if (manifest.assets?.length > 34) errors.push(`Manifest has ${manifest.assets.length} assets; v0.1 core cap is 34.`);
if (!Array.isArray(manifest.requiredForFirstRender)) errors.push("Manifest requiredForFirstRender array is required.");

const ids = new Set();
const referenced = new Set(["manifest.json"]);
for (const requiredId of manifest.requiredForFirstRender ?? []) {
  if (typeof requiredId !== "string") errors.push("requiredForFirstRender entries must be strings.");
  if (!manifest.assets?.some((asset) => asset.id === requiredId)) {
    errors.push(`requiredForFirstRender references missing asset ${requiredId}.`);
  }
}

for (const asset of manifest.assets ?? []) {
  validateAsset(asset, ids, referenced);
}
validateReferencedAssetIds(ids);

for (const pngPath of listPngs(assetRoot)) {
  const relativePath = relative(assetRoot, pngPath).split(sep).join("/");
  if (!referenced.has(relativePath)) errors.push(`Orphan PNG is not referenced by manifest: ${relativePath}`);
}
for (const filePath of listFiles(assetRoot)) {
  const relativePath = relative(assetRoot, filePath).split(sep).join("/");
  const bytes = readFileSync(filePath);
  const text = bytes.toString("utf8");
  if (forbiddenPattern.test(text)) {
    errors.push(`Public asset file contains a forbidden token marker or URL: ${relativePath}`);
  }
}

if (errors.length > 0) {
  console.error("PharosVille asset validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`PharosVille asset validation passed for ${manifest.assets.length} assets.`);

function validateAsset(asset, ids, referenced) {
  const id = typeof asset.id === "string" ? asset.id : "<missing id>";
  if (!asset.id) errors.push("Asset is missing id.");
  if (typeof asset.id !== "string") errors.push("Asset id must be a string.");
  if (typeof asset.id === "string" && !assetIdPattern.test(asset.id)) {
    errors.push(`${id} id must be a namespaced asset id.`);
  }
  if (!allowedCategories.has(asset.category)) errors.push(`${id} category is invalid: ${asset.category}`);
  if (!asset.layer || typeof asset.layer !== "string") errors.push(`${id} layer is required.`);
  if (!allowedPriorities.has(asset.loadPriority)) errors.push(`${id} loadPriority is invalid: ${asset.loadPriority}`);
  if (!Number.isFinite(asset.displayScale) || asset.displayScale <= 0 || asset.displayScale > 4) {
    errors.push(`${id} displayScale must be a positive number <= 4.`);
  }
  if (!Number.isInteger(asset.width) || asset.width <= 0) errors.push(`${id} width must be a positive integer.`);
  if (!Number.isInteger(asset.height) || asset.height <= 0) errors.push(`${id} height must be a positive integer.`);
  if (!Array.isArray(asset.footprint) || asset.footprint.length !== 2) errors.push(`${id} footprint must be [width,height].`);
  if (Array.isArray(asset.footprint) && (
    asset.footprint.some((value) => !Number.isFinite(value) || value <= 0)
  )) {
    errors.push(`${id} footprint values must be positive numbers.`);
  }
  if (ids.has(id)) errors.push(`Duplicate asset id: ${id}`);
  ids.add(id);
  if (!asset.path || typeof asset.path !== "string") {
    errors.push(`${id} is missing path.`);
    return;
  }
  if (asset.path.includes("..") || normalize(asset.path).startsWith("..")) {
    errors.push(`${id} path uses traversal: ${asset.path}`);
    return;
  }
  if (asset.path.startsWith("/") || asset.path.includes("://")) {
    errors.push(`${id} path must be relative to public/pharosville/assets.`);
    return;
  }
  if (!asset.path.endsWith(".png")) errors.push(`${id} path must point to a PNG.`);
  if (placeholderPattern.test(asset.path) || placeholderPattern.test(id)) {
    errors.push(`${id} must not reference placeholder/checker/debug assets in production.`);
  }
  referenced.add(asset.path);
  const fullPath = join(assetRoot, asset.path);
  let bytes;
  try {
    bytes = readFileSync(fullPath);
  } catch {
    errors.push(`${id} file is missing: ${asset.path}`);
    return;
  }
  if (statSync(fullPath).size < 100) errors.push(`${id} PNG is too small to be a real asset.`);
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    errors.push(`${id} is not a PNG file: ${asset.path}`);
    return;
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") errors.push(`${id} PNG is missing an IHDR chunk.`);
  if (!bytes.includes(Buffer.from("IEND", "ascii"))) errors.push(`${id} PNG is missing an IEND chunk.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== asset.width || height !== asset.height) {
    errors.push(`${id} dimensions are ${width}x${height}, manifest says ${asset.width}x${asset.height}.`);
  }
  if (!Array.isArray(asset.anchor) || asset.anchor.length !== 2) errors.push(`${id} anchor must be [x,y].`);
  if (Array.isArray(asset.anchor) && (
    asset.anchor[0] < 0 || asset.anchor[1] < 0 || asset.anchor[0] > asset.width || asset.anchor[1] > asset.height
  )) {
    errors.push(`${id} anchor is outside bounds.`);
  }
  if (!Array.isArray(asset.hitbox) || asset.hitbox.length !== 4) errors.push(`${id} hitbox must be [x,y,width,height].`);
  if (Array.isArray(asset.hitbox) && asset.hitbox.length === 4) {
    const [x, y, hitWidth, hitHeight] = asset.hitbox;
    if (asset.hitbox.some((value) => !Number.isFinite(value))) errors.push(`${id} hitbox values must be numbers.`);
    if (hitWidth <= 0 || hitHeight <= 0) errors.push(`${id} hitbox size must be positive.`);
    if (x < 0 || y < 0 || x + hitWidth > asset.width || y + hitHeight > asset.height) {
      errors.push(`${id} hitbox is outside image bounds.`);
    }
  }
  if (asset.promptProvenance) {
    if (asset.promptProvenance.styleAnchorVersion !== manifest.style?.assetVersion) {
      errors.push(`${id} promptProvenance.styleAnchorVersion must match style.assetVersion.`);
    }
    if (asset.promptProvenance.jobId && typeof asset.promptProvenance.jobId !== "string") {
      errors.push(`${id} promptProvenance.jobId must be a string when present.`);
    }
  }
  validateOptionalMetadata(asset, id);
}

function listPngs(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listPngs(path));
    if (entry.isFile() && entry.name.endsWith(".png")) files.push(path);
  }
  return files;
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function validateStyle(style) {
  if (!style || typeof style !== "object") {
    errors.push("Manifest style object is required.");
    return;
  }
  if (!style.assetVersion || typeof style.assetVersion !== "string") errors.push("Manifest style.assetVersion is required.");
  if (!style.anchor || typeof style.anchor !== "string") errors.push("Manifest style.anchor is required.");
  if (!Array.isArray(style.palette) || style.palette.length < 4) errors.push("Manifest style.palette must include at least four colors.");
  for (const color of style.palette ?? []) {
    if (typeof color !== "string" || !hexColorPattern.test(color)) errors.push(`Manifest style.palette has invalid color: ${color}`);
  }
  const defaults = style.generationDefaults;
  if (!defaults || typeof defaults !== "object") {
    errors.push("Manifest style.generationDefaults object is required.");
    return;
  }
  for (const key of ["view", "outline", "shading", "detail"]) {
    if (!defaults[key] || typeof defaults[key] !== "string") {
      errors.push(`Manifest style.generationDefaults.${key} is required.`);
    }
  }
  if (typeof defaults.transparentBackground !== "boolean") {
    errors.push("Manifest style.generationDefaults.transparentBackground must be boolean.");
  }
}

function validateOptionalMetadata(asset, id) {
  for (const key of ["promptKey", "semanticRole", "criticalReason"]) {
    if (asset[key] != null && (typeof asset[key] !== "string" || asset[key].trim() === "")) {
      errors.push(`${id} ${key} must be a non-empty string when present.`);
    }
  }
  if (asset.criticalReason != null && asset.loadPriority !== "critical" && !(manifest.requiredForFirstRender ?? []).includes(asset.id)) {
    errors.push(`${id} criticalReason is only valid for critical or first-render assets.`);
  }
  if (asset.paletteKeys != null) {
    if (!Array.isArray(asset.paletteKeys) || asset.paletteKeys.length === 0) {
      errors.push(`${id} paletteKeys must be a non-empty string array when present.`);
      return;
    }
    for (const paletteKey of asset.paletteKeys) {
      if (typeof paletteKey !== "string" || paletteKey.trim() === "") {
        errors.push(`${id} paletteKeys entries must be non-empty strings.`);
      }
    }
  }
}

function validateReferencedAssetIds(manifestIds) {
  const referencedIds = new Map();
  const add = (id, source) => {
    const sources = referencedIds.get(id) ?? new Set();
    sources.add(source);
    referencedIds.set(id, sources);
  };

  add("landmark.lighthouse", "world renderer lighthouse");
  add("prop.tombstone", "world renderer graves");
  for (const relativePath of pharosVilleSourceFiles()) {
    for (const id of assetIdsInSource(relativePath)) add(id, relativePath);
    for (const hull of shipHullsInSource(relativePath)) add(`ship.${hull}`, relativePath);
  }

  for (const [id, sources] of referencedIds) {
    if (!manifestIds.has(id)) {
      errors.push(`Manifest is missing referenced asset ${id} from ${[...sources].join(", ")}.`);
    }
  }
}

function assetIdsInSource(relativePath) {
  const source = readFileSync(join(pharosVilleSrcRoot, relativePath), "utf8");
  return [...source.matchAll(/(?:["'`])((?:building|dock|landmark|overlay|prop|ship|terrain)\.[a-z0-9-]+)(?:["'`])/g)]
    .map((match) => match[1]);
}

function shipHullsInSource(relativePath) {
  const source = readFileSync(join(pharosVilleSrcRoot, relativePath), "utf8");
  return [...source.matchAll(/hull:\s*["'`]([a-z0-9-]+)["'`]/g)].map((match) => match[1]);
}

function pharosVilleSourceFiles() {
  return execFileSync("git", ["ls-files", "src/app/pharosville"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file.startsWith("src/app/pharosville/"))
    .filter((file) => existsSync(file))
    .filter((file) => pharosVilleSourceExtensionPattern.test(file) && !pharosVilleTestFilePattern.test(file))
    .map((file) => relative(pharosVilleSrcRoot, resolve(repoRoot, file)).split(sep).join("/"))
    .sort();
}
