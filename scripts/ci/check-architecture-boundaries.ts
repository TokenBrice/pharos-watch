#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFiles } from "../lib/source-files.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { getScriptKind, parseSourceFile } from "../lib/ts-ast.mts";
import { resolveLocalPackageImport } from "../lib/package-imports.mts";

const ROOT = resolve(import.meta.dirname, "../..");
const ADAPTERS = "worker/src/cron/reserve-adapters/";
const SCRUBBER = "src/lib/api-key-verification-url.ts";
const LIGHT = "src/lib/api-query-domains/stability-light.ts";
const NETWORK_PACKAGES = /^(?:node:)?(?:https?|http2|net|tls|dgram)$|^(?:undici|node-fetch|cross-fetch|axios|openai|@anthropic-ai\/sdk)(?:\/|$)/;
const NETWORK_GLOBALS: Record<string, true> = { fetch: true, XMLHttpRequest: true, WebSocket: true, EventSource: true };
const GLOBAL_OBJECTS: Record<string, true> = { globalThis: true, window: true, self: true, global: true };
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TELEGRAM_IMPLEMENTATION = /^worker\/src\/(?:telegram\/|cron\/telegram\/)/;

// Exact public entries and importer pairs, derived from production referrers.
const TELEGRAM_PUBLIC_ENTRIES: readonly (readonly [string, readonly string[]])[] = [
  ["worker/src/telegram/admin/admin-telegram-broadcast.ts", [
    "worker/src/routes/admin-routes.ts",
  ]],
  ["worker/src/telegram/adoption/telegram-adoption.ts", [
    "worker/src/routes/messaging-routes.ts",
  ]],
  ["worker/src/telegram/mini-app/telegram-mini-app.ts", [
    "worker/src/routes/messaging-routes.ts",
  ]],
  ["worker/src/telegram/webhook/telegram-pulse.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts", "worker/src/routes/public-routes.ts",
  ]],
  ["worker/src/telegram/store/disambiguation.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts",
  ]],
  ["worker/src/telegram/webhook/telegram-webhook.ts", [
    "worker/src/routes/messaging-routes.ts",
  ]],
  ["worker/src/telegram/webhook/telegram-ingress-abuse.ts", [
    "worker/src/handlers/http/request-dispatch.ts",
  ]],
  ["worker/src/telegram/delivery/telegram.ts", [
    "worker/src/api/admin-actions.ts",
    "worker/src/cron/cron-sentinel-rules.ts", "worker/src/cron/cron-sentinel.ts",
    "worker/src/cron/cron-staleness-watchdog.ts", "worker/src/cron/daily-digest.ts",
    "worker/src/cron/digest-publication-watchdog.ts", "worker/src/cron/digest/publish.ts",
    "worker/src/cron/digest/telegram-transport.ts", "worker/src/cron/digest/wrapper-style-gate.ts",
    "worker/src/cron/weekly-recap.ts", "worker/src/lib/runtime-credentials.ts", "worker/src/routes/shared.ts",
  ]],
  ["worker/src/telegram/adoption/adoption-analytics.ts", [
    "worker/src/handlers/http/gates.ts", "worker/src/routes/messaging-routes.ts",
  ]],
  ["worker/src/telegram/delivery/delivery-sli.ts", [
    "worker/src/lib/status/telegram-bot-stats.ts",
  ]],
  ["worker/src/telegram/digest/digest-appendices.ts", [
    "worker/src/cron/daily-digest.ts", "worker/src/cron/digest/publish.ts",
    "worker/src/cron/sync-stablecoins/telegram-tracked-additions.ts",
  ]],
  ["worker/src/telegram/outbox/digest-outbox.ts", [
    "worker/src/cron/digest/publish.ts", "worker/src/handlers/scheduled/digest-trigger-poll.ts",
  ]],
  ["worker/src/telegram/common/log.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts",
  ]],
  ["worker/src/telegram/outbox/pending-capacity.ts", [
    "worker/src/lib/status/supplements.ts", "worker/src/lib/status/telegram-bot-stats.ts",
  ]],
  ["worker/src/telegram/delivery/transport-control.ts", [
    "worker/src/cron/digest/telegram-transport.ts",
  ]],
  ["worker/src/telegram/delivery/transport-errors.ts", [
    "worker/src/cron/digest/telegram-transport.ts",
  ]],
  ["worker/src/telegram/store/usage-analytics.ts", [
    "worker/src/lib/status/telegram-bot-stats.ts",
  ]],
  ["worker/src/telegram/webhook/webhook-registration.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts",
  ]],
  ["worker/src/cron/telegram/dispatch/dispatch-telegram-alerts.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts",
  ]],
  ["worker/src/cron/telegram/maintenance/telegram-degradation-watchdog.ts", [
    "worker/src/handlers/scheduled/five-minute-telegram.ts",
  ]],
  ["worker/src/cron/telegram/maintenance/telegram-inactive-cleanup.ts", [
    "worker/src/handlers/scheduled/daily-0300.ts",
  ]],
  ["worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", [
    "worker/src/handlers/scheduled/daily-0300.ts",
  ]],
  ["worker/src/cron/telegram/sources/telegram-alert-snapshots.ts", [
    "worker/src/cron/reserve-post-sync-watchdog.ts",
  ]],
];
const TELEGRAM_PUBLIC_PAIRS: Record<string, true> = {};
for (const [entry, importers] of TELEGRAM_PUBLIC_ENTRIES) {
  for (const importer of importers) {
    TELEGRAM_PUBLIC_PAIRS[`${importer} -> ${entry}`] = true;
  }
}

