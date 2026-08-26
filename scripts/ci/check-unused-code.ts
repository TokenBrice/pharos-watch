#!/usr/bin/env node

import { statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFilesUnderRoot } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";
import {
  DEBT_EXPORTS,
  DEBT_MODULES,
  SCANNER_BLIND_SPOT_EXPORTS,
  SCANNER_BLIND_SPOT_MODULES,
} from "../lib/unused-code-allowlist.mts";

type DependencyKind = "default" | "named" | "namespace" | "side-effect" | "re-export-named" | "re-export-all";
type AllowlistSection = "SCANNER_BLIND_SPOTS" | "DEBT";

interface Dependency {
  resolved: string;
  kind: DependencyKind;
  names: string[];
  reExports?: Array<{ imported: string; exported: string }>;
}

interface ModuleInfo {
  exports: Set<string>;
  typeExports: Set<string>;
  localTypeUsage: Set<string>;
  declaredExports: Set<string>;
  declaredTypeExports: Set<string>;
  dependencies: Dependency[];
  hasWildcardExports: boolean;
  hasSideEffectsOnly: boolean;
}

interface AllowlistMeta {
  section: AllowlistSection;
  reason: string;
}

interface DeadModule {
  file: string;
  reason: string;
}

interface UnusedExport {
  file: string;
  name: string;
}

interface StaleAllowlistEntry {
  entry: string;
  reason: string;
}

