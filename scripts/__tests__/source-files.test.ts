import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectSourceFiles, resolveSourceRoot } from "../lib/source-files.mts";

let tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pharos-source-files-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("collectSourceFiles", () => {
  it("recursively collects matching extensions while skipping default generated/test dirs", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "src/app/demo"), { recursive: true });
    mkdirSync(join(root, "src/app/__tests__"), { recursive: true });
    mkdirSync(join(root, "src/app/__mocks__"), { recursive: true });
    mkdirSync(join(root, "src/app/node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "src/app/page.tsx"), "export const page = true;\n");
    writeFileSync(join(root, "src/app/demo/model.ts"), "export const model = true;\n");
    writeFileSync(join(root, "src/app/demo/readme.md"), "# ignored\n");
    writeFileSync(join(root, "src/app/__tests__/page.test.tsx"), "export const test = true;\n");
    writeFileSync(join(root, "src/app/__mocks__/mock.ts"), "export const mock = true;\n");
    writeFileSync(join(root, "src/app/node_modules/pkg/index.ts"), "export const pkg = true;\n");

    const files = collectSourceFiles(join(root, "src/app"), {
      extensions: new Set([".ts", ".tsx"]),
    })
      .map((file) => relative(root, file))
      .sort();

    expect(files).toEqual(["src/app/demo/model.ts", "src/app/page.tsx"]);
  });

  it("resolves relative roots from the provided cwd and preserves absolute roots", () => {
    const root = makeTempRepo();

    expect(resolveSourceRoot("src/app", root)).toBe(join(root, "src/app"));
    expect(resolveSourceRoot(root, "/tmp/elsewhere")).toBe(root);
  });

  it("can skip dot files and dot directories without changing the default scan contract", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "src/.cache"), { recursive: true });
    writeFileSync(join(root, "src/page.ts"), "export const page = true;\n");
    writeFileSync(join(root, "src/.hidden.ts"), "export const hidden = true;\n");
    writeFileSync(join(root, "src/.cache/generated.ts"), "export const generated = true;\n");

    const files = collectSourceFiles(join(root, "src"), {
      extensions: new Set([".ts"]),
      skipDotEntries: true,
    })
      .map((file) => relative(root, file))
      .sort();

    expect(files).toEqual(["src/page.ts"]);
  });
});
