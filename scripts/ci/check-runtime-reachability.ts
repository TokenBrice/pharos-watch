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
import { collectSourceFilesUnderRoots } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE } from "../../shared/lib/scheduled-runner-registry";
import { parseAssignments, unquote } from "../lib/wrangler-toml.mjs";

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
  chain?: string[];
}

export interface RuntimeReachabilityResult {
  configurationErrors: string[];
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

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
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

interface OwnerInvocationBoundary {
  configurationErrors: string[];
  entrypoints: string[];
  excludedLazyImports: Set<string>;
}

function scheduledOwnerBoundary(
  root: string,
  selector: Extract<EntrypointSelector, { kind: "scheduled-owner-loaders" }>,
): OwnerInvocationBoundary {
  const source = toRepoPath(root, selector.source);
  const configurationErrors: string[] = [];
  const entrypoints = [source, ...selector.additionalPaths];
  const excludedLazyImports = new Set<string>();
  if (!isFile(resolve(root, source))) {
    return { configurationErrors: [`Configured scheduled owner source is missing: ${source}`], entrypoints: [], excludedLazyImports };
  }
  const { sourceFile } = parseSourceFile(resolve(root, source));
  const ownerKeys = new Set<string>(Object.values(SCHEDULED_SLOT_PLANS_BY_SCHEDULE)
    .filter((plan) => plan.worker === selector.role).map((plan) => plan.scheduleKey));
  const foundOwnerKeys = new Set<string>();
  const loaderTables: ts.ObjectLiteralExpression[] = [];
  const handlers: ts.FunctionDeclaration[] = [];
  function find(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "SLOT_RUNNER_LOADER_BY_KEY") {
      const initializer = node.initializer;
      if (initializer && ts.isSatisfiesExpression(initializer) && ts.isObjectLiteralExpression(initializer.expression)) {
        loaderTables.push(initializer.expression);
      } else if (initializer && ts.isObjectLiteralExpression(initializer)) loaderTables.push(initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleScheduledEvent") handlers.push(node);
    ts.forEachChild(node, find);
  }
  find(sourceFile);
  const loaderTable = loaderTables[0];
  const handler = handlers[0];
  if (!loaderTable || !handler?.body) {
    configurationErrors.push("Scheduled owner boundary requires the loader table and handleScheduledEvent body");
  } else {
    for (const property of loaderTable.properties) {
      if (!ts.isPropertyAssignment(property)) {
        configurationErrors.push("Scheduled loader table must use explicit keyed loader properties");
        continue;
      }
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
      if (!ts.isArrowFunction(property.initializer) || ts.isBlock(property.initializer.body)) {
        configurationErrors.push(`Scheduled loader ${key} must remain a lazy expression-bodied closure`);
      }
      const imports: string[] = [];
      function collect(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
        ts.forEachChild(node, collect);
      }
      collect(property.initializer);
      if (imports.length !== 1) configurationErrors.push(`Scheduled loader ${key} must have exactly one literal lazy import`);
      for (const specifier of imports) {
        if (ownerKeys.has(key)) {
          foundOwnerKeys.add(key);
          const path = resolveRelativeModule(root, source, specifier);
          if (path) entrypoints.push(path);
          else configurationErrors.push(`Scheduled owner loader ${key} is missing: ${specifier}`);
        } else excludedLazyImports.add(specifier);
      }
    }
    // The rejected role must return at handler scope before the first loader
    // invocation. Merely looking up a closure is safe; invoking it is not.
    const statements = handler.body.statements;
    const guard = statements.find((statement) => ts.isIfStatement(statement) &&
      statement.expression.getText(sourceFile).replaceAll(/\s/g, "") === "slotPlan.worker!==workerRole");
    const rejectsRole = guard && ts.isIfStatement(guard) && ts.isBlock(guard.thenStatement) &&
      guard.thenStatement.statements.some((statement) => ts.isReturnStatement(statement));
    let loaderCalls = 0;
    function inspectCalls(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "loadRunner") {
        loaderCalls++;
        if (!rejectsRole || !guard || node.getStart(sourceFile) < guard.end) {
          configurationErrors.push("Scheduled owner role rejection must return before invoking loadRunner()");
        }
      }
      ts.forEachChild(node, inspectCalls);
    }
    inspectCalls(handler.body);
    function inspectDispatcher(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          (node.getStart(sourceFile) < loaderTable!.pos || node.end > loaderTable!.end)) {
        configurationErrors.push("Scheduled dispatcher may lazy-load slots only inside the guarded loader table");
      }
      if (ts.isIdentifier(node) && node.text === "SLOT_RUNNER_LOADER_BY_KEY" &&
          ts.isElementAccessExpression(node.parent) && node.parent.expression === node) {
        const declaration = node.parent.parent.parent;
        if (!ts.isVariableDeclaration(declaration) || declaration.name.getText(sourceFile) !== "loadRunner" ||
            node.parent.argumentExpression.getText(sourceFile) !== "slotPlan.scheduleKey") {
          configurationErrors.push("Scheduled dispatcher must select loaders only through the guarded loadRunner binding");
        }
      }
      ts.forEachChild(node, inspectDispatcher);
    }
    inspectDispatcher(sourceFile);
    if (!rejectsRole || loaderCalls !== 1) {
      configurationErrors.push("Scheduled owner boundary requires one guarded loadRunner() invocation");
    }
  }
  for (const key of ownerKeys) {
    if (!foundOwnerKeys.has(key)) configurationErrors.push(`Heavy-owned schedule has no loader: ${key}`);
  }
  for (const path of entrypoints) {
    if (!isFile(resolve(root, path))) configurationErrors.push(`Configured entrypoint source is missing: ${path}`);
  }
  return { configurationErrors, entrypoints: [...new Set(entrypoints)].filter((path) => isFile(resolve(root, path))), excludedLazyImports };
}

