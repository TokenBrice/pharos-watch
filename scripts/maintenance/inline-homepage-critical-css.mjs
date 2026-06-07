#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Beasties from "beasties";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "out");
const homepagePath = path.join(outDir, "index.html");

if (!existsSync(homepagePath)) {
  console.error("[critical-css] Missing out/index.html. Run next build first.");
  process.exit(1);
}

const before = readFileSync(homepagePath, "utf8");
const optimizer = new Beasties({
  path: outDir,
  publicPath: "/",
  preload: "media",
  pruneSource: false,
  reduceInlineStyles: false,
  inlineFonts: false,
  fonts: false,
  logLevel: process.env.BEASTIES_LOG_LEVEL || "error",
});

const after = await optimizer.process(before);
const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

if (!/<style\b[^>]*>/.test(after)) {
  console.error("[critical-css] Beasties did not inline a critical style block.");
  process.exit(1);
}

if (/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/chunks\/[^"']+\.css)(?![^>]*\bmedia=["']print["'])[^>]*>/i.test(withoutNoscript)) {
  console.error("[critical-css] Homepage still has a render-blocking Next CSS link outside <noscript>.");
  process.exit(1);
}

if (after !== before) {
  writeFileSync(homepagePath, after);
}

console.log(
  `[critical-css] Optimized out/index.html (${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)} bytes).`,
);
