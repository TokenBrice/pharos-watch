import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BaseCoverageProvider } from "vitest/coverage";

import {
  assertExecutableTestFiles,
  collectOwningTests,
  collectWorkerSharedTestFiles,
  deriveBaseCriticalOwnership,
  deriveCriticalOwnership,
  EXECUTABLE_TEST_PROJECTS,
  hasModuleScopeMutableState,
  isWorkerSharedTestEligible,
  WORKER_SHARED_ISOLATED_OVERRIDES,
  WORKER_SHARED_TEST_FILES,
} from "../lib/critical-ownership.mts";
import installCriticalCoverageFilter from "../lib/critical-coverage-filter.mts";
import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("critical ownership derivation", () => {
  it("does not enroll mock-only references as executable ownership", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-ownership-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(join(cwd, "src/first.test.ts"), 'import { target } from "./target";\nvoid target;\n');
    writeFileSync(join(cwd, "src/second.test.ts"), 'vi.mock("./target");\n');

    const ownership = deriveCriticalOwnership({
      cwd,
      testFiles: ["src/first.test.ts", "src/second.test.ts"],
    });

    expect(ownership.get("src/target.ts")).toEqual(["src/first.test.ts"]);
  });

  it("maps quoted dynamic imports without treating expressions as paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-ownership-dynamic-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(
      join(cwd, "src/dynamic.test.ts"),
      'const loaded = await import("./target");\nvoid loaded;\n',
    );

    const ownership = deriveCriticalOwnership({
      cwd,
      testFiles: ["src/dynamic.test.ts"],
    });

    expect(ownership.get("src/target.ts")).toEqual(["src/dynamic.test.ts"]);
  });

  it("ignores comments, string contents, type-only imports and computed imports", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-syntax-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(join(cwd, "src/syntax.test.ts"), [
      '// import "./target";',
      '/* import("./target") */',
      'const text = \'import "./target";\';',
      'import type { Target } from "./target";',
      'import { type Target } from "./target";',
      'const computed = import("./target" + suffix);',
      'const variableImport = import(variable);',
    ].join("\n"));
    expect(deriveCriticalOwnership({ cwd }).has("src/target.ts")).toBe(false);
  });

  it("recovers the deleted owner's runtime imports from the base tree", () => {
    const source = "worker/src/lib/auth.ts";
    const test = "worker/src/lib/__tests__/removed.test.ts";
    const ownership = deriveBaseCriticalOwnership("base", [test], (_file, args) => {
      if (args[0] === "ls-tree") return `${source}\0${test}\0`;
      if (args[0] === "cat-file") {
        return `deadbeef blob 17\0import "../auth";\0`;
      }
      throw new Error(`Unexpected Git read: ${args.join(" ")}`);
    });
    expect(ownership.get(source)).toEqual([test]);
  });

  it("reads base blobs by byte length across embedded NUL and Unicode", () => {
    const tests = ["src/first.test.ts", "src/second.test.ts"];
    const bodies = ['// é\0hidden\nimport "./first";', 'import "./second";'];
    const ownership = deriveBaseCriticalOwnership("base", tests, (_file, args) => {
      if (args[0] === "ls-tree") return [...tests, "src/first.ts", "src/second.ts"].join("\0") + "\0";
      return Buffer.concat(bodies.map((body) => Buffer.from(`deadbeef blob ${Buffer.byteLength(body)}\0${body}\0`)));
    });
    expect(ownership.get("src/first.ts")).toEqual([tests[0]]);
    expect(ownership.get("src/second.ts")).toEqual([tests[1]]);
  });

  it("derives reverse owners through workspace exports using only injected filesystem data", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-workspace-"));
    temporaryDirectories.push(cwd);
    const files: Record<string, string> = {
      [join(cwd, "package.json")]: JSON.stringify({ workspaces: ["shared/local"] }),
      [join(cwd, "shared/local/package.json")]: JSON.stringify({
        name: "@fixture/local", exports: { "./public": "./public.ts" },
      }),
      [join(cwd, "shared/local/public.ts")]: "export const value = true;\n",
      [join(cwd, "shared/local/private.ts")]: "export const unused = true;\n",
      [join(cwd, "src/owner.test.ts")]: 'import { value } from "@fixture/local/public";\nvoid value;\n',
      [join(cwd, "src/types.test.ts")]: 'import type { Value } from "@fixture/local/public";\n',
      [join(cwd, "src/mock.test.ts")]: 'vi.mock("@fixture/local/public");\n',
    };
    const reads: string[] = [];
    const fsImpl = {
      existsSync: (path: string) => Object.hasOwn(files, path),
      readFileSync: (path: string) => {
        reads.push(path);
        if (!Object.hasOwn(files, path)) throw new Error(`Unexpected fixture read: ${path}`);
        return files[path];
      },
    };
    const ownership = deriveCriticalOwnership({
      cwd, fsImpl,
      testFiles: ["src/owner.test.ts", "src/types.test.ts", "src/mock.test.ts"],
      sourceFiles: ["shared/local/public.ts", "shared/local/private.ts"],
    });
    expect(ownership.get("shared/local/public.ts")).toEqual(["src/owner.test.ts"]);
    expect(ownership.has("shared/local/private.ts")).toBe(false);
    expect(collectOwningTests(["shared/local/public.ts"], ownership)).toEqual(["src/owner.test.ts"]);
    expect(reads.filter((path) => path.endsWith("package.json"))).toEqual([
      join(cwd, "package.json"), join(cwd, "shared/local/package.json"),
    ]);
  });

  it("does not hide an unknown workspace export in injected ownership analysis", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-private-"));
    temporaryDirectories.push(cwd);
    const files: Record<string, string> = {
      [join(cwd, "package.json")]: JSON.stringify({ workspaces: ["shared/local"] }),
      [join(cwd, "shared/local/package.json")]: JSON.stringify({
        name: "@fixture/local", exports: { "./public": "./public.ts" },
      }),
      [join(cwd, "src/owner.test.ts")]: 'import "@fixture/local/private";\n',
    };
    expect(() => deriveCriticalOwnership({
      cwd, testFiles: ["src/owner.test.ts"],
      fsImpl: {
        existsSync: (path) => Object.hasOwn(files, path),
        readFileSync: (path) => files[path],
      },
    })).toThrow(/Unresolved workspace export/);
  });

  it("reads workspace manifests from the base revision alongside deleted importing tests", () => {
    const test = "src/removed.test.ts";
    const source = "shared/local/public.ts";
    const blobs: Record<string, string> = {
      [test]: 'import { value } from "@fixture/local/public";\nvoid value;\n',
      "package.json": JSON.stringify({ workspaces: ["shared/local"] }),
      "shared/local/package.json": JSON.stringify({
        name: "@fixture/local", exports: { "./public": "./public.ts" },
      }),
    };
    const requests: string[][] = [];
    const ownership = deriveBaseCriticalOwnership("base", [test], (_file, args, options) => {
      if (args[0] === "ls-tree") return [...Object.keys(blobs), source].join("\0") + "\0";
      const paths = options.input!.split("\0").filter(Boolean).map((spec) => spec.slice("base:".length));
      requests.push(paths);
      return Buffer.concat(paths.map((path) => {
        const body = blobs[path];
        if (body === undefined) throw new Error(`Unexpected base blob: ${path}`);
        return Buffer.from(`deadbeef blob ${Buffer.byteLength(body)}\0${body}\0`);
      }));
    });
    expect(requests).toEqual([[test, "package.json", "shared/local/package.json"]]);
    expect(ownership.get(source)).toEqual([test]);
  });

});