const ROOT = process.cwd();
const AUDIT_ALLOWLIST = !process.argv.includes("--skip-allowlist-audit");
// Consumer surfaces that are walked for imports. `scripts/` and `worker/scripts/`
// are scanned but never reported on: they are legitimate consumers of shared and
// worker modules (build-data generators, maintenance CLIs, CI checks), and before
// they were walked every script-side consumer showed up as a false "unused export".
const SOURCE_DIRS = ["src", "shared", "worker/src", "functions", "scripts", "worker/scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const REPORTABLE_DIR_PREFIXES = ["src/", "shared/", "worker/src/", "functions/"];
const UNUSED_EXPORT_DIR_PREFIXES = ["src/", "shared/", "worker/src/", "functions/"];
const VITEST_CONFIG = "vitest.config.ts";
const VENDORED_UI_PREFIX = "src/components/ui/";
const VENDORED_UI_EXEMPTION_REASON =
  "vendored shadcn primitives retain their upstream export surface and are not unused-code debt";

const ROOT_ENTRYPOINT_PATTERNS = [
  /^src\/app\//,
  /^functions\//,
  /^worker\/src\/index\.ts$/,
  /^worker\/src\/handlers\/scheduled\.ts$/,
];

// Both allowlists keep their section so the audit can name it in failures.
const withSection = (
  entries: Record<string, string>,
  section: AllowlistSection,
): Array<[string, AllowlistMeta]> =>
  Object.entries(entries).map(([entry, reason]) => [entry, { section, reason }]);

const MODULE_ALLOWLIST = new Map([
  ...withSection(SCANNER_BLIND_SPOT_MODULES as Record<string, string>, "SCANNER_BLIND_SPOTS"),
  ...withSection(DEBT_MODULES as Record<string, string>, "DEBT"),
]);
const EXPORT_ALLOWLIST = new Map([
  ...withSection(SCANNER_BLIND_SPOT_EXPORTS as Record<string, string>, "SCANNER_BLIND_SPOTS"),
  ...withSection(DEBT_EXPORTS as Record<string, string>, "DEBT"),
]);

const VITEST_ALIASES = loadVitestAliases();

const files = collectSourceFiles();
const fileSet = new Set(files);
const moduleInfo = new Map(files.map((file) => [file, analyzeModule(file)]));

const runtimeInbound = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
const namedExportUsage = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
const ambiguousUsage = new Set<string>();

for (const [file, info] of moduleInfo.entries()) {
  for (const dependency of info.dependencies) {
    if (!runtimeInbound.has(dependency.resolved)) continue;
    runtimeInbound.get(dependency.resolved)?.add(file);
    if (dependency.kind === "re-export-named" || dependency.kind === "re-export-all") continue;
    if (dependency.kind !== "named") {
      ambiguousUsage.add(dependency.resolved);
      continue;
    }
    const usedNames = namedExportUsage.get(dependency.resolved);
    if (!usedNames) continue;
    for (const name of dependency.names) {
      usedNames.add(name);
    }
  }
}

// Re-exports are routing edges, not genuine uses. Propagate actual consumer use
// through barrels so the defining module gets credit only when something imports
// the re-exported name. This also keeps `export *` from masking unused exports.
let usageChanged = true;
while (usageChanged) {
  usageChanged = false;
  for (const [file, info] of moduleInfo.entries()) {
    const usedNames = namedExportUsage.get(file) ?? new Set<string>();
    for (const dependency of info.dependencies) {
      if (dependency.kind !== "re-export-named" && dependency.kind !== "re-export-all") continue;
      const targetUsage = namedExportUsage.get(dependency.resolved);
      if (!targetUsage) continue;

      if (ambiguousUsage.has(file) && !ambiguousUsage.has(dependency.resolved)) {
        ambiguousUsage.add(dependency.resolved);
        usageChanged = true;
      }

      const propagatedNames =
        dependency.kind === "re-export-all"
          ? usedNames
          : (dependency.reExports ?? [])
              .filter(({ exported }) => usedNames.has(exported))
              .map(({ imported }) => imported);
      for (const name of propagatedNames) {
        if (targetUsage.has(name)) continue;
        targetUsage.add(name);
        usageChanged = true;
      }
    }
  }
}

const deadModules: DeadModule[] = [];
const unusedExports: UnusedExport[] = [];
const unusedModuleKeys = new Set<string>();
const unusedExportKeys = new Set<string>();

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const info = moduleInfo.get(file);
  if (!info) throw new Error(`Missing module analysis for ${file}`);
  if (!isReportableModule(rel) || isTestFile(rel) || isRootEntrypoint(rel) || isVendoredUiPrimitive(rel)) continue;

  if ((runtimeInbound.get(file)?.size ?? 0) === 0) {
    unusedModuleKeys.add(rel);
    if (!MODULE_ALLOWLIST.has(rel)) {
      deadModules.push({
        file: rel,
        reason:
          info.exports.size === 0 && info.hasSideEffectsOnly
            ? "unreferenced module"
            : "unreferenced module or dead shim",
      });
    }
    // Either way the module verdict covers the whole file: reporting each of its
    // exports again would just duplicate the same finding.
    continue;
  }

  if (!isUnusedExportReportable(rel) || ambiguousUsage.has(file) || info.hasWildcardExports) continue;

  const usedNames = namedExportUsage.get(file) ?? new Set();
  for (const name of new Set([...info.exports, ...info.typeExports])) {
    const exportKey = `${rel}::${name}`;
    if (usedNames.has(name) || info.localTypeUsage.has(name)) continue;
    unusedExportKeys.add(exportKey);
    if (EXPORT_ALLOWLIST.has(exportKey)) continue;
    unusedExports.push({ file: rel, name });
  }
}

if (deadModules.length > 0) {
  console.error("Dead internal modules:");
  for (const moduleEntry of deadModules) {
    console.error(`  ${moduleEntry.file} (${moduleEntry.reason})`);
  }
}

if (unusedExports.length > 0) {
  console.error("Unused named exports:");
  for (const item of unusedExports) {
    console.error(`  ${item.file} :: ${item.name}`);
  }
}

