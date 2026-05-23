#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SOURCE_ROOT = "src";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "coverage"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const FAT_REGISTRY_IMPORTS = new Set([
  "@shared/lib/stablecoins",
  "@shared/lib/stablecoins/index",
  "@shared/lib/stablecoins/registry",
]);

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function collectFiles(dir, acc) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) {
      acc.push(full);
    }
  }
}

function hasUseClientDirective(source) {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return /^["']use client["'];/.test(withoutBom.trimStart());
}

function toRel(absPath) {
  return relative(ROOT, absPath).replaceAll("\\", "/");
}

function getScriptKind(path) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function resolveSourceImport(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) {
    base = resolve(ROOT, SOURCE_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }

  if (existsSync(base) && statSync(base).isFile()) return base;

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = join(base, `index${ext}`);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }

  return null;
}

function collectImports(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, getScriptKind(file));
  const imports = [];
  const fatRegistryLines = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (FAT_REGISTRY_IMPORTS.has(specifier) && node.importClause?.isTypeOnly !== true) {
        fatRegistryLines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
      imports.push(specifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { imports, fatRegistryLines };
}

const files = [];
const sourceRoot = resolve(ROOT, SOURCE_ROOT);
if (existsSync(sourceRoot) && statSync(sourceRoot).isDirectory()) {
  collectFiles(sourceRoot, files);
}

const moduleInfoByFile = new Map();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { imports, fatRegistryLines } = collectImports(file, source);
  moduleInfoByFile.set(file, {
    source,
    imports: imports
      .map((specifier) => resolveSourceImport(file, specifier))
      .filter((candidate) => candidate !== null),
    fatRegistryLines,
    isClientEntry: hasUseClientDirective(source),
  });
}

const errors = [];
for (const file of files) {
  const info = moduleInfoByFile.get(file);
  if (!info?.isClientEntry) continue;

  const queue = [{ file, chain: [file] }];
  const seen = new Set([file]);

  while (queue.length > 0) {
    const current = queue.shift();
    const currentInfo = current ? moduleInfoByFile.get(current.file) : null;
    if (!current || !currentInfo) continue;

    for (const line of currentInfo.fatRegistryLines) {
      const chain =
        current.chain.length > 1
          ? ` via ${current.chain.map((entry) => toRel(entry)).join(" -> ")}`
          : "";
      errors.push(
        `${toRel(current.file)}:${line}: client bundle imports the full stablecoin registry${chain}; use @shared/lib/stablecoins/client-registry or pass server-derived props`,
      );
    }

    for (const importedFile of currentInfo.imports) {
      if (seen.has(importedFile)) continue;
      seen.add(importedFile);
      queue.push({ file: importedFile, chain: [...current.chain, importedFile] });
    }
  }
}

if (errors.length > 0) {
  console.error("Client stablecoin registry import check failed:");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(`Client stablecoin registry import check passed for ${files.length} source files.`);