describe("worker-shared eligibility", () => {
  it("rejects per-file module state and unrestored global stubs", () => {
    const eligible = [
      'import { it } from "vitest";\nit("x", () => {});\n',
      'vi.stubGlobal("fetch", vi.fn());\nvi.unstubAllGlobals();\n',
      'vi.stubEnv("X", "1");\nvi.unstubAllEnvs();\n',
    ];
    const ineligible = [
      'vi.mock("./adapter");',
      'vi.doMock("./adapter");',
      'vi.resetModules();',
      'vi.hoisted(() => ({}));',
      'vi.stubGlobal("fetch", vi.fn());',
      'vi.stubEnv("X", "1");',
      'process.env.X = "1";',
      'process.env["X"] = "1";',
      'process.env.X ||= "1";',
      'process.env.X ??= "1";',
      'process.env.X += "1";',
      'process.env.X++;',
      'delete process.env.X;',
      'Object.assign(process.env, { X: "1" });',
    ];
    for (const source of eligible) expect(isWorkerSharedTestEligible(source), source).toBe(true);
    for (const source of ineligible) expect(isWorkerSharedTestEligible(source), source).toBe(false);
  });

  it("detects module-scope mutable state that a shared cache would carry", () => {
    const stateful = [
      "let activeNetwork;\nexport function install() { activeNetwork = 1; }\n",
      "var cache = 1;\n",
      'const entries = new Map<string, number>();\n',
      'const table: Record<string, true> = {};\ntable["x"] = true;\n',
      "export const cases = [];\ncases.push(1);\n",
    ];
    const stateless = [
      "export const labels: Record<string, true> = { a: true };\n",
      "const LIMIT = 10;\nconst parse = (value: string) => Number(value);\n",
      "const ABI = parseAbi([\"function totalSupply() view returns (uint256)\"]);\n",
    ];
    for (const source of stateful) expect(hasModuleScopeMutableState(source), source).toBe(true);
    for (const source of stateless) expect(hasModuleScopeMutableState(source), source).toBe(false);
  });

  it("keeps importers of stateful support modules isolated until a reset hook is wired", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-worker-shared-support-"));
    temporaryDirectories.push(cwd);
    const tests = join(cwd, "worker/src/cron/reserve-adapters/__tests__");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "stateful.test-support.ts"), "let activeNetwork;\nexport function install() { activeNetwork = 1; }\n");
    writeFileSync(join(tests, "clean.test-support.ts"), "export const label = 'clean';\n");
    writeFileSync(join(tests, "imports-state.test.ts"), 'import { install } from "./stateful.test-support";\ninstall();\n');
    writeFileSync(join(tests, "imports-clean.test.ts"), 'import { label } from "./clean.test-support";\nvoid label;\n');
    writeFileSync(join(tests, "imports-unresolvable.test.ts"), 'import { helper } from "./missing.test-support";\nvoid helper;\n');

    expect(collectWorkerSharedTestFiles(cwd)).toEqual([
      "worker/src/cron/reserve-adapters/__tests__/imports-clean.test.ts",
    ]);
  });

  it("accepts stateful support state only when the shared setup runs its reset hook", () => {
    const build = (setupCallsHook: boolean) => {
      const cwd = mkdtempSync(join(tmpdir(), "pharos-worker-shared-hook-"));
      temporaryDirectories.push(cwd);
      const tests = join(cwd, "worker/src/cron/reserve-adapters/__tests__");
      mkdirSync(tests, { recursive: true });
      mkdirSync(join(cwd, "worker/src/test-helpers"), { recursive: true });
      writeFileSync(
        join(tests, "erc4626-single-asset.test-support.ts"),
        "let activeNetwork;\nexport function install() { activeNetwork = 1; }\nexport function resetErc4626NetworkForTests(): void { activeNetwork = undefined; }\n",
      );
      writeFileSync(join(tests, "imports-state.test.ts"), 'import { install } from "./erc4626-single-asset.test-support";\ninstall();\n');
      writeFileSync(
        join(cwd, "worker/src/test-helpers/setup-shared-isolation.ts"),
        setupCallsHook ? "resetErc4626NetworkForTests();\n" : "// no reset\n",
      );
      return collectWorkerSharedTestFiles(cwd);
    };
    expect(build(true)).toEqual(["worker/src/cron/reserve-adapters/__tests__/imports-state.test.ts"]);
    expect(build(false)).toEqual([]);
  });

  it("keeps importers of mock-registering or env-writing support modules isolated", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-worker-shared-mocks-"));
    temporaryDirectories.push(cwd);
    const tests = join(cwd, "worker/src/lib/__tests__");
    mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "registry-mock.test-support.ts"), 'vi.mock("@shared/lib/stablecoins/registry", () => ({}));\n');
    writeFileSync(join(tests, "env-writing.test-support.ts"), 'process.env.PHAROS_FIXTURE = "1";\n');
    writeFileSync(join(tests, "plain.test-support.ts"), "export const label = 'plain';\n");
    writeFileSync(join(tests, "imports-mock.test.ts"), 'import { label } from "./registry-mock.test-support";\nvoid label;\n');
    writeFileSync(join(tests, "imports-env.test.ts"), 'import { label } from "./env-writing.test-support";\nvoid label;\n');
    writeFileSync(join(tests, "imports-plain.test.ts"), 'import { label } from "./plain.test-support";\nvoid label;\n');

    expect(collectWorkerSharedTestFiles(cwd)).toEqual([
      "worker/src/lib/__tests__/imports-plain.test.ts",
    ]);
  });

  it("classifies only __tests__ files under the worker/src/{cron,lib} tranche", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-worker-shared-"));
    temporaryDirectories.push(cwd);
    const cronTests = join(cwd, "worker/src/cron/reserve-adapters/__tests__");
    mkdirSync(cronTests, { recursive: true });
    writeFileSync(join(cronTests, "clean.test.ts"), 'import { it } from "vitest";\nit("x", () => {});\n');
    writeFileSync(join(cronTests, "mocked.test.ts"), 'vi.mock("./adapter");\n');
    writeFileSync(join(cronTests, "harness.test-support.ts"), "export const harness = true;\n");
    const libTests = join(cwd, "worker/src/lib/__tests__");
    mkdirSync(libTests, { recursive: true });
    writeFileSync(join(libTests, "clean.test.ts"), 'import { it } from "vitest";\nit("x", () => {});\n');
    for (const outside of ["worker/src/other", "worker/src/handlers", "worker/src/routes"]) {
      mkdirSync(join(cwd, outside, "__tests__"), { recursive: true });
      writeFileSync(join(cwd, outside, "__tests__/clean.test.ts"), 'import { it } from "vitest";\n');
    }

    expect(collectWorkerSharedTestFiles(cwd)).toEqual([
      "worker/src/cron/reserve-adapters/__tests__/clean.test.ts",
      "worker/src/lib/__tests__/clean.test.ts",
    ]);
  });

  it("keeps every classified file owned by exactly one executable project", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    expect(EXECUTABLE_TEST_PROJECTS.filter((project) => project.name === "worker-shared")).toHaveLength(1);
    expect(() => assertExecutableTestFiles(WORKER_SHARED_TEST_FILES, { cwd: repoRoot })).not.toThrow();
    const isolatedOverrides = Object.keys(WORKER_SHARED_ISOLATED_OVERRIDES);
    expect(() => assertExecutableTestFiles(isolatedOverrides, { cwd: repoRoot })).not.toThrow();
    for (const file of isolatedOverrides) expect(WORKER_SHARED_TEST_FILES).not.toContain(file);
  });
});