type Rule = "reserve-network" | "frontend-routes" | "verification-url" | "stability-light" | "telegram-public-surface";
interface Module {
  dependencies: string[];
  network: boolean;
  errors: string[];
}

function repoPath(root: string, file: string): string {
  return relative(root, file).replaceAll("\\", "/");
}

/** Reject acquiring a network capability, not just calls spelled `fetch(...)`.
 * This covers aliases, destructuring, bracket access and .bind/.call wrappers.
 */
function usesNetwork(source: ts.SourceFile): boolean {
  let found = false;
  let checker: ts.TypeChecker | undefined;
  const symbol = (node: ts.Node) => {
    if (!checker) {
      const options = { noLib: true, noResolve: true, allowJs: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (file) => file === source.fileName ? source : undefined;
      checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
    }
    return checker.getSymbolAtLocation(node);
  };
  const isGlobalObject = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isParenthesizedExpression(node)) return isGlobalObject(node.expression, seen);
    if (!ts.isIdentifier(node)) return false;
    const binding = symbol(node);
    if (!binding?.declarations?.length) return GLOBAL_OBJECTS[node.text] === true;
    const declaration = binding.valueDeclaration;
    return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
      && isGlobalObject(declaration.initializer, seen);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && NETWORK_GLOBALS[node.text] === true && !symbol(node)) {
      const parent = node.parent;
      if (!(ts.isPropertyAssignment(parent) && parent.name === node)
        && !(ts.isPropertyAccessExpression(parent) && parent.name === node)
        && !(ts.isPropertyDeclaration(parent) && parent.name === node)
        && !(ts.isMethodDeclaration(parent) && parent.name === node)) found = true;
    }
    if (ts.isPropertyAccessExpression(node) && NETWORK_GLOBALS[node.name.text] === true
      && isGlobalObject(node.expression)) found = true;
    if (ts.isElementAccessExpression(node) && isGlobalObject(node.expression)
      && (!ts.isStringLiteralLike(node.argumentExpression)
        || NETWORK_GLOBALS[node.argumentExpression.text] === true)) found = true;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.initializer && isGlobalObject(node.initializer)) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && NETWORK_GLOBALS[key.text] === true) found = true;
        if (element.dotDotDotToken || ts.isComputedPropertyName(key)) found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

class DependencyGraph {
  private modules = new Map<string, Module>();
  private options: ts.CompilerOptions;
  private cache: ts.ModuleResolutionCache;

  constructor(private root: string) {
    const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    this.options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
    this.cache = ts.createModuleResolutionCache(root, (file) => file, this.options);
  }

