import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function sourceFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recurse through the explicit test root
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
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- read the discovered source file
      .filter((path) => /["']@\/app\//.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${ROOT}/`, ""));

    expect(violations).toEqual([]);
  });

  it("keeps script-consumed content registries outside route modules", () => {
    for (const directory of [
      "src/app/learn/case-studies/content",
      "src/app/learn/mechanisms/content",
    ]) {
      const absoluteDirectory = join(ROOT, directory);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspect the explicit content directory
      const routeOwnedModules = existsSync(absoluteDirectory)
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspect the explicit content directory
        ? readdirSync(absoluteDirectory)
            .filter((file) => file.endsWith(".ts") && file !== "index.ts")
            .sort()
        : [];
      expect(routeOwnedModules).toEqual([]);
    }

  });
});