describe("critical execution contracts", () => {
  it("rejects missing, non-test and multiply-owned mandatory files", () => {
    expect(() => assertExecutableTestFiles(["src/missing.test.ts"], { exists: () => false })).toThrow("src/missing.test.ts");
    expect(() => assertExecutableTestFiles(["src/source.ts"], { exists: () => true })).toThrow("src/source.ts");
    expect(() => assertExecutableTestFiles(["tests/browser/page.spec.ts"], { exists: () => true })).toThrow("tests/browser/page.spec.ts");
    const project = { name: "duplicate", include: ["src/**/*.test.ts"], exclude: [] };
    expect(() => assertExecutableTestFiles(["src/owner.test.ts"], { exists: () => true, projects: [project, project] })).toThrow("found 2");
  });

  it("never turns an empty ownership selection into unrestricted Vitest execution", () => {
    const options = { criticalFiles: ["src/source.ts"], ownership: new Map() };
    expect(() => buildCriticalCoverageArgs([], options)).toThrow(/Empty/);
    expect(() => buildCriticalCoverageArgs([], { criticalFiles: [] })).toThrow(/Empty/);
  });

  it("retains all critical owners while narrowing measured sources", () => {
    const ownership = new Map([["src/first.ts", ["src/first.test.ts"]], ["src/second.ts", ["src/second.test.ts"]]]);
    const args = buildCriticalCoverageArgs([], { criticalFiles: [...ownership.keys()], ownership, changedFiles: ["src/first.ts"], exists: () => true });
    expect(args.filter((arg) => arg.startsWith("--coverage.include="))).toEqual(["--coverage.include=src/first.ts"]);
    expect(args.filter((arg) => arg.endsWith(".test.ts"))).toEqual(["src/first.test.ts", "src/second.test.ts"]);
  });

  it.each([["kept.ts", ["kept.ts"]], ["././kept.ts", ["kept.ts", "registry.json"]]])("persists enrolled sources' V8 results (%s)", async (include, kept) => {
    installCriticalCoverageFilter();
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-coverage-"));
    temporaryDirectories.push(cwd);
    const provider = Object.assign(new BaseCoverageProvider(), { roots: [cwd], coverageFilesDirectory: cwd, options: { include: [include], exclude: [], allowExternal: false } });
    const script = (file: string) => ({ url: pathToFileURL(join(cwd, file)).href, functions: [{ ranges: [{ startOffset: 0, endOffset: 9, count: 2 }] }] });
    provider.onAfterSuiteRun({ coverage: { result: [script("kept.ts"), script("registry.json")] }, testFiles: ["a.test.ts"], environment: "ssr" } as never);
    await Promise.all(provider.pendingPromises);
    expect(JSON.parse(readFileSync(join(cwd, readdirSync(cwd)[0]!), "utf8"))).toEqual({ result: kept.map(script) });
  });
});