if (AUDIT_ALLOWLIST) {
  const stale: StaleAllowlistEntry[] = [];
  for (const [entry, meta] of EXPORT_ALLOWLIST) {
    const [file = "", symbol = ""] = entry.split("::");
    if (!meta.reason) {
      stale.push({ entry, reason: `missing one-line reason in ${meta.section}` });
      continue;
    }
    try {
      statSync(file);
    } catch {
      stale.push({ entry, reason: "file does not exist" });
      continue;
    }
    const absoluteFile = resolve(ROOT, file);
    const info = moduleInfo.get(absoluteFile) ?? analyzeModule(absoluteFile);
    const definition = findExportDefinition(absoluteFile, symbol);
    if (!definition && !info.exports.has(symbol) && !info.typeExports.has(symbol)) {
      stale.push({ entry, reason: "symbol no longer exported from file" });
      continue;
    }
    if (definition && definition !== absoluteFile) {
      stale.push({
        entry,
        reason: `symbol is re-exported; declare the allowlist entry on ${relative(ROOT, definition).replaceAll("\\", "/")}`,
      });
      continue;
    }
    if (!unusedExportKeys.has(entry)) {
      stale.push({
        entry,
        reason: isVendoredUiPrimitive(file)
          ? `covered by structural exemption (${VENDORED_UI_EXEMPTION_REASON}); delete this allowlist entry`
          : "no longer reported as unused; delete this allowlist entry",
      });
    }
  }
  for (const [mod, meta] of MODULE_ALLOWLIST) {
    if (!meta.reason) {
      stale.push({ entry: mod, reason: `missing one-line reason in ${meta.section}` });
      continue;
    }
    try {
      statSync(mod);
    } catch {
      stale.push({ entry: mod, reason: "module does not exist" });
      continue;
    }
    if (!unusedModuleKeys.has(mod)) {
      stale.push({
        entry: mod,
        reason: isVendoredUiPrimitive(mod)
          ? `covered by structural exemption (${VENDORED_UI_EXEMPTION_REASON}); delete this allowlist entry`
          : "no longer reported as unused; delete this allowlist entry",
      });
    }
  }
  if (stale.length > 0) {
    process.stderr.write("\nStale allowlist entries:\n");
    for (const s of stale) {
      process.stderr.write(`  ${s.entry} — ${s.reason}\n`);
    }
    process.stderr.write(`\n${stale.length} stale entry/entries.\n`);
    process.exit(1);
  }
  const debtCount = Object.keys(DEBT_MODULES).length + Object.keys(DEBT_EXPORTS).length;
  const blindSpotCount = Object.keys(SCANNER_BLIND_SPOT_MODULES).length + Object.keys(SCANNER_BLIND_SPOT_EXPORTS).length;
  process.stdout.write(
    `Allowlist audit: all entries valid (${blindSpotCount} SCANNER_BLIND_SPOTS, ${debtCount} DEBT).\n`,
  );
}

if (deadModules.length === 0 && unusedExports.length === 0) {
  console.log("No dead internal modules or unused named exports found.");
  process.exit(0);
}

process.exit(1);

function collectSourceFiles(): string[] {
  const excludedDirs = new Set(["node_modules", ".next", "out"]);
  const results = SOURCE_DIRS.flatMap((dir) =>
    collectSourceFilesUnderRoot(dir, ROOT, { extensions: SOURCE_EXTENSIONS, excludedDirs }).filter(
      (f) => !f.endsWith(".d.ts"),
    ),
  );
  return results.sort();
}

