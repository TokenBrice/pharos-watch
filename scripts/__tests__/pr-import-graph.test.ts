import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrImportGraph,
  collectExecutableTestCandidates,
  collectExecutableTestFiles,
  collectModuleSpecifiers,
  isStablecoinCatalogDataOnly,
  planPrTestSelection,
  resolveModuleSpecifier,
  selectDirectImporters,
  selectImportGraphTests,
} from "../lib/pr-import-graph.mts";
import { cachedGlobMatcher, compileGlobMatcher } from "../lib/glob-matcher.mts";
import { EXECUTABLE_TEST_PROJECTS } from "../lib/critical-ownership.mts";
import { VITEST_SETUP_FILES } from "../lib/vitest-setup-files.mts";
import { isNightlyTestFile } from "../lib/nightly-test-tier.mts";
import { compareCommitSelections, incomparableCommit, summarizeParityFailures } from "../ci/check-test-plan-parity";
import { withTempRepo } from "./helpers/test-state";

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
    readdirSync: (path: string) => {
      const directory = relativePath(path).replace(/\/$/, "");
      const prefix = directory ? `${directory}/` : "";
      const entries = new Map<string, boolean>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
      }
      return [...entries].map(([name, isDirectory]) => ({
        name,
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
      }));
    },
  };
}

