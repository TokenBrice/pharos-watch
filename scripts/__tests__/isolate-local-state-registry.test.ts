import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIsolateLocalStateRegistryComplete,
  findUnregisteredIsolateLocalState,
} from "../lib/isolate-local-state-registry-check";
import {
  ISOLATE_LOCAL_STATE_REGISTRY,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";
import { createTempRepoTracker } from "./helpers/test-state";

const roots = createTempRepoTracker("isolate-state");
afterEach(() => roots.cleanup());

const root = resolve(import.meta.dirname, "../..");

describe("isolate-local state registry", () => {
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
    expect(() => assertIsolateLocalStateRegistryComplete(ISOLATE_LOCAL_STATE_REGISTRY, { root })).not.toThrow();
  }, 15_000);

  it("renders the checked Worker Infrastructure section", () => {
    expect(renderIsolateLocalStateDocumentation()).toContain("| Source | State | Owner | TTL / reset semantics | Durable truth |");
  });
});
