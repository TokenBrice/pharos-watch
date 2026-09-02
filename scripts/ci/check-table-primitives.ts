#!/usr/bin/env node

import { existsSync } from "node:fs";
import { isAbsolute, posix, relative, sep } from "node:path";
import ts from "typescript";
import { reportViolations } from "../lib/report-violations.mts";
import { collectSourceFiles, resolveSourceRoot, runAsCli } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const DEFAULT_ROOTS = ["src"];
const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  "__mocks__",
  "__tests__",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const UI_TABLE_MODULE = "@/components/ui/table";
const UI_TABLE_RELATIVE_MODULE = "src/components/ui/table";
const INVENTORY_PRIMITIVES = new Set([
  "ChartDataTable",
  "ContentTable",
  "DataTableShell",
  "TableFrame",
  "TableSurface",
  "table",
]);
const HINTED_PRIMITIVES = new Set([
  "DataTableShell",
  "TableFrame",
]);
const SWIPE_TEXT_RE = /\bswipe\b.*\b(table|columns?|horizontally|sideways)\b/i;

type TablePrimitiveViolationKind = "ui-table-import" | "raw-table-markup";
type MobileHintState = "none" | "disabled" | "active-custom" | "active-default";

interface TablePrimitiveViolation {
  file: string;
  line: number;
  kind: TablePrimitiveViolationKind;
  reason: string;
}

interface TablePrimitiveReport {
  scannedFiles: string[];
  violations: TablePrimitiveViolation[];
}

interface TableInventoryEntry {
  tableId: string;
  primitive: string;
  file: string;
  line: number;
  chrome: string;
  density: string;
  accessibleName: string;
  hasCaption: boolean;
  hasAriaLabel: boolean;
  mobileHint: MobileHintState;
  duplicateMobileSwipeHint: boolean;
}

interface TableCliOptions {
  inventory: boolean;
  json: boolean;
  help: boolean;
  roots: string[];
}

function normalizePathForReport(path: string, cwd: string): string {
  const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
  return relativePath.split(sep).join("/").replace(/^\.\//, "");
}

function isWithinRelativePath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isSharedTablePrimitivePath(path: string): boolean {
  return isWithinRelativePath(path, "src/components/table");
}

function isFixturePath(path: string): boolean {
  return path.startsWith("tests/fixtures/")
    || path.includes("/tests/fixtures/")
    || path.includes("/__tests__/fixtures/");
}

function isRawTableMarkupAllowed(path: string): boolean {
  return isSharedTablePrimitivePath(path)
    || path === "src/components/ui/table.tsx"
    || path === "src/components/chart-primitives/data-table.tsx"
    || isFixturePath(path);
}

function isUiTableImportAllowed(path: string): boolean {
  return isSharedTablePrimitivePath(path) || path === "src/components/ui/table.tsx";
}

function shouldSkipInventoryPath(path: string): boolean {
  return isSharedTablePrimitivePath(path)
    || path === "src/components/ui/table.tsx"
    || path === "src/components/chart-primitives/data-table.tsx"
    || path === "src/components/data-table-shell.tsx";
}

function collectExistingSourceFiles(
  roots: readonly string[],
  cwd: string,
  excludedDirs: ReadonlySet<string> = DEFAULT_EXCLUDED_DIRS,
): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const resolvedRoot = resolveSourceRoot(root, cwd);
    if (!existsSync(resolvedRoot)) continue;
    files.push(...collectSourceFiles(resolvedRoot, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs,
    }));
  }
  return files.sort((a, b) => normalizePathForReport(a, cwd).localeCompare(normalizePathForReport(b, cwd)));
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function getModuleSpecifier(statement: ts.Node): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const moduleSpecifier = statement.moduleSpecifier;
    return moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : null;
  }
  return null;
}

function stripSourceExtension(path: string): string {
  return path.replace(/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/, "");
}

function isUiTableModuleSpecifier(specifier: string, relativeFile: string): boolean {
  if (specifier === UI_TABLE_MODULE) return true;

  let resolvedSpecifier: string | null = null;
  if (specifier.startsWith("@/")) {
    resolvedSpecifier = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    resolvedSpecifier = posix.normalize(posix.join(posix.dirname(relativeFile), specifier));
  }

  return resolvedSpecifier != null
    && stripSourceExtension(resolvedSpecifier) === UI_TABLE_RELATIVE_MODULE;
}

function getJsxTagName(tagName: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tagName)) return tagName.text;
  return tagName.getText();
}

function visitNodes(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visitNodes(child, callback));
}

function isFalseKeyword(expression: ts.Expression | undefined): boolean {
  return expression?.kind === ts.SyntaxKind.FalseKeyword;
}

function isTrueKeyword(expression: ts.Expression | undefined): boolean {
  return expression?.kind === ts.SyntaxKind.TrueKeyword;
}

function getAttributeName(attribute: ts.JsxAttribute): string {
  return attribute.name.getText();
}

function getAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && getAttributeName(attribute) === name,
  );
}

