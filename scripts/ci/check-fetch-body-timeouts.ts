#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFiles, runAsCli } from "../lib/source-files.mts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFAULT_ROOTS = ["worker/src/api", "worker/src/cron", "worker/src/lib"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

const KNOWN_FETCH_BODY_TIMEOUT_DEBT = new Set<string>();

interface FetchBodyTimeoutViolation {
  file: string;
  fetchLine: number;
  bodyLine: number;
  variable: string;
  method: string;
  assignmentText: string;
  bodyReadText: string;
}

interface TrackedFetchAssignment {
  name: string;
  line: number;
  assignmentText: string;
}


interface FetchBodyTimeoutReport {
  violations: FetchBodyTimeoutViolation[];
  unexpected: FetchBodyTimeoutViolation[];
  staleDebt: string[];
}

function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectScanFiles(cwd: string, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const absoluteRoot = resolve(cwd, root);
    if (!existsSync(absoluteRoot)) continue;
    files.push(...collectSourceFiles(absoluteRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS }));
  }
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => normalizeRelPath(relative(cwd, file)))
    .sort();
}

export function makeViolationKey(violation: FetchBodyTimeoutViolation): string {
  return `${violation.file}::${violation.assignmentText}::${violation.bodyReadText}`;
}

export function findFetchBodyTimeoutViolations(
  source: string,
  file = "<source>",
): FetchBodyTimeoutViolation[] {
  const sourceFile = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === "scan.ts" ? sourceFile : undefined;
  const checker = ts.createProgram(["scan.ts"], options, host).getTypeChecker();
  const tracked = new Map<ts.Symbol, TrackedFetchAssignment>();
  const aliases = new Set<ts.Symbol>();
  const lines = source.split(/\r?\n/g);
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
    tracked.delete(symbol);
    aliases.delete(symbol);
    if (!value) return;
    if (isFetchCallee(value)) aliases.add(symbol);
    const expression = ts.isAwaitExpression(value) ? value.expression : value;
    if (!ts.isCallExpression(expression) || !isFetchCallee(expression.expression)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
    tracked.set(symbol, { name: name.text, line, assignmentText: lines[line - 1].trim() });
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
      if (candidate && bodyLine - candidate.line <= 80) {
        violations.push({
          file,
          fetchLine: candidate.line,
          bodyLine,
          variable: candidate.name,
          method: node.expression.name.text,
          assignmentText: candidate.assignmentText,
          bodyReadText: lines[bodyLine - 1].trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function scanFetchBodyTimeouts({
  cwd = process.cwd(),
  roots = DEFAULT_ROOTS,
  knownDebt = KNOWN_FETCH_BODY_TIMEOUT_DEBT,
}: {
  cwd?: string;
  roots?: readonly string[];
  knownDebt?: ReadonlySet<string>;
} = {}): FetchBodyTimeoutReport {
  const violations: FetchBodyTimeoutViolation[] = [];
  for (const file of collectScanFiles(cwd, roots)) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    violations.push(...findFetchBodyTimeoutViolations(source, file));
  }

  const seenKeys = new Set(violations.map(makeViolationKey));
  const unexpected = violations.filter((violation) => !knownDebt.has(makeViolationKey(violation)));
  const staleDebt = [...knownDebt].filter((key) => !seenKeys.has(key));
  return { violations, unexpected, staleDebt };
}

export function main(): number {
  const report = scanFetchBodyTimeouts();
  if (process.argv.includes("--print-baseline")) {
    for (const violation of report.violations) {
      console.log(JSON.stringify(makeViolationKey(violation)) + ",");
    }
    return 0;
  }

  if (report.unexpected.length === 0 && report.staleDebt.length === 0) {
    console.log(`Fetch body timeout check passed (${report.violations.length} known raw body-read debt item${report.violations.length === 1 ? "" : "s"} tracked).`);
    return 0;
  }

  if (report.unexpected.length > 0) {
    console.error("New fetchWithRetry raw body reads found. Use fetchJsonWithRetry/fetchTextWithRetry or add an intentional baseline entry:");
    for (const violation of report.unexpected) {
      console.error(
        `  - ${violation.file}:${violation.bodyLine} ${violation.variable}.${violation.method}() after fetchWithRetry at line ${violation.fetchLine}`,
      );
    }
  }
  if (report.staleDebt.length > 0) {
    console.error("Stale fetch body timeout debt baseline entries should be removed:");
    for (const key of report.staleDebt) {
      console.error(`  - ${key}`);
    }
  }
  return 1;
}

runAsCli(import.meta.url, main);
