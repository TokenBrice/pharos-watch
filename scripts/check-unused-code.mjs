#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "fs";
import { extname, dirname, join, relative, resolve } from "path";
import ts from "typescript";

const ROOT = process.cwd();
const SOURCE_DIRS = ["src", "shared", "worker/src", "functions"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const REPORTABLE_DIR_PREFIXES = [
  "src/lib/",
  "shared/lib/",
  "worker/src/api/",
  "worker/src/handlers/",
  "worker/src/lib/",
  "functions/lib/",
];
const UNUSED_EXPORT_DIR_PREFIXES = [
  "src/lib/status/",
  "worker/src/api/feedback/",
  "worker/src/api/stablecoin-detail/",
  "worker/src/handlers/http/",
  "worker/src/lib/status/",
  "functions/lib/",
];

const ROOT_ENTRYPOINT_PATTERNS = [
  /^src\/app\//,
  /^functions\//,
  /^worker\/src\/index\.ts$/,
  /^worker\/src\/handlers\/scheduled\.ts$/,
];

const MODULE_ALLOWLIST = new Set([]);
const EXPORT_ALLOWLIST = new Set([]);

const files = collectSourceFiles();
const fileSet = new Set(files);
const moduleInfo = new Map(
  files.map((file) => [file, analyzeModule(file)]),
);

const runtimeInbound = new Map(files.map((file) => [file, new Set()]));
const namedExportUsage = new Map(files.map((file) => [file, new Set()]));
const ambiguousUsage = new Set();

for (const [file, info] of moduleInfo.entries()) {
  for (const dependency of info.dependencies) {
    if (!runtimeInbound.has(dependency.resolved)) continue;
    runtimeInbound.get(dependency.resolved).add(file);
    if (dependency.kind !== "named") {
      ambiguousUsage.add(dependency.resolved);
      continue;
    }
    const usedNames = namedExportUsage.get(dependency.resolved);
    for (const name of dependency.names) {
      usedNames.add(name);
    }
  }
}

const deadModules = [];
const unusedExports = [];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const info = moduleInfo.get(file);
  if (!isReportableModule(rel) || isTestFile(rel) || isRootEntrypoint(rel)) continue;

  if ((runtimeInbound.get(file)?.size ?? 0) === 0 && !MODULE_ALLOWLIST.has(rel)) {
    deadModules.push({
      file: rel,
      reason: info.exports.size === 0 && info.hasSideEffectsOnly ? "unreferenced module" : "unreferenced module or dead shim",
    });
    continue;
  }

  if (!isUnusedExportReportable(rel) || ambiguousUsage.has(file) || info.hasWildcardExports) continue;

  const usedNames = namedExportUsage.get(file) ?? new Set();
  for (const name of info.exports) {
    const exportKey = `${rel}::${name}`;
    if (usedNames.has(name) || EXPORT_ALLOWLIST.has(exportKey)) continue;
    unusedExports.push({ file: rel, name });
  }
}

if (deadModules.length === 0 && unusedExports.length === 0) {
  console.log("No dead internal modules or unused named exports found.");
  process.exit(0);
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

process.exit(1);

function collectSourceFiles() {
  const results = [];
  for (const dir of SOURCE_DIRS) {
    walk(resolve(ROOT, dir), results);
  }
  return results.sort();
}

function walk(dir, results) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") continue;
      walk(full, results);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    results.push(full);
  }
}

function analyzeModule(file) {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(file),
  );

  const exports = new Set();
  const dependencies = [];
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

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveModule(file, node.moduleSpecifier.text);
        if (resolved) {
          dependencies.push(
            node.exportClause && ts.isNamedExports(node.exportClause)
              ? {
                  resolved,
                  kind: "named",
                  names: node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text),
                }
              : { resolved, kind: "namespace", names: [] },
          );
        }
      }

      if (node.isTypeOnly) {
        return;
      }

      if (!node.exportClause) {
        hasWildcardExports = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.add(element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      exports.add("default");
    }

    if (hasExportModifier(node)) {
      collectExportedNames(node, exports);
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

  exports.delete("default");
  return { exports, dependencies, hasWildcardExports, hasSideEffectsOnly };
}

function collectImportDependencies(node, resolved) {
  const deps = [];
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

function collectExportedNames(node, exports) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    if (node.name) exports.add(node.name.text);
    return;
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, exports);
    }
  }
}

function collectBindingNames(name, exports) {
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

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("@shared/")) {
    return null;
  }

  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = resolve(ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith("@shared/")) {
    candidate = resolve(ROOT, "shared", specifier.slice("@shared/".length));
  } else {
    candidate = resolve(dirname(fromFile), specifier);
  }

  const resolved = resolveWithExtensions(candidate);
  return resolved && fileSet.has(resolved) ? resolved : null;
}

function resolveWithExtensions(basePath) {
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

function tryStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isReportableModule(relPath) {
  return REPORTABLE_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isUnusedExportReportable(relPath) {
  return UNUSED_EXPORT_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function isRootEntrypoint(relPath) {
  return ROOT_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isTestFile(relPath) {
  return relPath.includes("/__tests__/") || /\.test\.[^/]+$/.test(relPath) || /\.spec\.[^/]+$/.test(relPath);
}

function getScriptKind(file) {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts" || extension === ".mts") return ts.ScriptKind.TS;
  if (extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
