import { describe, expect, it } from "vitest";
import {
  buildPrImportGraph,
  collectModuleSpecifiers,
  isStablecoinCatalogDataOnly,
  planPrTestSelection,
  resolveModuleSpecifier,
  selectDirectImporters,
  selectImportGraphTests,
} from "../lib/pr-import-graph.mts";

const CWD = "/repo";

function fixtureFs(files: Record<string, string>) {
  const relativePath = (path: string): string => path.startsWith(`${CWD}/`) ? path.slice(CWD.length + 1) : path;
  return {
    existsSync: (path: string) => relativePath(path) in files,
    readFileSync: (path: string) => {
      const contents = files[relativePath(path)];
      if (contents === undefined) throw new Error(`fixture missing ${path}`);
      return contents;
    },
    statSync: (path: string) => ({ isFile: () => relativePath(path) in files }),
  };
}

/** Minimal checkout: package imports, an alias target, a re-export barrel and a JSON module. */
const BASE_FILES: Record<string, string> = {
  "vitest.config.ts": "export default {};\n",
  "package.json": JSON.stringify({ imports: { "#catalog": "./shared/lib/catalog.ts" } }),
  "shared/lib/catalog.ts": "export const catalog = [];\n",
  "shared/lib/registry.ts": "import { catalog } from \"./catalog\";\nexport const registry = catalog;\n",
  "shared/lib/barrel.ts": "export { registry } from \"./registry\";\n",
  "shared/data/stablecoins/coins/usdc.json": "{\"id\":\"usdc\"}\n",
  "src/components/badge.tsx": "import { registry } from \"@shared/lib/registry\";\nexport const Badge = () => registry;\n",
  "scripts/__tests__/registry.test.ts": "import { registry } from \"@shared/lib/registry\";\nit(\"registry\", () => {});\n",
  "scripts/__tests__/barrel.test.ts": "import { registry } from \"@shared/lib/barrel\";\nit(\"barrel\", () => {});\n",
  "scripts/__tests__/component.test.ts": "import { Badge } from \"@/components/badge\";\nit(\"component\", () => {});\n",
  "scripts/__tests__/json.test.ts": "import usdc from \"@shared/data/stablecoins/coins/usdc.json\";\nit(\"json\", () => {});\n",
  "scripts/__tests__/types-only.test.ts": "import type { Registry } from \"@shared/lib/registry\";\nit(\"types\", () => {});\n",
  "scripts/__tests__/inline-type.test.ts": "import { type Registry } from \"@shared/lib/registry\";\nit(\"inline\", () => {});\n",
  "scripts/__tests__/mock-only.test.ts": "vi.mock(\"@/components/badge\");\nit(\"mock\", () => {});\n",
  "scripts/__tests__/dynamic.test.ts": "const module = await import(\"@/components/badge\");\nit(\"dynamic\", () => module);\n",
};

const TEST_FILES = Object.keys(BASE_FILES).filter((file) => /\.test\.ts$/.test(file)).sort();

function build(files: Record<string, string> = BASE_FILES) {
  return buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles: TEST_FILES });
}

