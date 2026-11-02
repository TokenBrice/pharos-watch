import ts from "typescript";
import { getScriptKind } from "../../../scripts/lib/ts-ast.mts";

export type ComponentStyleViolation = "max-breakpoint" | "serif";

export function isComponentSourceFile(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) &&
    !/(^|\/)(__tests__|__fixtures__|test-utils)(\/|$)|\.(test|spec|test-support)\.tsx?$/.test(path);
}

const COMPILER_OPTIONS: ts.CompilerOptions = { noLib: true, noResolve: true };

function parseSource(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, getScriptKind(path));
}

/** One Program (and checker) shared by every file in the tree scan. */
function createTreeProgram(sourceFiles: ReadonlyMap<string, ts.SourceFile>): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  host.getSourceFile = (name) => sourceFiles.get(name);
  host.fileExists = (name) => sourceFiles.has(name);
  host.readFile = (name) => sourceFiles.get(name)?.text;
  return ts.createProgram([...sourceFiles.keys()], COMPILER_OPTIONS, host);
}

function inspectSourceFile(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ComponentStyleViolation[] {
  const violations = new Set<ComponentStyleViolation>();
  const classBuilders = new Set(["cn", "clsx", "cva", "twMerge"]);
  const fontBuilders = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    if (!clause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (moduleName === "next/font/local" && clause.name) fontBuilders.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        if (specifier.isTypeOnly) continue;
        const imported = (specifier.propertyName ?? specifier.name).text;
        if (classBuilders.has(imported)) classBuilders.add(specifier.name.text);
        if (imported === "Newsreader" || (moduleName === "@/lib/fonts/digest" && imported === "digestDisplay")) {
          violations.add("serif");
        }
      }
    }
  }

  function inspectExpression(node: ts.Node, font = false, seen = new Set<ts.Node>()): void {
    if (seen.has(node) || ts.isTypeNode(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!font && /\bmax-(?:sm|md|lg|xl|2xl):/.test(node.text)) violations.add("max-breakpoint");
      if (/\bfont-serif\b|\bNewsreader\b/.test(node.text)) violations.add("serif");
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        inspectExpression(declaration.initializer, font, seen);
      }
    }
    ts.forEachChild(node, (child) => inspectExpression(child, font, seen));
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && /className$/i.test(node.name.getText(sourceFile)) && node.initializer) {
      inspectExpression(node.initializer);
    }
    if (ts.isPropertyAssignment(node) && /className$/i.test(node.name.getText(sourceFile).replace(/["']/g, ""))) {
      inspectExpression(node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (classBuilders.has(node.expression.text)) {
        for (const argument of node.arguments) inspectExpression(argument);
      } else if (fontBuilders.has(node.expression.text)) {
        for (const argument of node.arguments) inspectExpression(argument, true);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...violations].sort();
}

/** Inspect executable styling expressions, never comments or unrelated display text. */
export function inspectComponentStyles(path: string, source: string): ComponentStyleViolation[] {
  if (!isComponentSourceFile(path)) return [];
  const sourceFile = parseSource(path, source);
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  host.getSourceFile = (name) => name === path ? sourceFile : undefined;
  const checker = ts.createProgram([path], COMPILER_OPTIONS, host).getTypeChecker();
  return inspectSourceFile(sourceFile, checker);
}

/**
 * Whole-tree variant of `inspectComponentStyles`: every source is parsed and
 * bound once by a single Program instead of one Program per file.
 */
export function inspectComponentTree(
  files: ReadonlyArray<{ path: string; source: string }>,
): Map<string, ComponentStyleViolation[]> {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const { path, source } of files) {
    if (isComponentSourceFile(path)) sourceFiles.set(path, parseSource(path, source));
  }
  const checker = createTreeProgram(sourceFiles).getTypeChecker();
  return new Map([...sourceFiles].map(([path, sourceFile]) => [path, inspectSourceFile(sourceFile, checker)]));
}
