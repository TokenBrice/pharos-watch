import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import createNextConfig, {
  BUILD_ID_EXCLUDED_PATHS,
  BUILD_ID_INPUT_DIRECTORIES,
  BUILD_ID_INPUT_FILES,
  nextBuildId,
} from "../../next.config";
import { collectModuleSpecifiers, resolveModulePattern, resolveModuleSpecifier } from "../lib/pr-import-graph.mts";

const fixtures: string[] = [];

/** A file-level `"use client"` directive after leading comments and whitespace. */
function hasClientDirective(source: string): boolean {
  let rest = source.replace(/^\uFEFF/u, "");
  while (rest.length > 0) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith("//")) {
      const newline = trimmed.indexOf("\n");
      if (newline < 0) return false;
      rest = trimmed.slice(newline + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/", 2);
      if (end < 0) return false;
      rest = trimmed.slice(end + 2);
    } else {
      return /^(?:"use client"|'use client')/u.test(trimmed);
    }
  }
  return false;
}

function buildInputFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pharos-next-build-id-"));
  fixtures.push(root);
  for (const directory of BUILD_ID_INPUT_DIRECTORIES) mkdirSync(join(root, directory), { recursive: true });
  for (const file of BUILD_ID_INPUT_FILES) writeFileSync(join(root, file), "fixture\n");
  return root;
}

function writeFixtureFile(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/** Materialize every excluded member, which is a file or a directory by shape. */
function writeExcludedPaths(root: string, contents: string): void {
  for (const path of BUILD_ID_EXCLUDED_PATHS) {
    const nested = path.endsWith(".ts") || path.endsWith(".json") || path.endsWith("_redirects")
      ? path
      : `${path}/usdc-circle.json`;
    writeFixtureFile(root, nested, contents);
  }
}

/** Every `"use client"` module under `src/` and `shared/`, where client bundles can start. */
function collectClientModules(cwd = process.cwd()): string[] {
  const modules: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(cwd, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (
        /\.(?:[cm]?[jt]sx?)$/u.test(entry.name)
        && !/\.(?:test|spec)\./u.test(entry.name)
        && hasClientDirective(readFileSync(join(cwd, path), "utf8"))
      ) {
        modules.push(path);
      }
    }
  };
  walk("src");
  walk("shared");
  return modules.sort();
}

interface ClientDependencies {
  dependencies: Map<string, string[]>;
  unresolved: string[];
}

function buildClientDependencies(cwd: string, clientModules: readonly string[]): ClientDependencies {
  const dependencies = new Map<string, string[]>();
  const unresolved: string[] = [];
  const pending = [...clientModules];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (dependencies.has(file)) continue;
    const direct: string[] = [];
    dependencies.set(file, direct);
    if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(file)) continue;
    const collected = collectModuleSpecifiers(readFileSync(join(cwd, file), "utf8"));
    for (const specifier of collected.specifiers) {
      const resolution = resolveModuleSpecifier(specifier, file, { cwd });
      if (resolution.kind === "file") {
        direct.push(resolution.file);
        pending.push(resolution.file);
      } else if (resolution.kind === "unresolved") {
        unresolved.push(resolution.reason);
      }
    }
    for (const pattern of collected.patterns) {
      const expansion = resolveModulePattern(pattern, file, { cwd });
      if (expansion.unresolved) {
        unresolved.push(expansion.unresolved);
        continue;
      }
      for (const expanded of expansion.files) {
        direct.push(expanded);
        pending.push(expanded);
      }
    }
  }
  return { dependencies, unresolved };
}

function isExcludedPath(path: string, excluded: readonly string[] = BUILD_ID_EXCLUDED_PATHS): boolean {
  return excluded.some((member) => path === member || path.startsWith(`${member}/`));
}

