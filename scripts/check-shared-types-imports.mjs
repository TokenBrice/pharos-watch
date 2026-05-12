#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_DIRS = new Set([".git", ".next", "coverage", "dist", "node_modules", "out"]);
const DEFAULT_ROOTS = ["functions", "shared", "src", "worker/src", "scripts"];

function collectFiles(rootDir) {
  const files = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          visit(join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(join(dir, entry.name));
      }
    }
  }

  visit(rootDir);
  return files;
}

export function findBroadSharedTypesValueImports(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const violations = [];
  for (const root of roots) {
    const rootDir = isAbsolute(root) ? root : join(cwd, root);
    for (const file of collectFiles(rootDir)) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        if (statement.moduleSpecifier.text !== "@shared/types") continue;
        if (statement.importClause?.isTypeOnly) continue;

        const namedBindings = statement.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

        const valueNames = namedBindings.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text);
        if (valueNames.length === 0) continue;

        const location = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        violations.push({
          file,
          line: location.line + 1,
          names: valueNames,
        });
      }
    }
  }
  return violations;
}

function runCli() {
  const violations = findBroadSharedTypesValueImports();
  if (violations.length === 0) {
    console.log("[shared-types-imports] no broad @shared/types value imports found");
    return;
  }

  console.error(
    "[shared-types-imports] import runtime values from @shared/types/<submodule>; reserve @shared/types for import type.",
  );
  for (const violation of violations) {
    console.error(
      `- ${relative(process.cwd(), violation.file)}:${violation.line} imports ${violation.names.join(", ")}`,
    );
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
