import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type RegistryFamily = {
  checks?: string[];
  docsLikelyRequired?: string[];
  docsToRead?: string[];
  exactPaths?: string[];
  id: string;
  prefixes?: string[];
  regexes?: string[];
};

type OwnershipRegistry = {
  baseDocs?: string[];
  taskFamilies?: RegistryFamily[];
};

const ownership = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "docs/doc-ownership.json"), "utf8"),
) as OwnershipRegistry;
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const families = ownership.taskFamilies ?? [];
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).split("\0").filter(Boolean);

function isConcretePath(value: string): boolean {
  // Registry entries with prose, placeholders, or globs describe dynamic routing
  // rather than a path that should be resolved from this checkout.
  return value.length > 0 && !/\s/.test(value) && !/[<>{}*]/.test(value);
}

describe("doc-ownership registry integrity", () => {
  it("keeps every concrete documentation and exact path present", () => {
    expect(families.length).toBeGreaterThan(0);

    const pathEntries = [
      ...(ownership.baseDocs ?? []),
      ...families.flatMap((family) => [
        ...(family.docsToRead ?? []),
        ...(family.docsLikelyRequired ?? []),
        ...(family.exactPaths ?? []),
      ]),
    ];
    for (const entry of pathEntries) {
      if (!isConcretePath(entry)) continue;
      expect(existsSync(resolve(REPO_ROOT, entry)), entry).toBe(true);
    }
  });

  it("keeps every npm run check wired to a package script", () => {
    for (const family of families) {
      for (const check of family.checks ?? []) {
        for (const match of check.matchAll(/\bnpm run\s+([^\s]+)/g)) {
          const alias = match[1];
          expect(Object.hasOwn(packageScripts, alias), `${family.id}: ${alias}`).toBe(true);
        }
      }
    }
  });

  it("compiles every regex and matches every matcher against tracked files", () => {
    for (const family of families) {
      for (const prefix of family.prefixes ?? []) {
        expect(trackedFiles.some((path) => path.startsWith(prefix)), `${family.id}: ${prefix}`).toBe(true);
      }
      for (const pattern of family.regexes ?? []) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- validating registry-authored patterns is the point of this test
        expect(() => new RegExp(pattern, "i"), `${family.id}: ${pattern}`).not.toThrow();
        // eslint-disable-next-line security/detect-non-literal-regexp -- compiled again after the throw check to exercise matching
        const matcher = new RegExp(pattern, "i");
        expect(trackedFiles.some((path) => matcher.test(path)), `${family.id}: ${pattern}`).toBe(true);
      }
    }
  });
});
