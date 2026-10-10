import ts from "typescript";
import { getScriptKind } from "../../../scripts/lib/ts-ast.mts";

export function isComponentSourceFile(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) &&
    !/(^|\/)(__tests__|__fixtures__|test-utils)(\/|$)|\.(test|spec|test-support)\.tsx?$/.test(path);
}

/** Inspect executable styling expressions, never comments or unrelated display text. */
export function inspectComponentStyles(path: string, source: string): Array<"max-breakpoint" | "serif"> {
  if (!isComponentSourceFile(path)) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, getScriptKind(path));
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === path ? sourceFile : undefined;
  const checker = ts.createProgram([path], options, host).getTypeChecker();
  const violations = new Set<"max-breakpoint" | "serif">();
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
