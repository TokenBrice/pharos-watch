#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFilesUnderRoot } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";
import { collectScriptEntrypoints } from "./check-script-entrypoints";
import { parse as parseYaml } from "yaml";
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

// Established test-support locations: the vitest setup/helper/fixture
// directories, plus the colocated filename conventions (`*.fixture.ts`,
// `*[-.]test-support.ts`, `*fixtures.ts`, `__fixtures__/`) that live next to
// the suites they serve. These files exist to serve tests, so they are never
// reported — and, like test files, they cannot keep a production module alive:
// a production module whose only consumers are test fixtures is dead, exactly
// like one whose only consumers are test files.
const TEST_SUPPORT_DIR_PREFIXES = [
  "src/test/",
  "src/test-utils/",
  "shared/test-utils/",
  "worker/src/__mocks__/",
  "worker/src/test-helpers/",
];
const TEST_SUPPORT_FILE_PATTERNS = [
  /(^|\/)__fixtures__\//,
  /\.fixture\.[cm]?[jt]sx?$/,
  /[-.]test-support\.[cm]?[jt]sx?$/,
  /fixtures\.[cm]?[jt]sx?$/,
];

// Explicit framework entrypoints. Next.js loads app-router files by filename
// convention, so only those basenames under src/app/ are roots; arbitrary
// helpers colocated under src/app are ordinary modules that must be reached by
// a production import chain. Cloudflare Pages routes every functions/** file
// by path, and wrangler loads the two worker entrypoints below.
const NEXT_APP_ROUTE_BASENAMES: Record<string, true> = {
  page: true,
  layout: true,
  template: true,
  loading: true,
  error: true,
  "global-error": true,
  "not-found": true,
  forbidden: true,
  unauthorized: true,
  default: true,
  route: true,
  sitemap: true,
  robots: true,
  manifest: true,
  icon: true,
  "apple-icon": true,
  favicon: true,
  "opengraph-image": true,
  "twitter-image": true,
};
const ROOT_ENTRYPOINT_PATTERNS = [
  /^functions\//,
  /^worker\/src\/index\.ts$/,
  /^worker\/src\/handlers\/scheduled\.ts$/,
];

// Reference surfaces that can invoke an entrypoint the import graph cannot
// see. Discovery reads ONLY executable command bodies — package.json script
// strings and the `run:` steps parsed out of workflow/composite-action YAML —
// never raw file text: metadata keys, comments, prose, and registry rows like
// sourcePaths/outputPaths are not consumers. Imports written inside repo
// scripts are not rediscovered from text either; script files are AST-scanned
// like every other module, and script-to-script spawning stays the reverse
// audit's concern in check-script-entrypoints. docs/ is excluded for the same
// reason it is there — a documentation row does not keep code reachable.
const COMMAND_BODY_REFERENCE_ROOTS = [".github/workflows", ".github/actions"];
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

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
const relPathByFile = new Map(files.map((file) => [file, relative(ROOT, file).replaceAll("\\", "/")]));
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

const stringReferencedEntrypoints = collectStringReferencedEntrypoints();

