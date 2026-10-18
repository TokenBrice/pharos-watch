import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  deriveCriticalOwnership,
  deriveBaseCriticalOwnership,
  collectOwningTests,
} from "../lib/critical-ownership.mts";

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
