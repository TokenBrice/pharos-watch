import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertIsolateLocalStateRegistryComplete,
  findModuleStateDeclarations,
  findUnregisteredIsolateLocalState,
  listStateScanFiles,
  matchesCandidatePrefilter,
} from "../lib/isolate-local-state-registry-check";
import {
  ISOLATE_LOCAL_STATE_REGISTRY,
} from "@shared/lib/isolate-local-state-registry";
import { createTempRepoTracker } from "./helpers/test-state";

const roots = createTempRepoTracker("isolate-state");
afterEach(() => roots.cleanup());

const root = resolve(import.meta.dirname, "../..");

function moduleLevelDeclarations(sourcePath: string): Set<string> {
  const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  function collectName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectName(element.name);
    }
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) collectName(declaration.name);
    }
  }
  return names;
}

describe("isolate-local state registry", () => {
  it("requires every registered state name to remain a module-level declaration in its source", () => {
    const staleEntries: string[] = [];
    for (const entry of ISOLATE_LOCAL_STATE_REGISTRY) {
      const declarations = moduleLevelDeclarations(resolve(root, entry.sourcePath));
      for (const name of entry.stateNames) {
        if (!declarations.has(name)) staleEntries.push(`${entry.sourcePath}: ${name}`);
      }
    }
    expect(staleEntries, `Stale isolate-local state entries:\n${staleEntries.join("\n")}`).toEqual([]);
  });

  it("does not count comments, imports or function-local variables as module-level state", () => {
    const fixtureRoot = roots.makeRoot();
    roots.writeText(fixtureRoot, "state.ts", `
      import { importedCache } from "./elsewhere";
      // const removedCache = new Map();
      export const moduleCache = new Map();
      let { pending, nested: [queue] } = getState();
      function update() { const localCache = new Map(); }
    `);
    expect([...moduleLevelDeclarations(resolve(fixtureRoot, "state.ts"))]).toEqual(["moduleCache", "pending", "queue"]);
  });

  it("detects mutation calls, assignments, increments and recorder factories but excludes local and immutable values", () => {
    const root = roots.makeRoot();
    roots.writeText(root, "state.ts", `
      const cache = new Map(); const members = new Set(); const queue = [];
      let count = 0; let pending = null; const state = {};
      const recorder = createBufferedAttributionRecorder();
      const crossRequestCache =
        {};
      const immutable = new Map(); const settings = { limit: 5 };
      const plain = 1; let retryBudget = 0;
      function update() {
        cache.set("a", 1); cache.delete("a"); cache.clear(); members.add("a"); queue.push(1);
        count++; ++count; pending = Promise.resolve(); state["value"] = 1;
        crossRequestCache["hit"] = true; retryBudget = 3;
        const localCache = new Map(); localCache.set("a", 1);
        return immutable.get(settings.limit);
      }
    `);
    expect(findUnregisteredIsolateLocalState([], { root, sourceFiles: [resolve(root, "state.ts")] }))
      .toEqual(["cache", "members", "queue", "count", "pending", "state", "recorder", "crossRequestCache", "retryBudget"]
        .map((stateName) => ({ sourcePath: "state.ts", stateName })));
  });

  it.each([
    ["a type annotation", "const responseCache: Record<string, number> = {};"],
    ["an object type annotation", "const responseCache: { hit: number; miss: number } = {};"],
    ["an arrow-function type annotation", "const responseCache: Map<string, (value: number) => string> = {};"],
    ["a multi-line generic type annotation", "const responseCache: Record<\n        string,\n        number\n      > = {};"],
    ["a comment before the literal", "const responseCache = /* seeded */ {};"],
    ["a line comment before the literal", "const responseCache =\n        // seeded\n        {};"],
    ["a line break before the literal", "const responseCache =\n        {};"],
    ["a comment before the `=`", "const responseCache /* seeded */ = {};"],
    ["a second declaration on the same line", "const seeded = 1; let responseCache = loadCache();"],
    // Statement starts the column-0 anchor used to miss: a comment between
    // `export` and the keyword, and a declaration that follows another
    // statement or a block boundary on the same line.
    ["a comment between `export` and the keyword", "export /* seeded */ const responseCache = new Map();"],
    ["a comment between `export` and `let`", "export /* seeded */ let responseCache = loadCache();"],
    ["a leading comment before `let`", "/* seeded */ let responseCache = loadCache();"],
    ["a preceding statement on the same line", "seed(); const responseCache = new Map();"],
    ["a preceding block on the same line", "if (seed) { seed(); } const responseCache = new Map();"],
  ])("detects a stateful declaration with %s", (_label, declaration) => {
    const root = roots.makeRoot();
    roots.writeText(root, "state.ts", `
      ${declaration}
      function update() { responseCache["hit"] = true; }
    `);
    expect(findUnregisteredIsolateLocalState([], { root, sourceFiles: [resolve(root, "state.ts")] }))
      .toEqual([{ sourcePath: "state.ts", stateName: "responseCache" }]);
  });

  it("detects an object type body written without indentation", () => {
    // The type body's lines sit in column 0, where the statement-end heuristic
    // used to stop after `hit: number;` before reaching the initializer.
    const root = roots.makeRoot();
    roots.writeText(root, "state.ts", [
      "const responseCache: {",
      "hit: number;",
      "miss: number;",
      "} = {};",
      'function update() { responseCache["hit"] = true; }',
      "",
    ].join("\n"));
    expect(findUnregisteredIsolateLocalState([], { root, sourceFiles: [resolve(root, "state.ts")] }))
      .toEqual([{ sourcePath: "state.ts", stateName: "responseCache" }]);
  });

  it("suppresses only the exact registered source path and state name", () => {
    const root = roots.makeRoot();
    for (const file of ["a.ts", "b.ts"]) roots.writeText(root, file, `
      const cache = new Map(); const otherCache = new Map();
      function update() { cache.set("a", 1); otherCache.set("b", 2); }
    `);
    const entry = { ...ISOLATE_LOCAL_STATE_REGISTRY[0]!, sourcePath: "a.ts", stateNames: ["cache"] };
    expect(findUnregisteredIsolateLocalState([entry], { root, sourceFiles: ["a.ts", "b.ts"].map((file) => resolve(root, file)) }))
      .toEqual([
        { sourcePath: "a.ts", stateName: "otherCache" },
        { sourcePath: "b.ts", stateName: "cache" },
        { sourcePath: "b.ts", stateName: "otherCache" },
      ]);
  });
  it("rejects an unregistered module-scope state fixture", () => {
    const fixture = resolve(import.meta.dirname, "fixtures/isolate-local-state-unregistered.ts");

    expect(findUnregisteredIsolateLocalState(ISOLATE_LOCAL_STATE_REGISTRY, { root, sourceFiles: [fixture] })).toEqual([
      {
        sourcePath: "scripts/__tests__/fixtures/isolate-local-state-unregistered.ts",
        stateName: "unregisteredFixtureCache",
      },
    ]);
    expect(() => assertIsolateLocalStateRegistryComplete(ISOLATE_LOCAL_STATE_REGISTRY, { root, sourceFiles: [fixture] })).toThrow(
      "Unregistered isolate-local module state",
    );
  });

  it("covers all real Worker and Pages isolate-local module state", () => {
    expect(findUnregisteredIsolateLocalState(ISOLATE_LOCAL_STATE_REGISTRY, { root })).toEqual([]);
  }, 15_000);

  it("prefilters a strict superset of the files the AST pass reports state in", () => {
    const files = listStateScanFiles(root);
    const dropped: string[] = [];
    let admitted = 0;
    for (const file of files) {
      const prefiltered = matchesCandidatePrefilter(readFileSync(file, "utf8"));
      if (prefiltered) admitted += 1;
      // The prefilter is the only thing standing between untracked module state
      // and a green guard, so it is only allowed to skip files the AST pass
      // agrees hold no state - declared and mutated or not.
      else if (findModuleStateDeclarations(root, file).length > 0) dropped.push(relative(root, file));
    }
    expect(dropped, `Files with module state the prefilter drops:\n${dropped.join("\n")}`).toEqual([]);
    // Parsing the admitted files is what the guard costs, so keep them rare. A
    // stateful-module wave legitimately raises this; 0.5 still catches a
    // prefilter that has stopped narrowing at all.
    expect(admitted / files.length).toBeLessThan(0.5);
  }, 15_000);

});