function hasAttribute(node: ts.JsxOpeningLikeElement, name: string): boolean {
  return getAttribute(node, name) != null;
}

function formatExpressionValue(expression: ts.Expression | undefined, sourceFile: ts.SourceFile): string {
  if (!expression) return "{}";
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (isFalseKeyword(expression)) return "false";
  if (isTrueKeyword(expression)) return "true";
  if (ts.isIdentifier(expression)) return `{${expression.text}}`;
  return `{${expression.getText(sourceFile).replace(/\s+/g, " ").slice(0, 80)}}`;
}

function getAttributeValue(
  node: ts.JsxOpeningLikeElement,
  name: string,
  sourceFile: ts.SourceFile,
): string | null {
  const attribute = getAttribute(node, name);
  if (!attribute) return null;
  if (!attribute.initializer) return "true";
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (ts.isJsxExpression(attribute.initializer)) {
    return formatExpressionValue(attribute.initializer.expression, sourceFile);
  }
  return attribute.initializer.getText(sourceFile);
}

function getOpeningText(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ");
}

function hasTableCaption(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): boolean {
  if (hasAttribute(node, "caption")) return true;
  const parent = ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent) ? node.parent : node;
  const text = parent.getText(sourceFile);
  return /<\s*(TableCaption|caption)\b/.test(text);
}

function hasTableAriaLabel(
  node: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
  hasCaption = false,
): boolean {
  if (hasAttribute(node, "aria-label") || hasAttribute(node, "tableAriaLabel")) return true;
  if (!hasCaption && (hasAttribute(node, "tableId") || hasAttribute(node, "data-table-id"))) return true;
  const text = getOpeningText(node, sourceFile);
  return /["']aria-label["']\s*:/.test(text);
}

function getMobileHintState(
  primitive: string,
  node: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
): MobileHintState {
  if (primitive === "ContentTable") {
    const text = getOpeningText(node, sourceFile);
    if (/mobileScrollHint\s*:\s*(?!false\b)/.test(text)) return "active-custom";
    return "disabled";
  }

  if (!HINTED_PRIMITIVES.has(primitive)) return "none";

  const text = getOpeningText(node, sourceFile);
  if (/mobileScrollHint\s*=\s*\{\s*false\s*\}/.test(text)) return "disabled";
  if (/mobileScrollHint\s*:\s*false\b/.test(text)) return "disabled";
  if (/mobileScrollHint\s*=/.test(text) || /mobileScrollHint\s*:/.test(text)) return "active-custom";
  return "active-default";
}

function hasVisibleSwipeCopy(sourceFile: ts.SourceFile): boolean {
  let found = false;
  visitNodes(sourceFile, (node) => {
    if (found || !ts.isJsxText(node)) return;
    if (SWIPE_TEXT_RE.test(node.getText())) found = true;
  });
  return found;
}

function getDefaultChrome(primitive: string): string {
  if (primitive === "ContentTable") return "content";
  if (primitive === "ChartDataTable") return "chart";
  if (primitive === "table") return "raw";
  return "default";
}

function getDefaultDensity(primitive: string): string {
  if (primitive === "ContentTable") return "compact";
  if (primitive === "ChartDataTable" || primitive === "table") return "n/a";
  return "comfortable";
}

function getAccessibilitySummary(hasCaption: boolean, hasAriaLabel: boolean): string {
  if (hasCaption && hasAriaLabel) return "caption+aria-label";
  if (hasCaption) return "caption";
  if (hasAriaLabel) return "aria-label";
  return "missing";
}

function findPrimitiveViolationsInFile(file: string, cwd: string): TablePrimitiveViolation[] {
  const { sourceFile } = parseSourceFile(file);
  const relativeFile = normalizePathForReport(file, cwd);
  const violations: TablePrimitiveViolation[] = [];

  visitNodes(sourceFile, (node) => {
    const moduleSpecifier = getModuleSpecifier(node);
    if (moduleSpecifier && isUiTableModuleSpecifier(moduleSpecifier, relativeFile) && !isUiTableImportAllowed(relativeFile)) {
      violations.push({
        file: relativeFile,
        line: getLine(sourceFile, node),
        kind: "ui-table-import",
        reason: "Import table primitives from @/components/table instead of @/components/ui/table.",
      });
      return;
    }

    if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
      && isUiTableModuleSpecifier(node.arguments[0].text, relativeFile)
      && !isUiTableImportAllowed(relativeFile)
    ) {
      violations.push({
        file: relativeFile,
        line: getLine(sourceFile, node),
        kind: "ui-table-import",
        reason: "Import table primitives from @/components/table instead of @/components/ui/table.",
      });
      return;
    }

    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && getJsxTagName(node.tagName) === "table"
      && !isRawTableMarkupAllowed(relativeFile)
    ) {
      violations.push({
        file: relativeFile,
        line: getLine(sourceFile, node),
        kind: "raw-table-markup",
        reason: "Use the shared table primitives instead of raw <table> markup.",
      });
    }
  });

  return violations;
}