function analyzeModule(file: string): ModuleInfo {
  const { sourceFile } = parseSourceFile(file) as { sourceFile: ts.SourceFile };

  const exports = new Set<string>();
  // Fully type-only export declarations (`export type { X }` / `export type { X } from`)
  // are intentionally excluded from `exports` (they are never runtime-dead), but the
  // allowlist audit still needs to know they exist so it doesn't false-flag a valid
  // type-only allowlist entry as a stale symbol.
  const typeExports = new Set<string>();
  const declaredExports = new Set<string>();
  const declaredTypeExports = new Set<string>();
  const localTypeUsage = new Set<string>();
  const dependencies: Dependency[] = [];
  let hasWildcardExports = false;
  let hasSideEffectsOnly = true;

  for (const node of sourceFile.statements) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      hasExportModifier(node) ||
      ts.isExportAssignment(node)
    ) {
      hasSideEffectsOnly = false;
    }
  }

  visit(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveModule(file, node.moduleSpecifier.text);
      if (resolved) {
        dependencies.push(...collectImportDependencies(node, resolved));
      }
    }

    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const resolved = resolveModule(file, node.argument.literal.text);
      if (resolved) {
        dependencies.push(
          node.qualifier
            ? { resolved, kind: "named", names: [getRightmostEntityName(node.qualifier)] }
            : { resolved, kind: "namespace", names: [] },
        );
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveModule(file, node.moduleSpecifier.text);
        if (resolved) {
          dependencies.push(
            node.exportClause && ts.isNamedExports(node.exportClause)
              ? {
                  resolved,
                  kind: "re-export-named",
                  names: [],
                  reExports: node.exportClause.elements.map((element) => ({
                    imported: element.propertyName?.text ?? element.name.text,
                    exported: element.name.text,
                  })),
                }
              : { resolved, kind: "re-export-all", names: [] },
          );
        }
      }

      if (node.isTypeOnly) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            typeExports.add(element.name.text);
            if (!node.moduleSpecifier) declaredTypeExports.add(element.name.text);
          }
        }
        return;
      }

      if (!node.exportClause) {
        hasWildcardExports = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          // A mixed clause (`export { fn, type T }`) marks individual specifiers
          // type-only. Those are never runtime-dead either, so they belong in
          // `typeExports` exactly like a fully type-only declaration.
          if (element.isTypeOnly) {
            typeExports.add(element.name.text);
            if (!node.moduleSpecifier) declaredTypeExports.add(element.name.text);
            continue;
          }
          exports.add(element.name.text);
          if (!node.moduleSpecifier) declaredExports.add(element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      exports.add("default");
      declaredExports.add("default");
    }

    if (hasExportModifier(node)) {
      collectExportedNames(node, exports);
      collectExportedTypeNames(node, typeExports);
      collectExportedNames(node, declaredExports);
      collectExportedTypeNames(node, declaredTypeExports);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved = resolveModule(file, node.arguments[0].text);
      if (resolved) {
        dependencies.push({ resolved, kind: "side-effect", names: [] });
      }
    }
  });

  // A type export used inside its defining module is an implementation detail,
  // not a declaration-only public surface. Only unreferenced exported types
  // should reach the unused-export gate.
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || !typeExports.has(node.text) || isTypeExportDeclarationName(node)) return;
    localTypeUsage.add(node.text);
  });

  exports.delete("default");
  declaredExports.delete("default");
  return {
    exports,
    typeExports,
    localTypeUsage,
    declaredExports,
    declaredTypeExports,
    dependencies,
    hasWildcardExports,
    hasSideEffectsOnly,
  };
}

function findExportDefinition(file: string, symbol: string, visited = new Set<string>()): string | null {
  if (visited.has(file)) return null;
  visited.add(file);
  const info = moduleInfo.get(file);
  if (!info) return null;
  if (info.declaredExports.has(symbol) || info.declaredTypeExports.has(symbol)) return file;

  for (const dependency of info.dependencies) {
    if (dependency.kind === "re-export-named") {
      const match = dependency.reExports?.find(({ exported }) => exported === symbol);
      if (!match) continue;
      const definition = findExportDefinition(dependency.resolved, match.imported, visited);
      if (definition) return definition;
    }
    if (dependency.kind === "re-export-all") {
      const definition = findExportDefinition(dependency.resolved, symbol, visited);
      if (definition) return definition;
    }
  }
  return null;
}

function collectImportDependencies(node: ts.ImportDeclaration, resolved: string): Dependency[] {
  const deps: Dependency[] = [];
  const importClause = node.importClause;
  if (!importClause) {
    deps.push({ resolved, kind: "side-effect", names: [] });
    return deps;
  }

  if (importClause.name) {
    deps.push({ resolved, kind: "default", names: [] });
  }

  const bindings = importClause.namedBindings;
  if (!bindings) return deps;

  if (ts.isNamespaceImport(bindings)) {
    deps.push({ resolved, kind: "namespace", names: [] });
    return deps;
  }

  deps.push({
    resolved,
    kind: "named",
    names: bindings.elements.map((element) => element.propertyName?.text ?? element.name.text),
  });
  return deps;
}

function collectExportedNames(node: ts.Node, exports: Set<string>): void {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
    if (node.name) exports.add(node.name.text);
    return;
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, exports);
    }
  }
}

function collectExportedTypeNames(node: ts.Node, typeExports: Set<string>): void {
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    if (node.name) typeExports.add(node.name.text);
  }
}

function isTypeExportDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  return false;
}

