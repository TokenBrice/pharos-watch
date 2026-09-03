#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { argv as processArgv } from "node:process";
import { build, type Metafile, type Plugin } from "esbuild";
import ts from "typescript";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import {
  getRuntimeReachabilityPolicy,
  RUNTIME_REACHABILITY_POLICIES,
  type EntrypointSelector,
  type ForbiddenSelector,
  type RuntimeReachabilityPolicy,
} from "../lib/runtime-reachability-policies.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { collectSourceFiles } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "coverage", "__tests__"]);
const DOM_ONLY_GLOBALS = new Set([
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "DOMParser",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "getComputedStyle",
  "customElements",
  "history",
  "screen",
  "alert",
  "confirm",
  "prompt",
]);

export interface ReachabilityViolation {
  entrypoint: string;
  forbidden: string;
  kind: "reachable" | "direct-import";
}

export interface RuntimeReachabilityResult {
  entrypointCount: number;
  policyId: string;
  violations: ReachabilityViolation[];
}

function toRepoPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  return relative(root, absolute).replaceAll("\\", "/");
}

function isProductionSourceFile(path: string): boolean {
  return !path.endsWith(".test.ts") && !path.endsWith(".test.tsx");
}

function collectFiles(root: string, relativeRoot: string): string[] {
  const absoluteRoot = resolve(root, relativeRoot);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) return [];
  return collectSourceFiles(absoluteRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS })
    .map((path) => toRepoPath(root, path))
    .filter(isProductionSourceFile)
    .sort();
}

function hasUseClientDirective(source: string): boolean {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return /^["']use client["'];/.test(withoutBom.trimStart());
}

function resolveRelativeModule(root: string, fromFile: string, specifier: string): string | null {
  const base = resolve(root, dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRepoPath(root, candidate);
  }
  for (const extension of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = resolve(base, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRepoPath(root, candidate);
  }
  return null;
}

function scheduledLoaderEntrypoints(root: string, sourcePath: string): string[] {
  const absolutePath = resolve(root, sourcePath);
  if (!existsSync(absolutePath)) return [];
  const { sourceFile } = parseSourceFile(absolutePath);
  const entrypoints = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved = resolveRelativeModule(root, sourcePath, node.arguments[0].text);
      if (resolved) entrypoints.add(resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...entrypoints].sort();
}

function resolveEntrypoints(root: string, selector: EntrypointSelector): string[] {
  if (selector.kind === "paths") return selector.paths.map((path) => toRepoPath(root, path));
  if (selector.kind === "scheduled-loaders") return scheduledLoaderEntrypoints(root, selector.source);
  const files = collectFiles(root, selector.root);
  if (selector.kind === "source-files") return files;
  return files.filter((path) => hasUseClientDirective(readFileSync(resolve(root, path), "utf8")));
}

function importsReactOrUsesDomGlobal(path: string): boolean {
  const { sourceFile } = parseSourceFile(path);
  const declaredNames = new Set<string>();
  function recordBindingName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      declaredNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordBindingName(element.name);
    }
  }
  function collectDeclarations(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) recordBindingName(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declaredNames.add(node.name.text);
    if (ts.isImportClause(node) && node.name) declaredNames.add(node.name.text);
    if (ts.isImportSpecifier(node)) declaredNames.add(node.name.text);
    if (ts.isNamespaceImport(node)) declaredNames.add(node.name.text);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  let forbidden = false;
  function visit(node: ts.Node): void {
    if (forbidden) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === "react" ||
        node.moduleSpecifier.text.startsWith("react/") ||
        node.moduleSpecifier.text === "react-dom" ||
        node.moduleSpecifier.text.startsWith("react-dom/"))
    ) {
      forbidden = true;
      return;
    }
    if (
      ts.isIdentifier(node) &&
      (DOM_ONLY_GLOBALS.has(node.text) || /^HTML[A-Za-z]*Element$/.test(node.text)) &&
      !declaredNames.has(node.text)
    ) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) &&
          parent.name === node);
      const isDeclaration =
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) &&
        parent.name === node;
      if (!isPropertyName && !isDeclaration) forbidden = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return forbidden;
}

interface ResolvedForbidden {
  allowedImporters: readonly { prefix: string; importers: Set<string> }[];
  paths: Set<string>;
  prefixes: string[];
}

function resolveForbidden(root: string, selector: ForbiddenSelector): ResolvedForbidden {
  if (selector.kind === "prefixes") return { allowedImporters: [], paths: new Set(), prefixes: [...selector.prefixes] };
  if (selector.kind === "paths") {
    return {
      allowedImporters: (selector.allowedImporters ?? []).map((rule) => ({
        prefix: rule.prefix,
        importers: new Set(rule.importers.map((path) => toRepoPath(root, path))),
      })),
      paths: new Set(selector.paths.map((path) => toRepoPath(root, path))),
      prefixes: [...(selector.prefixes ?? [])],
    };
  }
  const paths = collectFiles(root, selector.root).filter((path) => importsReactOrUsesDomGlobal(resolve(root, path)));
  return { allowedImporters: [], paths: new Set(paths), prefixes: [] };
}

function externalPackagesPlugin(): Plugin {
  return {
    name: "external-packages",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        if (
          args.path.startsWith(".") ||
          args.path.startsWith("/") ||
          args.path.startsWith("@shared/") ||
          args.path.startsWith("@/")
        ) {
          return undefined;
        }
        return { path: args.path, external: true };
      });
    },
  };
}

interface ReachabilityGraph {
  importersByInput: Map<string, Set<string>>;
  inputsByEntrypoint: Map<string, Set<string>>;
}