function resolveEntrypoints(
  root: string,
  selector: EntrypointSelector,
): { configurationErrors: string[]; entrypoints: string[] } {
  if (selector.kind === "paths") {
    const entrypoints = selector.paths.map((path) => toRepoPath(root, path));
    const configurationErrors = entrypoints
      .filter((path) => !isFile(resolve(root, path)))
      .map((path) => `Configured entrypoint source is missing: ${path}`);
    if (entrypoints.length === 0) configurationErrors.push("Configured entrypoint list is empty");
    return { configurationErrors, entrypoints: entrypoints.filter((path) => isFile(resolve(root, path))) };
  }
  if (selector.kind === "scheduled-owner-loaders") return scheduledOwnerBoundary(root, selector);
  if (selector.kind === "scheduled-loaders") {
    const source = toRepoPath(root, selector.source);
    if (!isFile(resolve(root, source))) {
      return {
        configurationErrors: [`Configured scheduled loader source is missing: ${source}`],
        entrypoints: [],
      };
    }
    const loaders = scheduledLoaderEntrypoints(root, source);
    return {
      configurationErrors: loaders.length === 0
        ? [`Configured scheduled loader source has no dynamic-import entrypoints: ${source}`]
        : [],
      entrypoints: [source, ...loaders],
    };
  }
  const rootPath = resolve(root, selector.root);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    return {
      configurationErrors: [`Configured entrypoint root is missing: ${toRepoPath(root, selector.root)}`],
      entrypoints: [],
    };
  }
  const files = collectSourceFilesUnderRoots([selector.root], root, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: EXCLUDED_DIRS,
  }).filter(isProductionSourceFile);
  const entrypoints = selector.kind === "source-files"
    ? files
    : files.filter((path) => hasUseClientDirective(readFileSync(resolve(root, path), "utf8")));
  return {
    configurationErrors: entrypoints.length === 0
      ? [`Configured entrypoint root resolved no entrypoints: ${toRepoPath(root, selector.root)}`]
      : [],
    entrypoints,
  };
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
  const paths = collectSourceFilesUnderRoots([selector.root], root, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: EXCLUDED_DIRS,
  })
    .filter(isProductionSourceFile)
    .filter((path) => importsReactOrUsesDomGlobal(resolve(root, path)));
  return { allowedImporters: [], paths: new Set(paths), prefixes: [] };
}

