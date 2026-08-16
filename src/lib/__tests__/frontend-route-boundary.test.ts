import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return sourceFiles(path);
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("frontend route boundary", () => {
  it("keeps reusable components, hooks, and library modules independent of src/app", () => {
    const violations = ["src/components", "src/hooks", "src/lib"]
      .flatMap((directory) => sourceFiles(join(ROOT, directory)))
      .filter((path) => /["']@\/app\//.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${ROOT}/`, ""));

    expect(violations).toEqual([]);
  });
});
