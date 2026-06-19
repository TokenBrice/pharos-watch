import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pharos-duplicate-exports-"));
  tempRoots.push(root);
  for (const dir of ["shared/lib/__tests__", "src/lib", "worker/src/lib"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-duplicate-exports", () => {
  it("scans test files for duplicate exports", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "shared/lib/__tests__/dup.test.ts"),
      "export const duplicate = 1;\nexport const duplicate = 2;\n",
      "utf8",
    );

    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/ci/check-duplicate-exports.mjs")], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shared/lib/__tests__/dup.test.ts");
    expect(result.stderr).toContain('exports "duplicate"');
  });
});