/** Import chains from a client module to a release-refreshed path. */
function findExcludedClientImports(
  clientModules: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  excluded: readonly string[] = BUILD_ID_EXCLUDED_PATHS,
): string[] {
  const chains: string[] = [];
  const seen = new Set<string>();
  const pending = clientModules.map((module) => ({ file: module, chain: [module] }));
  while (pending.length > 0) {
    const { file, chain } = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dependency of dependencies.get(file) ?? []) {
      if (isExcludedPath(dependency, excluded)) {
        chains.push([...chain, dependency].join(" -> "));
      } else if (!seen.has(dependency)) {
        pending.push({ file: dependency, chain: [...chain, dependency] });
      }
    }
  }
  return chains.sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release Next.js typecheck handoff", () => {
  it.each([undefined, "false", "true"])("inlines the session flag with a default-off value (%s)", (flag) => {
    vi.stubEnv("NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", flag);
    expect(createNextConfig("phase-production-build").env?.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK).toBe(flag ?? "false");
  });

  it("keeps Next build typechecking enabled by default", () => {
    vi.stubEnv("PHAROS_RELEASE_PR_TYPECHECKED", "");

    expect(createNextConfig("phase-production-build").typescript).toBeUndefined();
  });

  it("applies build-speed defaults and env-gated CI/CPU/webpack-cache options", () => {
    for (const k of ["CI", "PHAROS_DISABLE_PRERENDER_SOURCE_MAPS", "PHAROS_NEXT_BUILD_CPUS", "PHAROS_DISABLE_WEBPACK_FS_CACHE"]) vi.stubEnv(k, "");
    const c = () => createNextConfig("phase-production-build"), def = c(), ctx = { dev: false, isServer: true } as Parameters<NonNullable<typeof def.webpack>>[1];
    expect([def.experimental?.serverMinification, def.experimental?.cpus, def.enablePrerenderSourceMaps, def.outputFileTracingExcludes?.["*"]?.length]).toEqual([false, undefined, undefined, 6]);
    vi.stubEnv("CI", "true"); vi.stubEnv("PHAROS_NEXT_BUILD_CPUS", "4");
    expect([c().enablePrerenderSourceMaps, c().experimental?.cpus]).toEqual([false, 4]);
    vi.stubEnv("PHAROS_NEXT_BUILD_CPUS", "0"); expect(c().experimental?.cpus).toBeUndefined();
    expect(def.webpack?.({ cache: { type: "filesystem" } }, ctx).cache).toEqual({ type: "filesystem" });
    vi.stubEnv("PHAROS_DISABLE_WEBPACK_FS_CACHE", "1");
    expect([def.webpack?.({ cache: { type: "filesystem" } }, ctx).cache, def.webpack?.({ cache: { type: "filesystem" } }, { ...ctx, dev: true }).cache]).toEqual([false, { type: "filesystem" }]);
  });
});

describe("deterministic Next.js build ID", () => {
  it("is stable for identical inputs, rotates with bundled bytes, and ignores tests", () => {
    const root = buildInputFixture();
    const baseline = nextBuildId(root, {});
    expect(nextBuildId(root, {})).toBe(baseline);
    expect(baseline).toMatch(/^[a-f0-9]{21}$/u);

    writeFixtureFile(root, "src/app/page.tsx", "export default 1;\n");
    const changed = nextBuildId(root, {});
    expect(changed).not.toBe(baseline);

    writeFixtureFile(root, "src/app/page.test.tsx", "// never bundled\n");
    expect(nextBuildId(root, {})).toBe(changed);
  });

  it("does not rotate for the release-refreshed data paths", () => {
    const root = buildInputFixture();
    writeExcludedPaths(root, "committed\n");
    const baseline = nextBuildId(root, {});

    writeExcludedPaths(root, "refreshed\n");
    expect(nextBuildId(root, {})).toBe(baseline);
  });

  it("fails closed when a hashed input is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-next-build-id-empty-"));
    fixtures.push(root);

    expect(() => nextBuildId(root, {})).toThrow();
  });

  it("rotates with inlined NEXT_PUBLIC_* values only", () => {
    const root = buildInputFixture();
    const baseline = nextBuildId(root, { NODE_ENV: "production" });

    expect(nextBuildId(root, { NODE_ENV: "production", NEXT_PUBLIC_GA_ID: "G-A" })).not.toBe(baseline);
    expect(nextBuildId(root, { NODE_ENV: "production", PATH: "/usr/bin" })).toBe(baseline);
  });
});

describe("client bundle excludes release-refreshed data", () => {
  it("never reaches a release-refreshed path", () => {
    const clientModules = collectClientModules();
    expect(clientModules.length).toBeGreaterThan(100);
    const { dependencies, unresolved } = buildClientDependencies(process.cwd(), clientModules);
    expect([unresolved, findExcludedClientImports(clientModules, dependencies), dependencies.has("src/lib/homepage-static-snapshot.ts")]).toEqual([[], [], false]);
    expect([...dependencies.keys()].filter((f) => /process\.env\.SITE_SESSION_SIGNING_KEY\b/u.test(readFileSync(f, "utf8")))).toEqual([]);
    expect([...dependencies.keys()].filter((f) => !BUILD_ID_INPUT_DIRECTORIES.some((d) => f.startsWith(`${d}/`)))).toEqual([]);
  });

  it("reports the import chain when a client module violates the boundary", () => {
    const dependencies = new Map([["src/components/violating-rail.tsx", ["src/lib/datasets/public-dataset-current.ts"]], ["src/lib/datasets/public-dataset-current.ts", ["public/datasets/top-stablecoins/2026-11-01.json"]]]);
    expect(findExcludedClientImports(["src/components/violating-rail.tsx"], dependencies)).toEqual(["src/components/violating-rail.tsx -> src/lib/datasets/public-dataset-current.ts"]);
  });
});