function externalPackagesPlugin(ownerBoundary?: { source: string; excludedLazyImports: Set<string> }): Plugin {
  return {
    name: "external-packages",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        if (ownerBoundary && args.kind === "dynamic-import" &&
            args.importer === ownerBoundary.source && ownerBoundary.excludedLazyImports.has(args.path)) {
          return { path: args.path, external: true };
        }
        if (
          args.path.startsWith(".") ||
          args.path.startsWith("/") ||
          args.path.startsWith("@shared/") ||
          args.path.startsWith("@/") ||
          (ownerBoundary !== undefined && args.path === "#pharos-full-catalog")
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

function findImportChain(graph: ReachabilityGraph, entrypoint: string, target: string): string[] | undefined {
  const queue = [[target]];
  const seen = new Set([target]);
  for (let index = 0; index < queue.length; index++) {
    const chain = queue[index]!;
    const current = chain[0]!;
    if (current === entrypoint) return chain;
    for (const importer of graph.importersByInput.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push([importer, ...chain]);
    }
  }
  return undefined;
}

async function buildReachability(root: string, entrypoints: string[], policy: RuntimeReachabilityPolicy): Promise<ReachabilityGraph> {
  if (entrypoints.length === 0) return { importersByInput: new Map(), inputsByEntrypoint: new Map() };
  const tsconfig = existsSync(resolve(root, "tsconfig.json")) ? "tsconfig.json" : undefined;
  const alias: Record<string, string> = { "@": resolve(root, "src"), "@shared": resolve(root, "shared") };
  if (policy.wranglerConfig) {
    const configPath = resolve(root, policy.wranglerConfig);
    const catalogAlias = parseAssignments(readFileSync(configPath, "utf8"))
      .find((assignment) => assignment.section === "alias" && assignment.key === "#pharos-full-catalog");
    const target = unquote(catalogAlias?.value);
    if (!target) throw new Error(`Missing #pharos-full-catalog alias in ${policy.wranglerConfig}`);
    alias["#pharos-full-catalog"] = resolve(dirname(configPath), target);
  }
  const ownerBoundary = policy.entrypoints.kind === "scheduled-owner-loaders"
    ? { source: resolve(root, policy.entrypoints.source), excludedLazyImports: scheduledOwnerBoundary(root, policy.entrypoints).excludedLazyImports }
    : undefined;
  const result = await build({
    absWorkingDir: root,
    alias,
    bundle: true,
    entryPoints: entrypoints,
    format: "esm",
    loader: { ".ttf": "file", ".wasm": "file" },
    logLevel: "silent",
    metafile: true,
    outdir: "runtime-reachability-out",
    platform: "neutral",
    plugins: [externalPackagesPlugin(ownerBoundary)],
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
  const resolved = resolveEntrypoints(root, policy.entrypoints);
  const { configurationErrors, entrypoints } = resolved;
  const forbidden = resolveForbidden(root, policy.forbidden);
  if (configurationErrors.length > 0 && policy.entrypoints.kind === "scheduled-owner-loaders") {
    return { configurationErrors, entrypointCount: entrypoints.length, policyId: policy.id, violations: [] };
  }
  if (policy.wranglerConfig && !isFile(resolve(root, policy.wranglerConfig))) {
    configurationErrors.push(`Configured Wrangler source is missing: ${policy.wranglerConfig}`);
    return { configurationErrors, entrypointCount: entrypoints.length, policyId: policy.id, violations: [] };
  }
  const graph = await buildReachability(root, entrypoints, policy);
  const violations: ReachabilityViolation[] = [];

  for (const entrypoint of entrypoints) {
    const reachableInputs = graph.inputsByEntrypoint.get(entrypoint) ?? new Set<string>();
    for (const input of reachableInputs) {
      if (isForbidden(input, forbidden, graph.importersByInput, reachableInputs)) {
        violations.push({
          entrypoint, forbidden: input, kind: "reachable",
          ...(policy.id === "safety-score-v9-publication" ? { chain: findImportChain(graph, entrypoint, input) } : {}),
        });
      }
    }
  }

  for (const required of policy.requiredReachable ?? []) {
    if (![...graph.inputsByEntrypoint.values()].some((inputs) => inputs.has(required))) {
      configurationErrors.push(`Required runtime evidence is not reachable: ${required}`);
    }
  }

  for (const entrypoint of policy.directImports?.entrypoints ?? []) {
    const absolutePath = resolve(root, entrypoint);
    if (!isFile(absolutePath)) {
      configurationErrors.push(`Configured direct-import source is missing: ${toRepoPath(root, entrypoint)}`);
      continue;
    }
    const source = readFileSync(absolutePath, "utf8");
    for (const specifier of policy.directImports?.forbiddenSpecifiers ?? []) {
      if (source.includes(`from "${specifier}"`) || source.includes(`from '${specifier}'`)) {
        violations.push({ entrypoint, forbidden: specifier, kind: "direct-import" });
      }
    }
  }

  violations.sort((left, right) =>
    `${left.entrypoint}\0${left.forbidden}`.localeCompare(`${right.entrypoint}\0${right.forbidden}`),
  );
  return { configurationErrors, entrypointCount: entrypoints.length, policyId: policy.id, violations };
}

function reportResult(policy: RuntimeReachabilityPolicy, result: RuntimeReachabilityResult): number {
  if (result.configurationErrors.length > 0 || result.violations.length > 0) {
    process.stderr.write(`${policy.failureHeading}:\n\n`);
    for (const error of result.configurationErrors) {
      process.stderr.write(`  ${error}\n`);
    }
    for (const violation of result.violations) {
      const relation = violation.kind === "direct-import" ? "directly imports" : "reaches";
      process.stderr.write(`  ${violation.entrypoint} ${relation} ${violation.forbidden}\n`);
      if (violation.chain) process.stderr.write(`    ${violation.chain.join(" -> ")}\n`);
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
