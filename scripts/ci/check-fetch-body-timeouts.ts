#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { collectSourceFilesUnderRoots } from "../lib/source-files.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFAULT_ROOTS = ["worker/src/api", "worker/src/cron", "worker/src/lib"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);
// A finding needs the `fetchWithRetry` identifier (or a unicode escape that
// can spell it). Files without either token cannot read a tracked body.
const FETCH_WITH_RETRY_TOKEN = "fetchWithRetry";
const UNICODE_ESCAPE = /\\u(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\})/i;

interface FetchBodyTimeoutViolation {
  file: string;
  fetchLine: number;
  bodyLine: number;
  variable: string;
  method: string;
}

interface TrackedFetchAssignment {
  name: string;
  line: number;
}

function mayContainFetchWithRetry(source: string): boolean {
  return source.includes(FETCH_WITH_RETRY_TOKEN) || UNICODE_ESCAPE.test(source);
}

/** Bind the supplied source files in one program so the scan pays one checker
 * build instead of one per file. Script files keep their own checker because
 * their top-level declarations live in the global scope. */
function createSourceChecker(sourceFiles: readonly ts.SourceFile[]): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  const sourcesByName = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]));
  host.getSourceFile = (name) => sourcesByName.get(name);
  host.fileExists = (name) => sourcesByName.has(name);
  return ts.createProgram(sourceFiles.map((sourceFile) => sourceFile.fileName), options, host).getTypeChecker();
}

function collectFetchBodyTimeoutViolations(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  file: string,
): FetchBodyTimeoutViolation[] {
  const tracked = new Map<ts.Symbol, TrackedFetchAssignment>();
  const aliases = new Set<ts.Symbol>();
  const violations: FetchBodyTimeoutViolation[] = [];

  function isFetchCallee(node: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "fetchWithRetry";
    if (!ts.isIdentifier(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    return node.text === "fetchWithRetry" || (symbol !== undefined && aliases.has(symbol));
  }

  function assign(name: ts.Identifier, value: ts.Expression | undefined, declaration: ts.Node): void {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;
    const expression = value && (ts.isAwaitExpression(value) ? value.expression : value);
    const sourceSymbol = expression && ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
    const response = sourceSymbol && tracked.get(sourceSymbol);
    const fetchAlias = value && isFetchCallee(value);
    tracked.delete(symbol);
    aliases.delete(symbol);
    if (fetchAlias) aliases.add(symbol);
    if (response) {
      tracked.set(symbol, { ...response, name: name.text });
      return;
    }
    if (!expression || !ts.isCallExpression(expression) || !isFetchCallee(expression.expression)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
    tracked.set(symbol, { name: name.text, line });
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer);
      if (ts.isIdentifier(node.name)) {
        assign(node.name, node.initializer, node);
      } else if (ts.isArrayBindingPattern(node.name) && node.initializer) {
        const expression = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (ts.isCallExpression(expression)
          && ts.isPropertyAccessExpression(expression.expression)
          && expression.expression.expression.getText(sourceFile) === "Promise"
          && expression.expression.name.text === "all"
          && expression.arguments[0] && ts.isArrayLiteralExpression(expression.arguments[0])) {
          const items = expression.arguments[0].elements;
          node.name.elements.forEach((binding, index) => {
            if (ts.isBindingElement(binding) && ts.isIdentifier(binding.name) && !binding.dotDotDotToken) {
              assign(binding.name, items[index], node);
            }
          });
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          if (binding.propertyName?.getText(sourceFile) === "fetchWithRetry" && ts.isIdentifier(binding.name)) {
            const symbol = checker.getSymbolAtLocation(binding.name);
            if (symbol) aliases.add(symbol);
          }
        }
      }
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      visit(node.right);
      assign(node.left, node.right, node);
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && (node.expression.name.text === "json" || node.expression.name.text === "text")) {
      const symbol = checker.getSymbolAtLocation(node.expression.expression);
      const candidate = symbol && tracked.get(symbol);
      const bodyLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (candidate) {
        violations.push({
          file,
          fetchLine: candidate.line,
          bodyLine,
          variable: candidate.name,
          method: node.expression.name.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function findFetchBodyTimeoutViolations(
  source: string,
  file = "<source>",
): FetchBodyTimeoutViolation[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  return collectFetchBodyTimeoutViolations(sourceFile, createSourceChecker([sourceFile]), file);
}

export function scanFetchBodyTimeouts({
  cwd = process.cwd(),
  roots = DEFAULT_ROOTS,
}: {
  cwd?: string;
  roots?: readonly string[];
} = {}): FetchBodyTimeoutViolation[] {
  const violations: FetchBodyTimeoutViolation[] = [];
  const candidates: Array<{ file: string; sourceFile: ts.SourceFile }> = [];
  for (const file of collectSourceFilesUnderRoots(roots, cwd, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: EXCLUDED_DIRS,
  })) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    if (!mayContainFetchWithRetry(source)) continue;
    candidates.push({ file, sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) });
  }
  const moduleCandidates = candidates.filter((candidate) => ts.isExternalModule(candidate.sourceFile));
  const moduleChecker = moduleCandidates.length > 0
    ? createSourceChecker(moduleCandidates.map((candidate) => candidate.sourceFile))
    : undefined;
  const violationsByFile = new Map<string, FetchBodyTimeoutViolation[]>();
  for (const candidate of moduleCandidates) {
    violationsByFile.set(
      candidate.file,
      collectFetchBodyTimeoutViolations(candidate.sourceFile, moduleChecker!, candidate.file),
    );
  }
  for (const candidate of candidates.filter((entry) => !ts.isExternalModule(entry.sourceFile))) {
    violationsByFile.set(
      candidate.file,
      collectFetchBodyTimeoutViolations(
        candidate.sourceFile,
        createSourceChecker([candidate.sourceFile]),
        candidate.file,
      ),
    );
  }
  for (const candidate of candidates) {
    violations.push(...(violationsByFile.get(candidate.file) ?? []));
  }

  return violations;
}

export function main(): number {
  const violations = scanFetchBodyTimeouts();
  if (violations.length === 0) {
    console.log("Fetch body timeout check passed (no raw body reads after fetchWithRetry).");
    return 0;
  }

  console.error("fetchWithRetry raw body reads found. Use fetchJsonWithRetry/fetchTextWithRetry:");
  for (const violation of violations) {
    console.error(
      `  - ${violation.file}:${violation.bodyLine} ${violation.variable}.${violation.method}() after fetchWithRetry at line ${violation.fetchLine}`,
    );
  }
  return 1;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
});