  module(file: string, authored = false): Module {
    const key = authored ? `authored:${file}` : file;
    const cached = this.modules.get(key);
    if (cached) return cached;
    const result: Module = { dependencies: [], network: false, errors: [] };
    this.modules.set(key, result);
    if (file.startsWith("package:")) return result;
    const absolute = resolve(this.root, file);
    if (!existsSync(absolute)) {
      result.errors.push("missing module");
      return result;
    }
    if (!SOURCE_EXTENSIONS.has(extname(file))) return result;
    // Reachability policies erase types; the public-surface policy inspects
    // authored syntax so type imports cannot bypass the feature's API.
    const original = parseSourceFile(absolute);
    const emitted = ts.transpileModule(original.source, {
      fileName: absolute,
      compilerOptions: { ...this.options, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
      reportDiagnostics: true,
    });
    for (const diagnostic of emitted.diagnostics ?? []) {
      if (diagnostic.category === ts.DiagnosticCategory.Error) {
        result.errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      }
    }
    const source = authored ? original.sourceFile
      : ts.createSourceFile(absolute, emitted.outputText, ts.ScriptTarget.Latest, true, getScriptKind(absolute));
    result.network = !authored && usesNetwork(source);
    const add = (specifier: string) => {
      try {
        const local = resolveLocalPackageImport(specifier, this.root);
        if (local) {
          result.dependencies.push(repoPath(this.root, realpathSync(local)));
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`unresolved dependency ${specifier}: ${message}`);
        return;
      }
      const resolved = ts.resolveModuleName(specifier, absolute, this.options, ts.sys, this.cache).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport && !resolved.resolvedFileName.includes("/node_modules/")) {
        result.dependencies.push(repoPath(this.root, realpathSync(resolved.resolvedFileName)));
        return;
      }
      // Package imports are resolved, not silently dropped. Their public module
      // identity is the boundary (as in check-runtime-reachability's externals).
      if (resolved || builtinModules.includes(specifier) || builtinModules.includes(specifier.replace(/^node:/, ""))) {
        const packagePath = resolved?.resolvedFileName.split("/node_modules/").at(-1) ?? "";
        const canonical = resolved?.packageId?.name
          ?? (resolved?.resolvedFileName.includes("/node_modules/") ? packagePath.split("/").slice(0, packagePath.startsWith("@") ? 2 : 1).join("/") : undefined);
        result.dependencies.push(`package:${canonical ?? specifier}`);
        return;
      }
      try {
        const resolvedFile = createRequire(absolute).resolve(specifier);
        result.dependencies.push(resolvedFile.includes("/node_modules/")
          ? `package:${specifier}` : repoPath(this.root, realpathSync(resolvedFile)));
      } catch {
        const asset = resolve(dirname(absolute), specifier);
        if (specifier.startsWith(".") && existsSync(asset) && !SOURCE_EXTENSIONS.has(extname(asset))) {
          result.dependencies.push(repoPath(this.root, realpathSync(asset)));
        } else result.errors.push(`unresolved dependency ${specifier}`);
      }
    };
    // ESNext emit can lower import-equals to a generated require alias; retain
    // its resolved edge from the original syntax rather than guessing that name.
    for (const statement of original.sourceFile.statements) {
      if (ts.isImportEqualsDeclaration(statement) && (authored || !statement.isTypeOnly)
        && ts.isExternalModuleReference(statement.moduleReference)
        && statement.moduleReference.expression && ts.isStringLiteralLike(statement.moduleReference.expression)) {
        add(statement.moduleReference.expression.text);
      }
    }
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      if (authored && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteralLike(node.argument.literal)) add(node.argument.literal.text);
      if (ts.isIdentifier(node) && node.text === "require"
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        result.errors.push("non-literal executable dependency (escaped require)");
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) add(argument.text);
        else if (argument && ts.isTemplateExpression(argument) && argument.head.text.startsWith(".")
          && argument.head.text.includes("/")) {
          // Bundlers expand relative template imports to every matching file.
          // Do the same; an unconstrained import(expr) remains a closed failure.
          const prefix = argument.head.text;
          const directory = resolve(dirname(absolute), prefix.slice(0, prefix.lastIndexOf("/") + 1));
          const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // eslint-disable-next-line security/detect-non-literal-regexp -- every fragment is escaped source text from the import template literal
          const pattern = new RegExp(`^${escape(prefix)}${argument.templateSpans.map((span) => `.*${escape(span.literal.text)}`).join("")}$`);
          const matches = existsSync(directory) ? collectSourceFiles(directory).filter((file) => {
            const specifier = repoPath(dirname(absolute), file);
            return pattern.test(specifier.startsWith(".") ? specifier : `./${specifier}`);
          }) : [];
          if (!matches.length) result.errors.push("unresolved template dependency");
          for (const match of matches) result.dependencies.push(repoPath(this.root, realpathSync(match)));
        } else result.errors.push("non-literal executable dependency");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
  }
}

