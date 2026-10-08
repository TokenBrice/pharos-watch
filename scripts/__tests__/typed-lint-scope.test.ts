import { globSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const { scripts } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const patterns = Array.from(scripts["lint:typed"].matchAll(/(["'])(.*?)\1/g), (match) => match[2]);
const intendedRoots = ["worker/src", "functions", "src/lib", "src/hooks"];

describe("typed lint file scope", () => {
  it("expands every quoted pattern to at least one file", () => {
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const files = globSync(pattern, { cwd: REPO_ROOT, withFileTypes: true }).filter((entry) => entry.isFile());
      expect(files, `Empty typed-lint pattern: ${pattern}`).not.toHaveLength(0);
    }
  });

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
});