export function scanTablePrimitives({
  roots = DEFAULT_ROOTS,
  cwd = process.cwd(),
  excludedDirs = DEFAULT_EXCLUDED_DIRS,
}: {
  roots?: readonly string[];
  cwd?: string;
  excludedDirs?: ReadonlySet<string>;
} = {}): TablePrimitiveReport {
  const scannedFiles = collectExistingSourceFiles(roots, cwd, excludedDirs);
  const violations = scannedFiles.flatMap((file) => findPrimitiveViolationsInFile(file, cwd));
  return { scannedFiles, violations };
}

function collectInventoryEntriesInFile(file: string, cwd: string): TableInventoryEntry[] {
  const { sourceFile } = parseSourceFile(file);
  const relativeFile = normalizePathForReport(file, cwd);
  if (shouldSkipInventoryPath(relativeFile)) return [];

  const visibleSwipeCopy = hasVisibleSwipeCopy(sourceFile);
  const entries: TableInventoryEntry[] = [];
  visitNodes(sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;

    const primitive = getJsxTagName(node.tagName);
    if (!INVENTORY_PRIMITIVES.has(primitive)) return;

    const hasCaption = hasTableCaption(node, sourceFile);
    const hasAriaLabel = hasTableAriaLabel(node, sourceFile, hasCaption);
    const mobileHint = getMobileHintState(primitive, node, sourceFile);
    entries.push({
      tableId: getAttributeValue(node, "tableId", sourceFile)
        ?? getAttributeValue(node, "data-table-id", sourceFile)
        ?? "(none)",
      primitive,
      file: relativeFile,
      line: getLine(sourceFile, node),
      chrome: getAttributeValue(node, "chrome", sourceFile) ?? getDefaultChrome(primitive),
      density: getAttributeValue(node, "density", sourceFile) ?? getDefaultDensity(primitive),
      accessibleName: getAccessibilitySummary(hasCaption, hasAriaLabel),
      hasCaption,
      hasAriaLabel,
      mobileHint,
      duplicateMobileSwipeHint: visibleSwipeCopy && mobileHint.startsWith("active-"),
    });
  });

  return entries;
}

export function collectTableInventory({
  roots = DEFAULT_ROOTS,
  cwd = process.cwd(),
  excludedDirs = DEFAULT_EXCLUDED_DIRS,
}: {
  roots?: readonly string[];
  cwd?: string;
  excludedDirs?: ReadonlySet<string>;
} = {}): TableInventoryEntry[] {
  return collectExistingSourceFiles(roots, cwd, excludedDirs)
    .flatMap((file) => collectInventoryEntriesInFile(file, cwd))
    .sort((a, b) => {
      const fileOrder = a.file.localeCompare(b.file);
      return fileOrder === 0 ? a.line - b.line : fileOrder;
    });
}

export function printTablePrimitiveReport(report: TablePrimitiveReport): 0 | 1 {
  return reportViolations({
    label: "Table primitive adoption",
    violations: report.violations.map(
      (violation) => `${violation.file}:${violation.line} [${violation.kind}] ${violation.reason}`,
    ),
    hint: "Use src/components/table/ for visible product tables.",
    scannedCount: report.scannedFiles.length,
  });
}

export function printTableInventory(
  entries: readonly TableInventoryEntry[],
  { json = false }: { json?: boolean } = {},
): 0 {
  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`Table inventory (${entries.length} table surface${entries.length === 1 ? "" : "s"})\n`);
  for (const entry of entries) {
    process.stdout.write(
      [
        `${entry.file}:${entry.line}`,
        `id=${entry.tableId}`,
        `kind=${entry.primitive}`,
        `chrome=${entry.chrome}`,
        `density=${entry.density}`,
        `name=${entry.accessibleName}`,
        `mobileHint=${entry.mobileHint}`,
        `duplicateSwipeHint=${entry.duplicateMobileSwipeHint ? "yes" : "no"}`,
      ].join(" | ") + "\n",
    );
  }
  return 0;
}

function printHelp(): void {
  process.stdout.write(`Usage: node --import tsx scripts/ci/check-table-primitives.ts [--inventory] [--json] [roots...]

Default mode rejects direct @/components/ui/table imports and raw <table> markup
outside the shared table, shadcn implementation, chart data-table, and fixture
allowlists. Inventory mode prints table primitive call sites without writing an
artifact.
`);
}

function parseArgs(argv: readonly string[]): TableCliOptions {
  const roots: string[] = [];
  const options = { inventory: false, json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--inventory") {
      options.inventory = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      index += 1;
      if (argv[index]) roots.push(argv[index]);
    } else {
      roots.push(arg);
    }
  }

  return {
    ...options,
    roots: roots.length > 0 ? roots : DEFAULT_ROOTS,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd()): 0 | 1 {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.inventory) {
    return printTableInventory(collectTableInventory({ roots: options.roots, cwd }), { json: options.json });
  }

  return printTablePrimitiveReport(scanTablePrimitives({ roots: options.roots, cwd }));
}

runAsCli(import.meta.url, main);
