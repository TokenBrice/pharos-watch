import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLocalPackageImport } from "../lib/package-imports.mts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(imports: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "pharos-package-imports-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ imports }));
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared/catalog.ts"), "export default [];\n");
  return root;
}

describe("local package-private graph resolution", () => {
  it("rejects path escapes, package targets, patterns, and unsupported conditional mappings", () => {
    for (const target of ["./../outside.ts", "./node_modules/package/index.js", "/outside.ts", "fflate", "./shared/*.ts", { default: "./shared/catalog.ts" }]) {
      const root = fixture({ "#unsafe": target });
      expect(() => resolveLocalPackageImport("#unsafe", root)).toThrow(/Package import #unsafe/);
    }
  });
});

function workspaceFixture(exports: unknown = { "./public": "./src/public.ts" }) {
  const root = fixture({ "#catalog": "./shared/catalog.ts" });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    imports: { "#catalog": "./shared/catalog.ts" },
    workspaces: ["shared/local", "worker"],
  }));
  mkdirSync(join(root, "shared/local/src"), { recursive: true });
  writeFileSync(join(root, "shared/local/package.json"), JSON.stringify({ name: "@fixture/local", exports }));
  writeFileSync(join(root, "shared/local/src/public.ts"), 'throw new Error("must not execute package code");\n');
  mkdirSync(join(root, "worker"));
  writeFileSync(join(root, "worker/package.json"), JSON.stringify({ name: "stablecoin-api" }));
  return root;
}

describe("declared local workspace graph resolution", () => {
  it("resolves exact exports without installation or executing code and preserves private imports", () => {
    const root = workspaceFixture();
    expect(resolveLocalPackageImport("@fixture/local/public", root)).toBe(join(root, "shared/local/src/public.ts"));
    expect(resolveLocalPackageImport("#catalog", root)).toBe(join(root, "shared/catalog.ts"));
    expect(resolveLocalPackageImport("#unknown", root)).toBeNull();
    expect(resolveLocalPackageImport("zod", root)).toBeNull();
    expect(resolveLocalPackageImport("@fixture/other/public", root)).toBeNull();
    expect(resolveLocalPackageImport("stablecoin-api", root)).toBeNull();
    expect(resolveLocalPackageImport("stablecoin-api/private", root)).toBeNull();
  });

  it("rejects root/private imports rather than hiding known packages as external leaves", () => {
    const root = workspaceFixture();
    for (const specifier of ["@fixture/local", "@fixture/local/private", "@fixture/local/public/nested", "@fixture/local/public.ts"]) {
      expect(() => resolveLocalPackageImport(specifier, root)).toThrow(/Unresolved workspace export/);
    }
  });

  it("accepts an explicitly declared package-root export", () => {
    const root = workspaceFixture("./src/public.ts");
    expect(resolveLocalPackageImport("@fixture/local", root)).toBe(join(root, "shared/local/src/public.ts"));
  });

  it.each([
    { "./*": "./src/public.ts" },
    { "./public": "./src/*.ts" },
    { "./public": "../outside.ts" },
    { "./public": "./../catalog.ts" },
    { "./public": "./node_modules/zod/index.js" },
    { "./public": "./src\\public.ts" },
    { "./public": "./src/%2e%2e/outside.ts" },
    { "./public": "zod" },
    { "./public": { default: "./src/public.ts" } },
    { "./public": ["./src/public.ts"] },
    { "./public": null },
    { default: "./src/public.ts" },
  ])("rejects wildcard, escaping, and unsupported export maps: %j", (exports) => {
    const root = workspaceFixture(exports);
    expect(() => resolveLocalPackageImport("@fixture/local/public", root)).toThrow(/Workspace/);
  });

  it("rejects a symlink target outside its workspace", () => {
    const root = workspaceFixture({ "./public": "./src/escape.ts" });
    symlinkSync(join(root, "shared/catalog.ts"), join(root, "shared/local/src/escape.ts"));
    expect(() => resolveLocalPackageImport("@fixture/local/public", root)).toThrow(/escapes/);
  });

  it("fails closed when an exact source target does not exist", () => {
    const root = workspaceFixture({ "./public": "./src/missing.ts" });
    expect(() => resolveLocalPackageImport("@fixture/local/public", root)).toThrow(/source file does not exist/);
  });

  it("caches manifests per root and injected reader without consulting the real filesystem", () => {
    const root = join(tmpdir(), "virtual-package-fixture");
    const files: Record<string, string> = {
      [join(root, "package.json")]: JSON.stringify({ workspaces: ["shared/local"] }),
      [join(root, "shared/local/package.json")]: JSON.stringify({ name: "local", exports: { "./public": "./public.ts" } }),
      [join(root, "shared/local/public.ts")]: "export const value = true;",
    };
    const reads: string[] = [];
    const fsImpl = {
      existsSync: (path: string) => Object.hasOwn(files, path),
      readFileSync: (path: string) => {
        reads.push(path);
        return files[path];
      },
    };
    expect(resolveLocalPackageImport("local/public", root, fsImpl)).toBe(join(root, "shared/local/public.ts"));
    expect(resolveLocalPackageImport("local/public", root, fsImpl)).toBe(join(root, "shared/local/public.ts"));
    expect(reads).toEqual([join(root, "package.json"), join(root, "shared/local/package.json")]);
    const otherFs = { ...fsImpl, readFileSync: () => "{}" };
    expect(resolveLocalPackageImport("local/public", root, otherFs)).toBeNull();
    expect(resolveLocalPackageImport("local/public", join(root, "other"), fsImpl)).toBeNull();
  });
});
