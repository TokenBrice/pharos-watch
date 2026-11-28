import { globSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readTypedLintPatterns } from "../ci/run-changed-eslint.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const patterns = readTypedLintPatterns();
const intendedRoots = ["worker/src", "functions", "src/lib", "src/hooks"];

describe("typed lint file scope", () => {
  it.each(intendedRoots)("covers TypeScript and TSX throughout %s", (root) => {
    // Probe both extensions even where the current tree has no TSX source.
    for (const extension of ["ts", "tsx"]) {
      for (const relativePath of [`scope-probe.${extension}`, `nested/scope-probe.${extension}`]) {
        const path = `${root}/${relativePath}`;
        expect(patterns.some((pattern) => matchesGlob(path, pattern)), `Missing typed-lint scope: ${path}`).toBe(true);
      }
    }

    for (const path of globSync(`${root}/**/*.{ts,tsx}`, { cwd: REPO_ROOT })) {
      expect(patterns.some((pattern) => matchesGlob(path, pattern)), `Uncovered typed-lint file: ${path}`).toBe(true);
    }
  });

  it("fails closed without lint:typed globs", () => {
    expect(() => readTypedLintPatterns(resolve(REPO_ROOT, "worker/package.json"))).toThrow(/No typed-lint globs/);
    const quotedConfigOnly = join(mkdtempSync(join(tmpdir(), "pharos-typed-scope-")), "package.json");
    writeFileSync(quotedConfigOnly, JSON.stringify({ scripts: { "lint:typed": "eslint --config \"eslint.typed.config.mjs\"" } }));
    expect(() => readTypedLintPatterns(quotedConfigOnly)).toThrow(/No typed-lint globs/);
  });
});
