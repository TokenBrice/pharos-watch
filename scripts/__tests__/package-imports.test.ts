import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLocalPackageImport } from "../lib/package-imports.mts";
import { resolveCriticalImport } from "../lib/critical-ownership.mts";

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
  it("resolves authored exact mappings alongside ordinary relative and alias imports", () => {
    const root = fixture({ "#catalog": "./shared/catalog.ts" });
    expect(resolveLocalPackageImport("#catalog", root)).toBe(join(root, "shared/catalog.ts"));
    expect(resolveCriticalImport("#catalog", "shared/registry.ts", root)).toBe("shared/catalog.ts");
    expect(resolveCriticalImport("./catalog", "shared/registry.ts", root)).toBe("shared/catalog.ts");
    expect(resolveCriticalImport("@shared/catalog", "shared/registry.ts", root)).toBe("shared/catalog.ts");
  });

  it("leaves unresolved private imports and external packages unresolved", () => {
    const root = fixture({ "#missing-file": "./shared/missing.ts", "#pattern/*": "./shared/*.ts" });
    expect(resolveLocalPackageImport("#unknown", root)).toBeNull();
    expect(resolveLocalPackageImport("fflate", root)).toBeNull();
    expect(resolveLocalPackageImport("#pattern/catalog", root)).toBeNull();
    expect(resolveCriticalImport("#missing-file", "shared/registry.ts", root)).toBeNull();
  });

  it("rejects path escapes, package targets, patterns, and unsupported conditional mappings", () => {
    for (const target of ["./../outside.ts", "./node_modules/package/index.js", "/outside.ts", "fflate", "./shared/*.ts", { default: "./shared/catalog.ts" }]) {
      const root = fixture({ "#unsafe": target });
      expect(() => resolveLocalPackageImport("#unsafe", root)).toThrow(/Package import #unsafe/);
    }
  });
});