function buildReachabilityGraph(root: string, metafile: Metafile): ReachabilityGraph {
  const inputsByEntrypoint = new Map<string, Set<string>>();
  for (const output of Object.values(metafile.outputs)) {
    if (!output.entryPoint) continue;
    const entrypoint = toRepoPath(root, output.entryPoint);
    const inputs = inputsByEntrypoint.get(entrypoint) ?? new Set<string>();
    for (const input of Object.keys(output.inputs)) inputs.add(toRepoPath(root, input));
    inputsByEntrypoint.set(entrypoint, inputs);
  }

  const importersByInput = new Map<string, Set<string>>();
  for (const [importer, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      if (imported.external) continue;
      const importedPath = toRepoPath(root, imported.path);
      const importers = importersByInput.get(importedPath) ?? new Set<string>();
      importers.add(toRepoPath(root, importer));
      importersByInput.set(importedPath, importers);
    }
  }
  return { importersByInput, inputsByEntrypoint };
}

async function buildReachability(root: string, entrypoints: string[]): Promise<ReachabilityGraph> {
  if (entrypoints.length === 0) return { importersByInput: new Map(), inputsByEntrypoint: new Map() };
  const tsconfig = existsSync(resolve(root, "tsconfig.json")) ? "tsconfig.json" : undefined;
  const result = await build({
    absWorkingDir: root,
    alias: { "@": resolve(root, "src"), "@shared": resolve(root, "shared") },
    bundle: true,
    entryPoints: entrypoints,
    format: "esm",
    loader: { ".ttf": "file" },
    logLevel: "silent",
    metafile: true,
    outdir: "runtime-reachability-out",
    platform: "neutral",
    plugins: [externalPackagesPlugin()],
    tsconfig,
    write: false,
  });
  return buildReachabilityGraph(root, result.metafile);
}

function isForbidden(
  path: string,
  forbidden: ResolvedForbidden,
  importersByInput: Map<string, Set<string>>,
  reachableInputs: Set<string>,
): boolean {
  if (!forbidden.paths.has(path) && !forbidden.prefixes.some((prefix) => path.startsWith(prefix))) return false;
  const allowance = forbidden.allowedImporters.find((rule) => path.startsWith(rule.prefix));
  if (!allowance) return true;
  const importers = importersByInput.get(path);
  if (importers && importers.size > 0) {
    return [...importers].some((importer) => !allowance.importers.has(importer) && reachableInputs.has(importer));
  }
  return ![...allowance.importers].some((importer) => reachableInputs.has(importer));
}

export async function checkRuntimeReachabilityPolicy(
  policy: RuntimeReachabilityPolicy,
  root = REPO_ROOT,
): Promise<RuntimeReachabilityResult> {
  const entrypoints = resolveEntrypoints(root, policy.entrypoints);
  const forbidden = resolveForbidden(root, policy.forbidden);
  const graph = await buildReachability(root, entrypoints);
  const violations: ReachabilityViolation[] = [];

  for (const entrypoint of entrypoints) {
    const reachableInputs = graph.inputsByEntrypoint.get(entrypoint) ?? new Set<string>();
    for (const input of reachableInputs) {
      if (isForbidden(input, forbidden, graph.importersByInput, reachableInputs)) {
        violations.push({ entrypoint, forbidden: input, kind: "reachable" });
      }
    }
  }

  for (const entrypoint of policy.directImports?.entrypoints ?? []) {
    const source = readFileSync(resolve(root, entrypoint), "utf8");
    for (const specifier of policy.directImports?.forbiddenSpecifiers ?? []) {
      if (source.includes(`from "${specifier}"`) || source.includes(`from '${specifier}'`)) {
        violations.push({ entrypoint, forbidden: specifier, kind: "direct-import" });
      }
    }
  }

  violations.sort((left, right) =>
    `${left.entrypoint}\0${left.forbidden}`.localeCompare(`${right.entrypoint}\0${right.forbidden}`),
  );
  return { entrypointCount: entrypoints.length, policyId: policy.id, violations };
}

function reportResult(policy: RuntimeReachabilityPolicy, result: RuntimeReachabilityResult): number {
  if (result.violations.length > 0) {
    process.stderr.write(`${policy.failureHeading}:\n\n`);
    for (const violation of result.violations) {
      const relation = violation.kind === "direct-import" ? "directly imports" : "reaches";
      process.stderr.write(`  ${violation.entrypoint} ${relation} ${violation.forbidden}\n`);
    }
    process.stderr.write(`\n${policy.remediation}\n`);
    return 1;
  }

  const membershipCount = policy.directImports?.entrypoints.length;
  const suffix = membershipCount == null
    ? `${result.entrypointCount} entrypoints`
    : `${result.entrypointCount} entrypoints, ${membershipCount} membership modules`;
  process.stdout.write(`${policy.successLabel}: OK (${suffix})\n`);
  return 0;
}

export async function runRuntimeReachabilityCli(argv = processArgv.slice(2)): Promise<number> {
  const { values } = parseStrictCliArgs(argv, { options: { policy: { type: "string" } } });
  const requestedPolicy = typeof values.policy === "string" ? values.policy : null;
  const policies = requestedPolicy
    ? [getRuntimeReachabilityPolicy(requestedPolicy)].filter((policy): policy is RuntimeReachabilityPolicy => policy != null)
    : [...RUNTIME_REACHABILITY_POLICIES];
  if (requestedPolicy && policies.length === 0) throw new Error(`Unknown runtime reachability policy: ${requestedPolicy}`);

  let exitCode = 0;
  for (const policy of policies) {
    const result = await checkRuntimeReachabilityPolicy(policy);
    exitCode = Math.max(exitCode, reportResult(policy, result));
  }
  process.exitCode = exitCode;
  return exitCode;
}

if (isDirectRun(import.meta.url, processArgv[1])) {
  runRuntimeReachabilityCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