describe("static import-graph PR test selection", () => {
  it("selects every test whose transitive closure reaches a changed module", () => {
    const graph = build();
    expect(selectImportGraphTests(graph, ["shared/lib/catalog.ts"])).toEqual([
      "scripts/__tests__/barrel.test.ts",
      "scripts/__tests__/component.test.ts",
      "scripts/__tests__/dynamic.test.ts",
      "scripts/__tests__/registry.test.ts",
    ]);
    expect(selectImportGraphTests(graph, ["shared/lib/registry.ts"])).toEqual([
      "scripts/__tests__/barrel.test.ts",
      "scripts/__tests__/component.test.ts",
      "scripts/__tests__/dynamic.test.ts",
      "scripts/__tests__/registry.test.ts",
    ]);
    expect(selectImportGraphTests(graph, ["shared/lib/barrel.ts"])).toEqual(["scripts/__tests__/barrel.test.ts"]);
  });

  it("selects a changed test file itself and a direct dynamic import", () => {
    const graph = build();
    expect(selectImportGraphTests(graph, ["scripts/__tests__/registry.test.ts"])).toEqual(["scripts/__tests__/registry.test.ts"]);
    expect(selectImportGraphTests(graph, ["src/components/badge.tsx"])).toContain("scripts/__tests__/dynamic.test.ts");
  });

  it("ignores type-only imports and vi.mock specifiers, which the runtime erases", () => {
    const graph = build();
    const typesOnly = selectImportGraphTests(graph, ["shared/lib/registry.ts"]);
    expect(typesOnly).not.toContain("scripts/__tests__/types-only.test.ts");
    expect(typesOnly).not.toContain("scripts/__tests__/inline-type.test.ts");
    expect(selectImportGraphTests(graph, ["src/components/badge.tsx"])).not.toContain("scripts/__tests__/mock-only.test.ts");
  });

  it("keeps declaration, dynamic and re-export forms distinct when reading a module", () => {
    const cases: readonly [string, string[]][] = [
      ['import { a } from "./a";', ["./a"]],
      ['import type { a } from "./a";', []],
      ['import { type a } from "./a";', []],
      ['import { type a, b } from "./a";', ["./a"]],
      ['export { a } from "./a";', ["./a"]],
      ['export type { a } from "./a";', []],
      ['export { type a } from "./a";', []],
      ['export * from "./a";', ["./a"]],
      ['export * as ns from "./a";', ["./a"]],
      ['import "./side-effect";', ["./side-effect"]],
      ['const module = await import("./dynamic");', ["./dynamic"]],
      ['vi.mock("./mocked");', []],
      ['// import x from "./commented";', []],
      ['const text = "import x from \\"./string\\"";', []],
    ];
    for (const [source, expected] of cases) expect(collectModuleSpecifiers(source).specifiers).toEqual(expected);
  });

  it("resolves runtime aliases, package imports, re-exports, JSON and index files", () => {
    const fs = fixtureFs({
      ...BASE_FILES,
      "scripts/lib/index.ts": "export {};\n",
      "scripts/lib/helper.mjs": "export const helper = 1;\n",
    });
    const options = { cwd: CWD, fs };
    expect(resolveModuleSpecifier("@/components/badge.tsx", "scripts/x.test.ts", options)).toEqual({ kind: "file", file: "src/components/badge.tsx" });
    expect(resolveModuleSpecifier("@shared/lib/registry", "scripts/x.test.ts", options)).toEqual({ kind: "file", file: "shared/lib/registry.ts" });
    expect(resolveModuleSpecifier("./helper.mjs", "scripts/lib/runner.ts", options)).toEqual({ kind: "file", file: "scripts/lib/helper.mjs" });
    expect(resolveModuleSpecifier("#catalog", "scripts/x.test.ts", options)).toEqual({ kind: "file", file: "shared/lib/catalog.ts" });
    expect(resolveModuleSpecifier("../lib", "scripts/__tests__/x.test.ts", options)).toEqual({ kind: "file", file: "scripts/lib/index.ts" });
    expect(resolveModuleSpecifier("zod", "scripts/x.test.ts", options)).toEqual({ kind: "external" });
    expect(resolveModuleSpecifier("./missing", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    expect(resolveModuleSpecifier("#unknown", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    expect(resolveModuleSpecifier("../../../outside", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
  });

  it("selects whole-universe reruns for toolchain inputs", () => {
    const graph = build();
    for (const changed of ["package.json", "worker/package.json", "tsconfig.json", "vitest.config.ts", "src/test/setup.ts", "scripts/test/helper.ts"]) {
      expect(planPrTestSelection([changed], { graph })).toEqual({ files: TEST_FILES, mode: "closure" });
    }
  });

  it("routes stablecoin catalog data to direct catalog/registry owners instead of the closure", () => {
    const graph = build();
    expect(isStablecoinCatalogDataOnly(["shared/data/stablecoins/coins/usdc.json"])).toBe(true);
    expect(planPrTestSelection(["shared/data/stablecoins/coins/usdc.json"], { graph })).toEqual({
      files: ["scripts/__tests__/json.test.ts"],
      mode: "data-only",
    });
    expect(selectDirectImporters(graph, ["shared/data/stablecoins/coins/usdc.json"])).toEqual(["scripts/__tests__/json.test.ts"]);
    // Code and other data families keep the full closure.
    expect(isStablecoinCatalogDataOnly(["shared/data/stablecoins/coins/usdc.json", "shared/lib/registry.ts"])).toBe(false);
    expect(isStablecoinCatalogDataOnly(["shared/data/safety-score-v9/policy.json"])).toBe(false);
    expect(planPrTestSelection(["shared/lib/registry.ts"], { graph }).mode).toBe("closure");
    expect(planPrTestSelection(["shared/lib/registry.ts"], { graph }).files).toEqual([
      "scripts/__tests__/barrel.test.ts",
      "scripts/__tests__/component.test.ts",
      "scripts/__tests__/dynamic.test.ts",
      "scripts/__tests__/registry.test.ts",
    ]);
  });

  it("directly imports changed catalog data and the catalog entry modules only, not their closure", () => {
    const files = {
      ...BASE_FILES,
      "shared/data/stablecoins/coins/usdc.json": "{\"id\":\"usdc\"}\n",
      "shared/lib/stablecoins/registry.ts": "export const registry = [];\n",
      "shared/lib/stablecoins/full-catalog.ts": "export default [];\n",
      "scripts/lib/stablecoin-catalog-sources.ts": "export const sources = [];\n",
      "scripts/__tests__/catalog-entry.test.ts": "import { registry } from \"@shared/lib/stablecoins/registry\";\nit(\"entry\", () => {});\n",
      "scripts/__tests__/stablecoins-deep.test.ts": "import { entry } from \"@/components/entry\";\nit(\"deep\", () => {});\n",
      "src/components/entry.ts": "import { registry } from \"@shared/lib/stablecoins/registry\";\nexport const entry = registry;\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(planPrTestSelection(["shared/data/stablecoins/coins/usdc.json"], { graph })).toEqual({
      files: ["scripts/__tests__/catalog-entry.test.ts", "scripts/__tests__/json.test.ts"],
      mode: "data-only",
    });
  });

  it("reports a fallback when a reachable local specifier cannot be resolved", () => {
    const files = {
      ...BASE_FILES,
      "scripts/__tests__/broken.test.ts": "import missing from \"@/components/missing\";\nit(\"broken\", () => {});\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(graph.unresolved).toHaveLength(1);
    const selection = planPrTestSelection(["shared/lib/registry.ts"], { graph });
    expect(selection.files).toEqual([]);
    expect(selection.fallback).toContain("unresolved local specifier");
    expect(selection.fallback).toContain("@/components/missing");
  });
});
