#!/usr/bin/env node

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { reportViolations } from "../lib/report-violations.mjs";
import { collectSourceFiles, resolveSourceRoot } from "../lib/source-files.mjs";
import { parseSourceFile } from "../lib/ts-ast.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_DIRS = new Set([".git", ".next", "coverage", "dist", "node_modules", "out"]);
const DEFAULT_ROOTS = ["functions", "shared", "src", "worker/src", "scripts"];
const SHARED_TYPES_ROOT = "shared/types";

interface BroadSharedTypesViolation {
  file: string;
  line: number;
  names: string[];
}

interface SharedTypesRuntimeViolation {
  file: string;
  line: number;
  source: string;
}

function isWithinPath(parentDir: string, candidatePath: string): boolean {
  const relativePath = relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function shouldSkipSharedTypesBoundaryFile(file: string, cwd: string): boolean {
  const pathParts = relative(cwd, file).split(sep);
  return pathParts.includes("__tests__") || file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

function getModuleSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const moduleSpecifier = statement.moduleSpecifier;
    return moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : null;
  }
  return null;
}

export function findBroadSharedTypesValueImports(
  roots: readonly string[] = DEFAULT_ROOTS,
  cwd = process.cwd(),
): BroadSharedTypesViolation[] {
  const violations: BroadSharedTypesViolation[] = [];
  for (const root of roots) {
    const rootDir = resolveSourceRoot(root, cwd);
    for (const file of collectSourceFiles(rootDir, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS })) {
      const { sourceFile } = parseSourceFile(file);

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

export function findSharedTypesRuntimeImports(
  roots: readonly string[] = [SHARED_TYPES_ROOT],
  cwd = process.cwd(),
): SharedTypesRuntimeViolation[] {
  const violations: SharedTypesRuntimeViolation[] = [];
  const sharedLibRoot = resolve(cwd, "shared/lib");
  for (const root of roots) {
    const rootDir = resolveSourceRoot(root, cwd);
    for (const file of collectSourceFiles(rootDir, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS })) {
      if (shouldSkipSharedTypesBoundaryFile(file, cwd)) continue;

      const { sourceFile } = parseSourceFile(file);

      for (const statement of sourceFile.statements) {
        const moduleSpecifier = getModuleSpecifier(statement);
        if (!moduleSpecifier) continue;

        const importsSharedLib = moduleSpecifier === "@shared/lib" || moduleSpecifier.startsWith("@shared/lib/");
        const resolvesIntoSharedLib = moduleSpecifier.startsWith(".")
          && isWithinPath(sharedLibRoot, resolve(dirname(file), moduleSpecifier));
        if (!importsSharedLib && !resolvesIntoSharedLib) continue;

        const location = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
        violations.push({
          file,
          line: location.line + 1,
          source: moduleSpecifier,
        });
      }
    }
  }
  return violations;
}

function runCli() {
  const broadTypeViolations = findBroadSharedTypesValueImports();
  const sharedTypesBoundaryViolations = findSharedTypesRuntimeImports();
  if (broadTypeViolations.length === 0 && sharedTypesBoundaryViolations.length === 0) {
    console.log("[shared-types-imports] no broad @shared/types value imports found");
    console.log("[shared-types-imports] no shared/types -> shared/lib imports found");
    return;
  }

  reportViolations({
    label: "[shared-types-imports] broad @shared/types value imports",
    heading:
      "[shared-types-imports] import runtime values from @shared/types/<submodule>; reserve @shared/types for import type",
    violations: broadTypeViolations.map(
      (violation) => `${relative(process.cwd(), violation.file)}:${violation.line} imports ${violation.names.join(", ")}`,
    ),
  });

  reportViolations({
    label: "[shared-types-imports] shared/types -> shared/lib imports",
    heading: "[shared-types-imports] shared/types modules must not import shared/lib modules",
    violations: sharedTypesBoundaryViolations.map(
      (violation) => `${relative(process.cwd(), violation.file)}:${violation.line} imports ${violation.source}`,
    ),
  });

  process.exit(1);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
