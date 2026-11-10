import ts from "typescript";
import { parse } from "postcss";
import { getScriptKind } from "../../../scripts/lib/ts-ast.mts";

export type ComponentStyleViolation = "max-breakpoint" | "serif" | "interactive-row";

export function isComponentSourceFile(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) &&
    !/(^|\/)(__tests__|__fixtures__|test-utils)(\/|$)|\.(test|spec|test-support)\.tsx?$/.test(path);
}

const COMPILER_OPTIONS: ts.CompilerOptions = { noLib: true, noResolve: true };

function unparenthesized(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unparenthesized(node.expression) : node;
}

function isRovingTabIndex(value: ts.Node | undefined): boolean {
  if (!value || !ts.isExpression(value)) return false;
  const node = unparenthesized(value);
  if (!ts.isConditionalExpression(node)) return false;
  const condition = unparenthesized(node.condition), yes = unparenthesized(node.whenTrue), no = unparenthesized(node.whenFalse);
  return ts.isIdentifier(condition) && condition.text === "isCursor" &&
    ts.isNumericLiteral(yes) && yes.text === "0" && ts.isIdentifier(no) && no.text === "undefined";
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
    if (/^src\/.*\.tsx$/.test(sourceFile.fileName) &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      /^(tr|TableRow|InteractiveTableRow)$/.test(node.tagName.getText(sourceFile))) {
      function inspectProp(name: string, value?: ts.Node, roving = false, rowRole = false) {
        if ((name === "tabIndex" && !roving) || name === "onKeyDown" ||
          (name === "role" && !rowRole && (!value || !ts.isStringLiteralLike(value) || value.text !== "row"))) {
          violations.add("interactive-row");
        }
      }
      for (const attr of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) {
          for (const prop of checker.getTypeAtLocation(attr.expression).getProperties()) {
            const declaration = prop.valueDeclaration;
            const value = declaration && ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
            const type = checker.getTypeOfSymbolAtLocation(prop, attr.expression);
            inspectProp(prop.name, value, false, type.isStringLiteral() && type.value === "row");
          }
        }
        if (!ts.isJsxAttribute(attr)) continue;
        const value = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
        // Only the directory's active virtual cursor gets a roving row tab stop.
        const roving = sourceFile.fileName === "src/components/stablecoin-table-row.tsx" &&
          node.tagName.getText(sourceFile) === "TableRow" && isRovingTabIndex(value);
        inspectProp(attr.name.getText(sourceFile), value, roving);
      }
    }
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

export function inspectComponentStyles(path: string, source: string): ComponentStyleViolation[] {
  return inspectComponentTree([{ path, source }]).get(path) ?? [];
}

/** Parse and bind the source tree once. */
export function inspectComponentTree(
  files: ReadonlyArray<{ path: string; source: string }>,
): Map<string, ComponentStyleViolation[]> {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const { path, source } of files) {
    if (isComponentSourceFile(path)) sourceFiles.set(path,
      ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, getScriptKind(path)));
  }
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  host.getSourceFile = (name) => sourceFiles.get(name);
  host.fileExists = (name) => sourceFiles.has(name);
  host.readFile = (name) => sourceFiles.get(name)?.text;
  const checker = ts.createProgram([...sourceFiles.keys()], COMPILER_OPTIONS, host).getTypeChecker();
  return new Map([...sourceFiles].map(([path, sourceFile]) => [path, inspectSourceFile(sourceFile, checker)]));
}

export function tokenColors(sources: string[], dark: boolean) {
  const base: Record<string, string> = {}, overrides: Record<string, string> = {};
  for (const source of sources) {
    for (const node of parse(source).nodes) {
      if ((node.type === "rule" && [":root", ".dark"].includes(node.selector)) ||
        (node.type === "atrule" && node.name === "theme")) {
        const target = node.type === "rule" && node.selector === ".dark" ? overrides : base;
        node.walkDecls((decl) => { target[decl.prop] = decl.value; });
      }
    }
  }
  const vars = { ...base, ...(dark ? overrides : {}) };
  return function resolve(name: string, seen = new Set<string>()): number[] {
    if (seen.has(name)) throw new Error(`Cyclic color: ${name}`);
    seen.add(name);
    const value = vars[name] ?? name;
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (alias) return resolve(alias[1], seen);
    const match = /^oklch\((\d*\.?\d+)(%?) (\d*\.?\d+) (\d*\.?\d+)\)$/.exec(value);
    if (!match) throw new Error(`Unresolved color: ${value}`);
    const l = +match[1] / (match[2] ? 100 : 1), c = +match[3], h = +match[4] * Math.PI / 180;
    const a = c * Math.cos(h), b = c * Math.sin(h);
    const x = (l + .3963377774 * a + .2158037573 * b) ** 3;
    const y = (l - .1055613458 * a - .0638541728 * b) ** 3;
    const z = (l - .0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * x - 3.3077115913 * y + .2309699292 * z,
      -1.2684380046 * x + 2.6097574011 * y - .3413193965 * z,
      -.0041960863 * x - .7034186147 * y + 1.707614701 * z].map((v) =>
      Math.max(0, Math.min(1, v <= .0031308 ? 12.92 * v : 1.055 * v ** (1/2.4) - .055)));
  };
}

export function contrast(fg: number[], bg: number[], opacity = 1): number {
  const luminance = (rgb: number[]) => rgb.reduce((sum, v, i) =>
    sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v+.055)/1.055)**2.4), 0);
  const a = luminance(fg.map((v, i) => v * opacity + bg[i] * (1-opacity))), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