// Production reachability. Roots are explicit entrypoints — Next.js app-router
// filename conventions, the Pages Functions route tree, the wrangler-loaded
// worker entrypoints, and files named as strings by workflows, package.json, or
// other scripts — plus every repo script, whose own reference audit lives in
// check-script-entrypoints. Any other module is live only when a live
// production file imports or re-exports it. Test files and test-support
// fixtures never vouch, so a production module whose only consumers are its
// tests is reported as dead instead of being kept alive by them.
const productionReachable = new Set<string>();
const reachableQueue: string[] = [];
for (const file of files) {
  const rel = relPathByFile.get(file);
  if (!rel || isTestFile(rel) || isTestSupportFile(rel)) continue;
  if (isRootEntrypoint(rel) || isScriptConsumerDir(rel) || isStringReferencedEntrypoint(rel)) {
    productionReachable.add(file);
    reachableQueue.push(file);
  }
}
while (reachableQueue.length > 0) {
  const file = reachableQueue.pop();
  if (!file) break;
  for (const dependency of moduleInfo.get(file)?.dependencies ?? []) {
    if (!fileSet.has(dependency.resolved) || productionReachable.has(dependency.resolved)) continue;
    const rel = relPathByFile.get(dependency.resolved);
    if (!rel || isTestFile(rel) || isTestSupportFile(rel)) continue;
    productionReachable.add(dependency.resolved);
    reachableQueue.push(dependency.resolved);
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
  if (
    !isReportableModule(rel) ||
    isTestFile(rel) ||
    isTestSupportFile(rel) ||
    isRootEntrypoint(rel) ||
    isScriptConsumerDir(rel) ||
    isStringReferencedEntrypoint(rel) ||
    isVendoredUiPrimitive(rel)
  ) {
    continue;
  }

  if (!productionReachable.has(file)) {
    unusedModuleKeys.add(rel);
    if (!MODULE_ALLOWLIST.has(rel)) {
      deadModules.push({ file: rel, reason: deadModuleReason(file, info) });
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
    if (EXPORT_ALLOWLIST.has(exportKey) || isCoveredByDefinitionSiteWaiver(file, name)) continue;
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

/**
 * A waiver declared on a symbol's defining module also covers that symbol's
 * re-export hops: the hop routes the same public surface (e.g. the Mini App
 * type barrel re-exporting the external telegram contract), so it inherits the
 * definition's consumer story. A hop whose resolved definition is not waived
 * is still reported, as is anything the barrel exports under its own name.
 */
function isCoveredByDefinitionSiteWaiver(file: string, name: string): boolean {
  const definition = findExportDefinition(file, name);
  if (!definition || definition === file) return false;
  const definitionRel = relative(ROOT, definition).replaceAll("\\", "/");
  return EXPORT_ALLOWLIST.has(`${definitionRel}::${name}`);
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
  return ROOT_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(relPath)) || isNextAppRouterEntrypoint(relPath);
}

function isNextAppRouterEntrypoint(relPath: string): boolean {
  if (!relPath.startsWith("src/app/")) return false;
  const fileName = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = fileName.indexOf(".");
  if (dot <= 0) return false;
  return NEXT_APP_ROUTE_BASENAMES[fileName.slice(0, dot)] === true;
}

function isTestSupportFile(relPath: string): boolean {
  return (
    TEST_SUPPORT_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix)) ||
    TEST_SUPPORT_FILE_PATTERNS.some((pattern) => pattern.test(relPath))
  );
}

function isScriptConsumerDir(relPath: string): boolean {
  return relPath.startsWith("scripts/") || relPath.startsWith("worker/scripts/");
}

function isStringReferencedEntrypoint(relPath: string): boolean {
  return (
    stringReferencedEntrypoints.has(relPath) ||
    stringReferencedEntrypoints.has(relPath.replace(/\.[cm]?[jt]sx?$/, ""))
  );
}

/** Distinguish "nothing points here" from "only tests keep it alive". */
function deadModuleReason(file: string, info: ModuleInfo): string {
  const importers = runtimeInbound.get(file);
  if (!importers || importers.size === 0) {
    return info.exports.size === 0 && info.hasSideEffectsOnly
      ? "unreferenced module"
      : "unreferenced module or dead shim";
  }
  const hasProductionImporter = [...importers].some((importer) => {
    const rel = relPathByFile.get(importer);
    return rel !== undefined && !isTestFile(rel) && !isTestSupportFile(rel);
  });
  return hasProductionImporter
    ? "only referenced from modules that are not production-reachable"
    : "only referenced by tests or test fixtures";
}

/**
 * Entry points the import graph cannot see because they are invoked as text.
 * Discovery is restricted to actual executable command bodies — package.json
 * script strings and the `run:` steps of workflows and composite actions,
 * extracted by parsing the YAML/JSON rather than scanning raw file text, so
 * metadata keys, prose, and comments never root anything. Inside a body the
 * recognizer honors actual `node`/`tsx` command targets (the reused
 * check-script-entrypoints extractor) and actual import expressions — the
 * workflow-heredoc form deploy-cloudflare.yml uses — after stripping `#` and
 * `//` comment lines. Repo script source is deliberately NOT text-scanned:
 * script imports are AST edges like every other module, and script-to-script
 * spawn references stay the reverse audit's concern in
 * check-script-entrypoints.
 */
function collectStringReferencedEntrypoints(): Set<string> {
  const scannedPaths = new Set<string>();
  for (const rel of relPathByFile.values()) {
    scannedPaths.add(rel);
    scannedPaths.add(rel.replace(/\.[cm]?[jt]sx?$/, ""));
  }

  const referenced = new Set<string>();
  const record = (specifier: string): void => {
    const normalized = specifier.replace(/^\.\//, "");
    if (scannedPaths.has(normalized)) referenced.add(normalized);
  };

  const packageJsonPath = resolve(ROOT, "package.json");
  if (tryStat(packageJsonPath)?.isFile()) {
    let pkg: unknown = null;
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {
      pkg = null;
    }
    if (pkg && typeof pkg === "object" && "scripts" in pkg) {
      const scripts = pkg.scripts;
      if (scripts && typeof scripts === "object") {
        for (const command of Object.values(scripts)) {
          if (typeof command === "string") recordCommandBody(command, record);
        }
      }
    }
  }

  for (const referenceRoot of COMMAND_BODY_REFERENCE_ROOTS) {
    const yamlFiles = collectSourceFilesUnderRoot(referenceRoot, ROOT, {
      extensions: YAML_EXTENSIONS,
      excludedDirs: new Set(["node_modules"]),
    });
    for (const yamlFile of yamlFiles) {
      const rel = relative(ROOT, yamlFile).replaceAll("\\", "/");
      if (isTestFile(rel)) continue;
      for (const body of collectRunStepBodies(readFileSync(yamlFile, "utf8"))) {
        recordCommandBody(body, record);
      }
    }
  }
  return referenced;
}

/** Recognize command targets and import expressions inside one executable body. */
function recordCommandBody(body: string, record: (specifier: string) => void): void {
  for (const entrypoint of collectScriptEntrypoints(body, { allowLineBreaks: true })) {
    // Same trailing-punctuation normalization as check-script-entrypoints.
    record(entrypoint.replace(/[\\.,;:]+$/, ""));
  }
  const executable = body
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
  for (const match of executable.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    record(match[1] ?? "");
  }
  for (const match of executable.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    record(match[1] ?? "");
  }
}

/** Pull every `run:` step body out of a workflow or composite-action YAML file. */
function collectRunStepBodies(yamlText: string): string[] {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch {
    // A malformed reference file has no readable executable body; nothing roots.
    return [];
  }
  if (!document || typeof document !== "object") return [];

  const bodies: string[] = [];
  const visitSteps = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (!step || typeof step !== "object" || !("run" in step)) continue;
      if (typeof step.run === "string") bodies.push(step.run);
    }
  };
  const visitJobs = (jobs: unknown): void => {
    if (!jobs || typeof jobs !== "object") return;
    for (const job of Object.values(jobs)) {
      if (!job || typeof job !== "object" || !("steps" in job)) continue;
      visitSteps(job.steps);
    }
  };

  if ("jobs" in document) visitJobs(document.jobs);
  if ("steps" in document) visitSteps(document.steps);
  if ("runs" in document && document.runs && typeof document.runs === "object" && "steps" in document.runs) {
    visitSteps(document.runs.steps);
  }
  // `on:` parses as the string key under the yaml package's core schema; the
  // boolean-key fallback keeps a workflow_call block covered under YAML 1.1.
  for (const key of ["on", "true"]) {
    if (!(key in document)) continue;
    const triggers = document[key];
    if (!triggers || typeof triggers !== "object" || !("workflow_call" in triggers)) continue;
    const workflowCall = triggers.workflow_call;
    if (workflowCall && typeof workflowCall === "object" && "jobs" in workflowCall) {
      visitJobs(workflowCall.jobs);
    }
  }
  return bodies;
}

function isTestFile(relPath: string): boolean {
  return relPath.includes("/__tests__/") || /\.test\.[^/]+$/.test(relPath) || /\.spec\.[^/]+$/.test(relPath);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
