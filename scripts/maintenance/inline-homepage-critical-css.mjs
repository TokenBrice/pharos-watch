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

const asyncCssLoaderPath = "/critical-css-loader.js";

let after = await optimizer.process(before);
const asyncStylesheetPattern =
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/chunks\/[^"']+\.css)(?=[^>]*\bmedia=["']print["'])(?=[^>]*\bonload=["']this\.media\s*=\s*["']all["']["'])[^>]*>/gi;

let hasAsyncStylesheet = false;
after = after.replace(asyncStylesheetPattern, (tag) => {
  hasAsyncStylesheet = true;
  const withoutInlineHandler = tag.replace(/\s+onload=["']this\.media\s*=\s*["']all["']["']/i, "");

  if (/\sdata-pharos-critical-css=/.test(withoutInlineHandler)) {
    return withoutInlineHandler;
  }

  return withoutInlineHandler.replace(/\s*\/?>$/, ' data-pharos-critical-css="async">');
});

if (hasAsyncStylesheet && !after.includes(`src="${asyncCssLoaderPath}"`)) {
  after = after.replace("</head>", `<script src="${asyncCssLoaderPath}" defer></script></head>`);
}

const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

if (!/<style\b[^>]*>/.test(after)) {
  console.error("[critical-css] Beasties did not inline a critical style block.");
  process.exit(1);
}

if (/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/chunks\/[^"']+\.css)(?![^>]*\bmedia=["']print["'])[^>]*>/i.test(withoutNoscript)) {
  console.error("[critical-css] Homepage still has a render-blocking Next CSS link outside <noscript>.");
  process.exit(1);
}

if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(withoutNoscript)) {
  console.error("[critical-css] Homepage contains an inline event handler outside <noscript>.");
  process.exit(1);
}

if (hasAsyncStylesheet && !after.includes(`src="${asyncCssLoaderPath}"`)) {
  console.error("[critical-css] Homepage has async critical CSS without the CSP-safe loader script.");
  process.exit(1);
}

if (after !== before) {
  writeFileSync(homepagePath, after);
}

console.log(
  `[critical-css] Optimized out/index.html (${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)} bytes).`,
);
