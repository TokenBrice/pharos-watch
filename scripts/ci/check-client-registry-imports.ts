#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { reportViolations } from "../lib/report-violations.mts";
import { collectSourceFiles } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();
const SOURCE_ROOT = "src";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "coverage"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const FAT_REGISTRY_IMPORTS = new Set([
  "@shared/lib/stablecoins",
  "@shared/lib/stablecoins/index",
  "@shared/lib/stablecoins/registry",
  "@shared/data/stablecoins/coins.generated.json",
  "@shared/data/stablecoins/coins.client.generated.json",
]);
const DETAIL_PROJECTION_PREFIX = "@shared/data/stablecoins/coins.client.detail/";

// Scheduled for deletion after the metafile reachability checker completes one parallel-green CI cycle.

interface ClientModuleInfo {
  source: string;
  imports: string[];
  fatRegistryLines: number[];
  detailProjectionLines: number[];
  isClientEntry: boolean;
}
function hasUseClientDirective(source: string): boolean {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return /^["']use client["'];/.test(withoutBom.trimStart());
}

function toRel(absPath: string, root = ROOT): string {
  return relative(root, absPath).replaceAll("\\", "/");
}

function resolveSourceImport(root: string, fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = resolve(root, SOURCE_ROOT, specifier.slice(2));
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

function isDetailProjectionSpecifier(specifier: string): boolean {
  return specifier.startsWith(DETAIL_PROJECTION_PREFIX) || specifier.includes("/coins.client.detail/");
}

function collectImports(sourceFile: ts.SourceFile) {
  const imports: string[] = [];
  const fatRegistryLines: number[] = [];
  const detailProjectionLines: number[] = [];

  function recordSpecifier(specifier: string, node: ts.Node, isTypeOnly = false): void {
    if (!isTypeOnly && FAT_REGISTRY_IMPORTS.has(specifier)) {
      fatRegistryLines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    if (!isTypeOnly && isDetailProjectionSpecifier(specifier)) {
      detailProjectionLines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    imports.push(specifier);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier.text, node, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier.text, node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      recordSpecifier(node.arguments[0].text, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { imports, fatRegistryLines, detailProjectionLines };
}

export function findClientRegistryImportViolations(root = ROOT): { violations: string[]; scannedCount: number } {
  const sourceRoot = resolve(root, SOURCE_ROOT);
  const files =
    existsSync(sourceRoot) && statSync(sourceRoot).isDirectory()
      ? collectSourceFiles(sourceRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: SKIP_DIRS })
      : [];

  const moduleInfoByFile = new Map<string, ClientModuleInfo>();
  for (const file of files) {
    const { source, sourceFile } = parseSourceFile(file);
    const { imports, fatRegistryLines, detailProjectionLines } = collectImports(sourceFile);
    moduleInfoByFile.set(file, {
      source,
      imports: imports
        .map((specifier) => resolveSourceImport(root, file, specifier))
        .filter((candidate) => candidate !== null),
      fatRegistryLines,
      detailProjectionLines,
      isClientEntry: hasUseClientDirective(source),
    });
  }

  const errors: string[] = [];
  for (const file of files) {
    const info = moduleInfoByFile.get(file);
    if (!info?.isClientEntry) continue;

    const queue: { file: string; chain: string[] }[] = [{ file, chain: [file] }];
    const seen = new Set<string>([file]);

    while (queue.length > 0) {
      const current = queue.shift();
      const currentInfo = current ? moduleInfoByFile.get(current.file) : null;
      if (!current || !currentInfo) continue;

      for (const line of currentInfo.fatRegistryLines) {
        const chain =
          current.chain.length > 1
            ? ` via ${current.chain.map((entry) => toRel(entry, root)).join(" -> ")}`
            : "";
        errors.push(
          `${toRel(current.file, root)}:${line}: client bundle imports the full stablecoin registry${chain}; use @shared/lib/stablecoins/client-registry or pass server-derived props`,
        );
      }
      for (const line of currentInfo.detailProjectionLines) {
        const chain =
          current.chain.length > 1
            ? ` via ${current.chain.map((entry) => toRel(entry, root)).join(" -> ")}`
            : "";
        errors.push(
          `${toRel(current.file, root)}:${line}: client bundle imports a stablecoin detail projection directly${chain}; use loadClientStablecoinDetail(id)`,
        );
      }

      for (const importedFile of currentInfo.imports) {
        if (seen.has(importedFile)) continue;
        seen.add(importedFile);
        queue.push({ file: importedFile, chain: [...current.chain, importedFile] });
      }
    }
  }

  return { violations: errors, scannedCount: files.length };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const { violations, scannedCount } = findClientRegistryImportViolations();
  process.exit(
    reportViolations({
      label: "Client stablecoin registry imports",
      heading: "Client stablecoin registry import check failed",
      violations,
      scannedCount,
    }),
  );
}
