import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { collectSourceFiles } from "../lib/source-files.mts";

describe("collectSourceFiles", () => {

  it("keeps shared TypeScript sources free of raw NUL bytes", () => {
    const files = collectSourceFiles(join(process.cwd(), "shared"), {
      extensions: new Set([".ts", ".tsx"]),
      excludedDirs: new Set(),
    });
    const withNul = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => relative(process.cwd(), file))
      .sort();

    expect(withNul).toEqual([]);
  });
});
