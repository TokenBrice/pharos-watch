import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIsolateLocalStateRegistryComplete,
  findUnregisteredIsolateLocalState,
} from "../lib/isolate-local-state-registry-check";
import {
  ISOLATE_LOCAL_STATE_REGISTRY,
  renderIsolateLocalStateDocumentation,
} from "../../shared/lib/isolate-local-state-registry";

const root = resolve(import.meta.dirname, "../..");

describe("isolate-local state registry", () => {
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
