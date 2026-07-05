#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();
const OUTPUT = "docs/agent-code-map.md";
const CHECK = process.argv.includes("--check");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css"]);
const SKIP_PARTS = new Set(["node_modules", ".next", "out", ".git", ".wrangler", ".cache", ".impeccable"]);

const SECTIONS = [
  { title: "Frontend routes", root: "src/app", maxFiles: 180, include: (file) => /\/(page|client|layout|error|loading|not-found|robots|sitemap)\.(tsx|ts)$/.test(file) },
  { title: "Frontend hooks", root: "src/hooks", maxFiles: 50, include: sourceFile },
  { title: "Frontend library", root: "src/lib", maxFiles: 50, include: sourceFile },
  { title: "Key components", root: "src/components", maxFiles: 40, include: (file) => sourceFile(file) && !file.includes("/ui/") },
  { title: "Pages Functions", root: "functions", maxFiles: 50, include: sourceFile },
  { title: "Shared library", root: "shared/lib", maxFiles: 60, include: sourceFile },
  { title: "Stablecoin data", root: "shared/data/stablecoins", maxFiles: 40, include: (file) => file.endsWith(".json") },
  { title: "Worker routing", root: "worker/src/routes", maxFiles: 50, include: sourceFile },
  { title: "Worker handlers", root: "worker/src/handlers", maxFiles: 50, include: sourceFile },
  { title: "Worker API", root: "worker/src/api", maxFiles: 60, include: sourceFile },
  { title: "Worker cron", root: "worker/src/cron", maxFiles: 80, include: sourceFile },
  { title: "Worker library", root: "worker/src/lib", maxFiles: 60, include: sourceFile },
  { title: "Validation and tooling", root: "scripts", maxFiles: 60, include: (file) => /\.(mjs|js|ts)$/.test(file) },
];

function sourceFile(file) {
  return /\.(ts|tsx|js|mjs|css)$/.test(file) && !file.includes("/__tests__/") && !file.includes("/__mocks__/");
}

function extension(file) {
  const index = file.lastIndexOf(".");
  return index >= 0 ? file.slice(index) : "";
}

function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_PARTS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(extension(full))) continue;
      files.push(relative(ROOT, full).replaceAll("\\", "/"));
    }
  }

  walk(dir);
  return files.sort();
}

function extractExports(file) {
  if (!/\.(ts|tsx|js|mjs)$/.test(file)) return [];
  const content = readFileSync(file, "utf8");
  const exports = new Set();

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("export default async function")) {
      addDefaultExport(exports, trimmed.slice("export default async function".length));
      continue;
    }
    if (trimmed.startsWith("export default function")) {
      addDefaultExport(exports, trimmed.slice("export default function".length));
      continue;
    }
    if (trimmed.startsWith("export async function ")) {
      addNamedExport(exports, trimmed.slice("export async function ".length));
      continue;
    }

    for (const prefix of ["export function ", "export class ", "export interface ", "export type ", "export enum ", "export const "]) {
      if (trimmed.startsWith(prefix)) {
        addNamedExport(exports, trimmed.slice(prefix.length));
        break;
      }
    }

    if (trimmed.startsWith("export {")) {
      const end = trimmed.indexOf("}");
      if (end > "export {".length) {
        for (const part of trimmed.slice("export {".length, end).split(",")) {
          const name = part.trim().split(" as ")[0]?.trim();
          if (isIdentifier(name)) exports.add(name);
        }
      }
    }
  }

  return [...exports].sort().slice(0, 6);
}

function addDefaultExport(exports, rest) {
  const name = readIdentifier(rest.trimStart());
  exports.add(name ? `default:${name}` : "default");
}

function addNamedExport(exports, rest) {
  const name = readIdentifier(rest.trimStart());
  if (name) exports.add(name);
}

function readIdentifier(text) {
  let name = "";
  for (const char of text) {
    if (name.length === 0) {
      if (!isIdentifierStart(char)) return "";
      name += char;
      continue;
    }
    if (!isIdentifierChar(char)) break;
    name += char;
  }
  return name;
}

function isIdentifier(value) {
  if (!value) return false;
  return readIdentifier(value) === value;
}

function isIdentifierStart(char) {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_" || char === "$";
}

function isIdentifierChar(char) {
  return isIdentifierStart(char) || (char >= "0" && char <= "9");
}

function summarizeJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(value)) return `${value.length} entries`;
    if (value && typeof value === "object") return `${Object.keys(value).length} keys`;
  } catch {
    return "json";
  }
  return "json";
}

function routeFromPageFile(file) {
  if (!file.startsWith("src/app/") || !file.endsWith("/page.tsx")) return null;
  const route = file.slice("src/app".length, -"/page.tsx".length);
  return route || "/";
}

function lineFor(file) {
  const route = routeFromPageFile(file);
  const details = file.endsWith(".json") ? summarizeJson(file) : extractExports(file).join(", ");
  const suffixes = [];
  if (route) suffixes.push(`route ${route}`);
  if (details) suffixes.push(details);
  return suffixes.length > 0 ? `- \`${file}\` - ${suffixes.join("; ")}` : `- \`${file}\``;
}

const lines = [
  "# Agent Code Map",
  "",
  "Generated by `node scripts/maintenance/generate-agent-code-map.mjs`.",
  "",
  "Use this as a compact discovery aid. It lists source entrypoints and top-level exports so agents can choose which files to inspect next. It is not a replacement for reading the implementation before editing.",
  "",
];

for (const section of SECTIONS) {
  const files = collectFiles(join(ROOT, section.root)).filter(section.include);
  lines.push(`## ${section.title}`, "");
  if (files.length === 0) {
    lines.push("No matching files.", "");
    continue;
  }
  const visibleFiles = files.slice(0, section.maxFiles);
  for (const file of visibleFiles) lines.push(lineFor(file));
  if (visibleFiles.length < files.length) {
    lines.push(`- ... ${files.length - visibleFiles.length} more files omitted; use \`rg --files ${section.root}\` for the full list.`);
  }
  lines.push("");
}

const outputPath = join(ROOT, OUTPUT);
const contents = `${lines.join("\n").trimEnd()}\n`;

if (CHECK) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== contents) {
    console.error(`${OUTPUT} is out of date. Run \`node scripts/maintenance/generate-agent-code-map.mjs\`.`);
    process.exit(1);
  }
  console.log(`${OUTPUT} is up to date.`);
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, contents);
const size = statSync(outputPath).size;
console.log(`Wrote ${OUTPUT} (${size} bytes).`);
