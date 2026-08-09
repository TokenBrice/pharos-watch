#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { reportViolations } from "../lib/report-violations.mjs";
import { collectSourceFiles } from "../lib/source-files.mjs";
import { parseSourceFile } from "../lib/ts-ast.mjs";

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

function hasUseClientDirective(source) {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return /^["']use client["'];/.test(withoutBom.trimStart());
}

function toRel(absPath) {
  return relative(ROOT, absPath).replaceAll("\\", "/");
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

function collectImports(sourceFile) {
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

const sourceRoot = resolve(ROOT, SOURCE_ROOT);
const files =
  existsSync(sourceRoot) && statSync(sourceRoot).isDirectory()
    ? collectSourceFiles(sourceRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: SKIP_DIRS })
    : [];

const moduleInfoByFile = new Map();
for (const file of files) {
  const { source, sourceFile } = parseSourceFile(file);
  const { imports, fatRegistryLines } = collectImports(sourceFile);
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

process.exit(
  reportViolations({
    label: "Client stablecoin registry imports",
    heading: "Client stablecoin registry import check failed",
    violations: errors,
    scannedCount: files.length,
  }),
);
