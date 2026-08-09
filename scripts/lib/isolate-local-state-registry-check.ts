import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFiles } from "./source-files.mjs";
import { getScriptKind } from "./ts-ast.mjs";
import type { IsolateLocalStateRegistryEntry } from "../../shared/lib/isolate-local-state-registry";

export interface IsolateLocalStateCandidate {
  sourcePath: string;
  stateName: string;
}

const STATE_DIRECTORIES = ["worker/src", "shared/lib", "functions"];
const MUTABLE_CONSTRUCTOR = /new (?:Map|Set|WeakMap|WeakSet|IsolateLocalState)\b/;
const RECORDER_FACTORY = /createBufferedAttributionRecorder\b/;
const STATEFUL_CONTAINER_NAME = /(cache|counter|key|limiter|limit|state|promise|initialization|window|secret|queue|buffer|pending|inflight)/i;

const STATE_SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const STATE_SCAN_EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

function listSourceFiles(root: string, sourcePath: string): string[] {
  return collectSourceFiles(resolve(root, sourcePath), {
    extensions: STATE_SCAN_EXTENSIONS,
    excludedDirs: STATE_SCAN_EXCLUDED_DIRS,
  });
}

function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function isFunctionDescendant(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return true;
  }
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isStatefulInitializer(initializer: ts.Expression, name: string, isLet: boolean, source: ts.SourceFile): boolean {
  const text = initializer.getText(source);
  return MUTABLE_CONSTRUCTOR.test(text)
    || RECORDER_FACTORY.test(text)
    || ((ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
      && STATEFUL_CONTAINER_NAME.test(name))
    || isLet;
}

function isMutationOfCandidate(node: ts.Node, candidates: Map<string, boolean>): void {
  if (ts.isCallExpression(node) && isFunctionDescendant(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (["set", "add", "delete", "clear", "push", "reset"].includes(method)) {
      const name = rootIdentifier(node.expression.expression);
      if (name && candidates.has(name)) candidates.set(name, true);
    }
  }

  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && isFunctionDescendant(node)) {
    const name = rootIdentifier(node.left);
    if (name && candidates.has(name)) candidates.set(name, true);
  }

  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && isFunctionDescendant(node)) {
    const name = rootIdentifier(node.operand);
    if (name && candidates.has(name)) candidates.set(name, true);
  }
}

function findCandidatesInFile(root: string, file: string): IsolateLocalStateCandidate[] {
  const sourcePath = relative(root, file);
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(file),
  );
  const candidates = new Map<string, boolean>();

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (isStatefulInitializer(declaration.initializer, name, isLet, source)) {
        candidates.set(name, RECORDER_FACTORY.test(declaration.initializer.getText(source)));
      }
    }
  }

  const visit = (node: ts.Node): void => {
    isMutationOfCandidate(node, candidates);
    ts.forEachChild(node, visit);
  };
  visit(source);

  return [...candidates]
    .filter(([, isMutated]) => isMutated)
    .map(([stateName]) => ({ sourcePath, stateName }));
}

export function findUnregisteredIsolateLocalState(
  registry: readonly IsolateLocalStateRegistryEntry[],
  options: { root: string; sourceFiles?: readonly string[] },
): IsolateLocalStateCandidate[] {
  const files = options.sourceFiles ?? STATE_DIRECTORIES.flatMap((directory) => listSourceFiles(options.root, directory));
  const registered = new Set(
    registry.flatMap((entry) => entry.stateNames.map((stateName) => `${entry.sourcePath}:${stateName}`)),
  );

  return files
    .flatMap((file) => findCandidatesInFile(options.root, file))
    .filter((candidate) => !registered.has(`${candidate.sourcePath}:${candidate.stateName}`));
}

export function assertIsolateLocalStateRegistryComplete(
  registry: readonly IsolateLocalStateRegistryEntry[],
  options: { root: string; sourceFiles?: readonly string[] },
): void {
  const unregistered = findUnregisteredIsolateLocalState(registry, options);
  if (unregistered.length === 0) return;
  throw new Error(
    `Unregistered isolate-local module state:\n${unregistered
      .map((candidate) => `- ${candidate.sourcePath}: ${candidate.stateName}`)
      .join("\n")}`,
  );
}