/** Minimal checkout: package imports, an alias target, a re-export barrel and a JSON module. */
const BASE_FILES: Record<string, string> = {
  "vitest.config.ts": "export default {};\n",
  "scripts/test/ensure-fresh-stablecoin-artifacts.ts": "export {};\n",
  "scripts/test/prepare-latest-schema-sqlite-template.ts": "export {};\n",
  "worker/src/test-helpers/setup-shared-isolation.ts": "export {};\n",
  "src/test/setup.ts": "export {};\n",
  "package.json": JSON.stringify({ imports: { "#catalog": "./shared/lib/catalog.ts" } }),
  "node_modules/zod/package.json": "{}",
  "node_modules/@scope/pkg/package.json": "{}",
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
    expect(resolveModuleSpecifier("@scope/pkg/subpath", "scripts/x.test.ts", options)).toEqual({ kind: "external" });
    expect(resolveModuleSpecifier("node:fs", "scripts/x.test.ts", options)).toEqual({ kind: "external" });
    expect(resolveModuleSpecifier("./missing", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    expect(resolveModuleSpecifier("#unknown", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    expect(resolveModuleSpecifier("../../../outside", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    // A new alias or a package that is not installed is not silently external:
    // it falls back to Vitest instead of dropping the edge.
    expect(resolveModuleSpecifier("@scope/unconfigured", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
    expect(resolveModuleSpecifier("not-installed-package", "scripts/x.test.ts", options)).toMatchObject({ kind: "unresolved" });
  });

  it("selects whole-universe reruns for toolchain inputs and planner sources", () => {
    const graph = build();
    for (const changed of [
      "package.json", "worker/package.json", "tsconfig.json", "vitest.config.ts", "src/test/setup.ts", "scripts/test/helper.ts",
      "scripts/lib/pr-import-graph.mts", "scripts/lib/pr-test-selection.mts", "scripts/lib/pr-test-plan.mts",
      "scripts/maintenance/run-pr-tests.ts", "scripts/lib/critical-ownership.mts", "scripts/lib/critical-test-files.mts",
      "scripts/lib/doc-ownership-registry.mts", "docs/doc-ownership.json", "scripts/lib/glob-matcher.mts",
      "scripts/lib/nightly-test-tier.mts",
      ...VITEST_SETUP_FILES,
    ]) {
      expect(planPrTestSelection([changed], { graph }), changed).toEqual({ files: TEST_FILES, mode: "closure" });
    }
  });

  it("compiles the executable-test globs once with the same semantics as path.matchesGlob", () => {
    const files = [
      "src/a.test.ts", "src/a.test.tsx", "src/a.spec.mts", "src/nested/a.test.js",
      "worker/src/a.test.ts", "worker/src/nested/a.spec.mts",
      "scripts/a.test.ts", "shared/lib/a.spec.tsx", "functions/a.test.ts",
      "src/a.ts", "worker/src/a.ts", "scripts/a.mts", "src/__tests__/a.test.ts",
    ];
    for (const project of EXECUTABLE_TEST_PROJECTS) {
      for (const pattern of [...project.include, ...project.exclude]) {
        const matcher = compileGlobMatcher(pattern);
        for (const file of files) expect(matcher(file), `${pattern} vs ${file}`).toBe(matchesGlob(file, pattern));
        // Selection asks these patterns about every candidate and every selected
        // file; a fresh minimatch parse per call is what made that quadratic.
        expect(cachedGlobMatcher(pattern)).toBe(cachedGlobMatcher(pattern));
        for (const file of files) expect(cachedGlobMatcher(pattern)(file), `${pattern} vs ${file}`).toBe(matchesGlob(file, pattern));
      }
    }
  });

  it("delegates glob syntax the compiler does not model to path.matchesGlob instead of escaping it", () => {
    const cases: readonly [string, readonly string[], readonly string[]][] = [
      ["src/**/+(a|b).test.ts", ["src/a.test.ts", "src/aa.test.ts"], ["src/c.test.ts"]],
      ["src/**/@(a|b).test.ts", ["src/a.test.ts", "src/b.test.ts"], ["src/c.test.ts"]],
      ["src/**/!(a).test.ts", ["src/b.test.ts"], ["src/a.test.ts"]],
      ["src/**/*(a).test.ts", ["src/a.test.ts", "src/aa.test.ts"], ["src/c.test.ts"]],
      ["src/**/[!a].test.ts", ["src/b.test.ts"], ["src/a.test.ts"]],
      ["src/**/{a,{b,c}}.test.ts", ["src/a.test.ts", "src/b.test.ts"], ["src/d.test.ts"]],
    ];
    for (const [pattern, matching, rejected] of cases) {
      const matcher = compileGlobMatcher(pattern);
      for (const file of matching) expect(matcher(file), `${pattern} vs ${file}`).toBe(true);
      for (const file of rejected) expect(matcher(file), `${pattern} vs ${file}`).toBe(false);
      for (const file of [...matching, ...rejected]) expect(matcher(file), `${pattern} vs ${file}`).toBe(matchesGlob(file, pattern));
    }
  });

  it("partitions the real candidate universe exactly like path.matchesGlob", () => {
    const candidates = collectExecutableTestCandidates();
    const universe = new Set(collectExecutableTestFiles());
    const patterns = [...new Set(EXECUTABLE_TEST_PROJECTS.flatMap((project) => [...project.include, ...project.exclude]))];
    expect(candidates.length).toBeGreaterThan(1000);
    // Glob patterns select exactly the `matchesGlob` set over every real candidate.
    for (const pattern of patterns.filter((value) => /[*?[{]/.test(value))) {
      const matcher = compileGlobMatcher(pattern);
      expect(candidates.filter((file) => matcher(file)), pattern).toEqual(candidates.filter((file) => matchesGlob(file, pattern)));
    }
    // Literal entries (the isolated/threaded/shared file lists) stay in the
    // universe and match nothing else, without 250 full-universe passes.
    // Nightly-tier files run in the execution projects but sit outside the
    // planner universe, so a literal may name one.
    for (const pattern of patterns.filter((value) => !/[*?[{]/.test(value))) {
      expect(universe.has(pattern) || (isNightlyTestFile(pattern) && candidates.includes(pattern)), pattern).toBe(true);
      const matcher = compileGlobMatcher(pattern);
      for (const file of [pattern, pattern.replace(/\.(test|spec)\./, ".$1-x."), `${pattern}.bak`, `nested/${pattern}`]) {
        expect(matcher(file), `${pattern} vs ${file}`).toBe(matchesGlob(file, pattern));
      }
    }
  });

  it("keeps nightly-tier files in the execution projects but out of the planner universe", () => {
    withTempRepo("pharos-nightly-universe", {
      "src/__tests__/owner.test.ts": "it(\"owner\", () => {});\n",
      "src/__tests__/sweep.nightly.test.ts": "it(\"sweep\", () => {});\n",
      "scripts/__tests__/guard.nightly.test.ts": "it(\"guard\", () => {});\n",
    }, (cwd) => {
      // `npm test`/nightly enumerate the candidate set, so the files still run there.
      expect(collectExecutableTestCandidates(cwd)).toEqual([
        "scripts/__tests__/guard.nightly.test.ts",
        "src/__tests__/owner.test.ts",
        "src/__tests__/sweep.nightly.test.ts",
      ]);
      expect(collectExecutableTestFiles(cwd)).toEqual(["src/__tests__/owner.test.ts"]);
    });
  });

  it("selects every file matched by a template-literal dynamic import", () => {
    const files = {
      ...BASE_FILES,
      "shared/lib/stablecoins/client-detail.ts": "export const load = async (id: string) => import(`../../data/stablecoins/coins.client.detail/${id}.generated.json`);\n",
      "shared/data/stablecoins/coins.client.detail/usdc.generated.json": "{\"id\":\"usdc\"}\n",
      "shared/data/stablecoins/coins.client.detail/usdt.generated.json": "{\"id\":\"usdt\"}\n",
      "scripts/__tests__/client-detail.test.ts": "import { load } from \"@shared/lib/stablecoins/client-detail\";\nit(\"detail\", () => load);\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    for (const changed of [
      "shared/data/stablecoins/coins.client.detail/usdc.generated.json",
      "shared/data/stablecoins/coins.client.detail/usdt.generated.json",
    ]) {
      expect(selectImportGraphTests(graph, [changed])).toEqual(["scripts/__tests__/client-detail.test.ts"]);
    }
  });

  it("selects every file matched by import.meta.glob", () => {
    const files = {
      ...BASE_FILES,
      "scripts/lib/globbed.ts": "export const modules = import.meta.glob(\"../fixtures/*.json\");\n",
      "scripts/fixtures/a.json": "{\"id\":\"a\"}\n",
      "scripts/fixtures/b.json": "{\"id\":\"b\"}\n",
      "scripts/fixtures/ignored.txt": "not a match\n",
      "scripts/__tests__/globbed.test.ts": "import { modules } from \"../lib/globbed\";\nit(\"glob\", () => modules);\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(selectImportGraphTests(graph, ["scripts/fixtures/a.json"])).toEqual(["scripts/__tests__/globbed.test.ts"]);
    expect(selectImportGraphTests(graph, ["scripts/fixtures/ignored.txt"])).toEqual([]);
  });

  it("falls back when a template or glob pattern has no usable static directory prefix", () => {
    const files = {
      ...BASE_FILES,
      "src/lib/dynamic.ts": "export const load = async (name: string) => import(`${name}.json`);\n",
      "src/lib/glob-any.ts": "export const modules = import.meta.glob(\"**/*.json\");\n",
      "scripts/__tests__/dynamic.test.ts": "import { load } from \"@/lib/dynamic\";\nit(\"dynamic\", () => load);\n",
      "scripts/__tests__/glob-any.test.ts": "import { modules } from \"@/lib/glob-any\";\nit(\"glob\", () => modules);\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(graph.unresolved.join("\n")).toContain("without a static directory prefix");
    const selection = planPrTestSelection(["shared/lib/registry.ts"], { graph });
    expect(selection.files).toEqual([]);
    expect(selection.fallback).toContain("unresolved local specifier");
  });

  it("marks a file with an unterminated literal unresolved instead of dropping later imports", () => {
    const cases: readonly [string, string, string][] = [
      ["template", "scripts/__tests__/unterminated-template.test.ts", "const value = `open\nimport { registry } from \"@shared/lib/registry\";\n"],
      ["string", "scripts/__tests__/unterminated-string.test.ts", "const value = \"open"],
      ["regex", "scripts/__tests__/unterminated-regex.test.ts", "const value = /open"],
    ];
    for (const [kind, testFile, source] of cases) {
      const files = { ...BASE_FILES, [testFile]: source };
      const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
      const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
      expect(graph.unresolved.join("\n"), kind).toContain(`unterminated ${kind === "regex" ? "regular expression" : kind === "string" ? "string literal" : "template literal"}`);
      expect(planPrTestSelection(["shared/lib/registry.ts"], { graph }).fallback, kind).toContain("unresolved local specifier");
    }
  });

  it("does not treat nested templates or expression regexes as unterminated", () => {
    const files = {
      ...BASE_FILES,
      "worker/scripts/nested.ts": "const a = `${sqlString(`x`)}`;\nconst b = `'${value.replace(/'/g, \"''\")}'`;\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(graph.unresolved).toEqual([]);
  });

  it("reports selection parity, skips data-only routing and rejects a vacuous Vite result", () => {
    expect(compareCommitSelections("data-only", ["scripts/a.test.ts"], ["scripts/b.test.ts"])).toMatchObject({
      skipped: "data-only", missing: [], vacuous: false, comparable: false, unproven: false,
    });
    expect(compareCommitSelections("closure", ["scripts/a.test.ts"], [])).toMatchObject({ vacuous: true, missing: [], comparable: true });
    expect(compareCommitSelections("closure", ["scripts/a.test.ts"], ["scripts/b.test.ts"])).toMatchObject({
      missing: ["scripts/b.test.ts"], vacuous: false, comparable: true,
    });
    expect(compareCommitSelections("closure", [], [])).toMatchObject({ vacuous: false, comparable: false, unproven: false });
  });

  it("fails a parity run that compares nothing or drops a changed executable test", () => {
    const result = (commit: string, comparison: ReturnType<typeof compareCommitSelections>) => ({
      commit, parent: `${commit}^`, changed: 1, ...comparison,
    });
    const compared = result("a".repeat(40), compareCommitSelections("closure", ["scripts/a.test.ts"], ["scripts/a.test.ts"]));
    expect(summarizeParityFailures([compared])).toEqual([]);
    // A changed executable test that neither side selects is missing evidence.
    const unproven = result("b".repeat(40), compareCommitSelections("closure", [], [], 1));
    expect(unproven.unproven).toBe(true);
    expect(summarizeParityFailures([compared, unproven]).join("\n")).toContain("changed executable test(s) selected nothing");
    // Empty comparisons and data-only skips prove nothing, however many run.
    const empty = result("c".repeat(40), compareCommitSelections("closure", [], []));
    const dataOnly = result("d".repeat(40), compareCommitSelections("data-only", ["scripts/a.test.ts"], []));
    expect(summarizeParityFailures([empty, dataOnly]).join("\n")).toContain("compared no non-vacuous selection across 2 commit(s)");
    // A single real comparison keeps an otherwise empty window valid.
    expect(summarizeParityFailures([empty, dataOnly, compared])).toEqual([]);
  });

  it("reports a commit the current planner cannot plan as not comparable", () => {
    const compared = {
      commit: "a".repeat(40), parent: `${"a".repeat(40)}^`, changed: 1,
      ...compareCommitSelections("closure", ["scripts/a.test.ts"], ["scripts/a.test.ts"]),
    };
    const fellBack = incomparableCommit("c".repeat(40), `${"c".repeat(40)}^`, 2, "closure", "2 unresolved local specifier(s): a; b");
    expect(fellBack).toMatchObject({
      fallback: "2 unresolved local specifier(s): a; b", comparable: false, missing: [], vacuous: false, unproven: false,
    });
    // A fallback commit is missing evidence, never a parity pass: it does not
    // fail a run that compared something, and it cannot carry a run alone.
    expect(summarizeParityFailures([compared, fellBack])).toEqual([]);
    expect(summarizeParityFailures([fellBack]).join("\n")).toContain("compared no non-vacuous selection across 1 commit(s)");
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

  it("routes catalog data through one wrapper module and stops at two hops", () => {
    const files = {
      ...BASE_FILES,
      "shared/data/stablecoins/frozen-snapshots.json": "{\"snapshots\":[]}\n",
      "shared/lib/frozen-snapshots.ts": "import snapshots from \"@shared/data/stablecoins/frozen-snapshots.json\";\nexport const load = () => snapshots;\n",
      "shared/lib/frozen-snapshots-wrapper.ts": "import { load } from \"./frozen-snapshots\";\nexport const value = load;\n",
      "shared/lib/frozen-snapshots-deep.ts": "import { value } from \"./frozen-snapshots-wrapper\";\nexport const deep = value;\n",
      "scripts/__tests__/frozen-snapshots.test.ts": "import { load } from \"@shared/lib/frozen-snapshots\";\nit(\"wrapper\", () => load);\n",
      "scripts/__tests__/frozen-snapshots-deep.test.ts": "import { deep } from \"@shared/lib/frozen-snapshots-deep\";\nit(\"deep\", () => deep);\n",
    };
    const testFiles = Object.keys(files).filter((file) => /\.test\.ts$/.test(file)).sort();
    const graph = buildPrImportGraph({ cwd: CWD, fs: fixtureFs(files), testFiles });
    expect(planPrTestSelection(["shared/data/stablecoins/frozen-snapshots.json"], { graph })).toEqual({
      files: ["scripts/__tests__/frozen-snapshots.test.ts"],
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