/** One gate with independently selectable policies for synthetic graph tests. */
export function checkArchitectureBoundaries(root = ROOT, rules: readonly Rule[] = [
  "reserve-network", "frontend-routes", "verification-url", "stability-light", "telegram-public-surface",
]): string[] {
  // Entries and resolved dependencies use real paths; the root must share
  // their identity (for example macOS /var is a symlink to /private/var).
  root = realpathSync(resolve(root));
  const graph = new DependencyGraph(root);
  const violations = new Set<string>();
  const sources = (directory: string) => existsSync(resolve(root, directory))
    ? collectSourceFiles(resolve(root, directory), { extensions: SOURCE_EXTENSIONS })
      .filter((file) => !/\.(?:test|test-support|d)\.[cm]?[jt]sx?$/.test(file))
      .map((file) => repoPath(root, realpathSync(file)))
    : [];
  const walk = (rule: Rule, entries: string[], forbidden: (file: string) => boolean,
    network = false, gateways = new Set<string>()) => {
    if (entries.length === 0) violations.add(`${rule}: no entrypoints`);
    const visited = new Set<string>();
    const visit = (file: string, chain: string[]) => {
      const path = [...chain, file];
      if (forbidden(file)) violations.add(`${rule}: ${path.join(" -> ")}: forbidden dependency`);
      if (gateways.has(file) || visited.has(file)) return;
      visited.add(file);
      const resolved = graph.module(file);
      for (const error of resolved.errors) violations.add(`${rule}: ${path.join(" -> ")}: ${error}`);
      if (network && (resolved.network || NETWORK_PACKAGES.test(file.replace(/^package:/, "")))) {
        violations.add(`${rule}: ${path.join(" -> ")}: network capability`);
      }
      for (const dependency of resolved.dependencies) visit(dependency, path);
    };
    for (const entry of entries) visit(entry, []);
    return visited;
  };
  for (const rule of rules) {
    if (rule === "reserve-network") {
      // Existing adapters may use the vetted EVM RPC transport as well as the
      // two adapter request helpers. No new wrapper becomes a trusted gateway.
      const gateways = new Set([`${ADAPTERS}request.ts`, `${ADAPTERS}defillama.ts`, "worker/src/lib/evm-rpc.ts"]);
      walk(rule, sources(ADAPTERS).filter((file) => !gateways.has(file)),
        (file) => file === "worker/src/lib/fetch-retry.ts", true, gateways);
    } else if (rule === "frontend-routes") {
      walk(rule, ["src/components", "src/hooks", "src/lib"].flatMap(sources),
        (file) => file.startsWith("src/app/"));
      for (const directory of ["src/app/learn/case-studies/content", "src/app/learn/mechanisms/content"]) {
        for (const file of sources(directory)) {
          if (file !== `${directory}/index.ts`) violations.add(`${rule}: ${file}: route-owned content registry`);
        }
      }
    } else if (rule === "verification-url") {
      walk(rule, [SCRUBBER], (file) => /^package:zod(?:\/|$)/.test(file)
        || file.startsWith("shared/types/") || file.startsWith("shared/contracts/"));
      const reachable = walk(rule, ["src/components/google-analytics.tsx"], () => false);
      if (!reachable.has(SCRUBBER)) violations.add(`${rule}: google-analytics must reach ${SCRUBBER}`);
    } else if (rule === "stability-light") {
      walk(rule, [LIGHT], (file) => /^package:zod(?:\/|$)/.test(file)
        || file === "shared/types/stability.ts" || file.startsWith("shared/types/stability/"));
    } else if (rule === "telegram-public-surface") {
      const entries = sources("worker/src").filter((file) => !file.startsWith("worker/src/test-helpers/"));
      if (entries.length === 0) violations.add(`${rule}: no entrypoints`);
      for (const file of entries) {
        if (TELEGRAM_IMPLEMENTATION.test(file)) continue;
        // This is a direct authored-edge rule, not a transitive ban: legitimate
        // entries may reach implementation details inside either Telegram owner.
        const resolved = graph.module(file, true);
        for (const error of resolved.errors) violations.add(`${rule}: ${file}: ${error}`);
        for (const dependency of resolved.dependencies) {
          if (TELEGRAM_IMPLEMENTATION.test(dependency) && !TELEGRAM_PUBLIC_PAIRS[`${file} -> ${dependency}`]) {
            violations.add(`${rule}: ${file} -> ${dependency}: forbidden dependency`);
          }
        }
      }
    }
  }
  return [...violations].sort();
}

runDirectCli(import.meta.url, () => {
  const violations = checkArchitectureBoundaries();
  if (violations.length) {
    console.error(`Architecture boundaries failed:\n${violations.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Architecture boundaries: OK (6 resolved-dependency policies)");
  process.exitCode = 0;
});