function getRightmostEntityName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function collectBindingNames(name: ts.BindingName, exports: Set<string>): void {
  if (ts.isIdentifier(name)) {
    exports.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, exports);
    }
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function resolveModule(fromFile: string, specifier: string): string | null {
  let candidate: string | null = null;

  if (specifier.startsWith(".")) {
    candidate = resolve(dirname(fromFile), specifier);
  } else {
    candidate = resolveAliasSpecifier(specifier);
  }

  if (!candidate) return null;

  const resolved = resolveWithExtensions(candidate);
  return resolved && fileSet.has(resolved) ? resolved : null;
}

/**
 * Resolve a bare specifier through the vitest `resolve.alias` table.
 *
 * Covers both the path aliases (`@/…`, `@shared/…`) and the exact-match stub
 * aliases (`satori/standalone`, `@resvg/resvg-wasm`, …) that redirect packages
 * to `worker/src/__mocks__/*`. Without the exact-match half, the stub modules
 * and every export on them looked unreferenced because their only importers use
 * the aliased package specifier.
 */
function resolveAliasSpecifier(specifier: string): string | null {
  let best: { key: string; path: string } | null = null;
  for (const [key, target] of VITEST_ALIASES) {
    if (specifier === key) return target;
    if (!specifier.startsWith(`${key}/`)) continue;
    // Longest key wins so "@shared/x" never resolves through the "@" alias.
    if (!best || key.length > best.key.length) {
      best = { key, path: resolve(target, specifier.slice(key.length + 1)) };
    }
  }
  return best?.path ?? null;
}

/**
 * Read `resolve.alias` out of vitest.config.ts so the scanner's module
 * resolution stays in sync with the one the test runner actually uses.
 * Fails closed: an unreadable or unexpected config shape is a hard error
 * rather than a silent loss of resolution coverage.
 */
function loadVitestAliases(): Map<string, string> {
  const configPath = resolve(ROOT, VITEST_CONFIG);
  const { sourceFile } = parseSourceFile(configPath) as { sourceFile: ts.SourceFile };
  const aliases = new Map<string, string>();

  visit(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    const keyName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
    if (keyName !== "alias" || !ts.isObjectLiteralExpression(node.initializer)) return;

    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const specifier =
        ts.isStringLiteral(property.name) || ts.isIdentifier(property.name) ? property.name.text : null;
      const target = resolveAliasTarget(property.initializer);
      if (specifier && target) aliases.set(specifier, target);
    }
  });

  for (const required of ["@", "@shared"]) {
    if (!aliases.has(required)) {
      console.error(
        `Unable to read the "${required}" alias from ${VITEST_CONFIG}; refusing to scan with partial resolution.`,
      );
      process.exit(1);
    }
  }
  return aliases;
}

/** `path.resolve(__dirname, "src")` / `path.resolve(__dirname, "worker/src/__mocks__/x.ts")` → absolute path. */
function resolveAliasTarget(initializer: ts.Expression): string | null {
  if (ts.isStringLiteral(initializer)) return resolve(ROOT, initializer.text);
  if (!ts.isCallExpression(initializer)) return null;
  const segments = initializer.arguments.filter(ts.isStringLiteral).map((argument) => argument.text);
  return segments.length > 0 ? resolve(ROOT, ...segments) : null;
}

function resolveWithExtensions(basePath: string): string | null {
  const directStat = tryStat(basePath);
  if (directStat?.isFile()) return basePath;

  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${basePath}${extension}`;
    if (tryStat(withExtension)?.isFile()) return withExtension;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const asIndex = join(basePath, `index${extension}`);
    if (tryStat(asIndex)?.isFile()) return asIndex;
  }

  return null;
}

function tryStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isReportableModule(relPath: string): boolean {
  return REPORTABLE_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isUnusedExportReportable(relPath: string): boolean {
  return UNUSED_EXPORT_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isVendoredUiPrimitive(relPath: string): boolean {
  return relPath.startsWith(VENDORED_UI_PREFIX);
}

function isRootEntrypoint(relPath: string): boolean {
  return ROOT_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isTestFile(relPath: string): boolean {
  return relPath.includes("/__tests__/") || /\.test\.[^/]+$/.test(relPath) || /\.spec\.[^/]+$/.test(relPath);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
