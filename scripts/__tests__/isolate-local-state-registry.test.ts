import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertIsolateLocalStateRegistryComplete,
  findUnregisteredIsolateLocalState,
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
      const immutable = new Map(); const settings = { limit: 5 };
      function update() {
        cache.set("a", 1); cache.delete("a"); cache.clear(); members.add("a"); queue.push(1);
        count++; ++count; pending = Promise.resolve(); state["value"] = 1;
        const localCache = new Map(); localCache.set("a", 1);
        return immutable.get(settings.limit);
      }
    `);
    expect(findUnregisteredIsolateLocalState([], { root, sourceFiles: [resolve(root, "state.ts")] }))
      .toEqual(["cache", "members", "queue", "count", "pending", "state", "recorder"]
        .map((stateName) => ({ sourcePath: "state.ts", stateName })));
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

});
