import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, "");
const APPROVED_FETCH_HELPERS = new Set(["defillama.ts", "request.ts"]);

function adapterSourceFiles(): string[] {
  return readdirSync(ADAPTER_DIR)
    .filter((fileName) => fileName.endsWith(".ts"))
    .sort();
}

describe("reserve adapter fetch guard", () => {
  it("keeps direct network fetches inside approved request helpers", () => {
    const violations = adapterSourceFiles().flatMap((fileName) => {
      if (APPROVED_FETCH_HELPERS.has(fileName)) return [];
      const filePath = join(ADAPTER_DIR, fileName);
      const source = readFileSync(filePath, "utf8");
      const directGlobalFetch = /(?<![\w.])fetch\s*\(/.test(source);
      const directFetchWithRetryImport =
        /from\s+["']\.\.\/\.\.\/lib\/fetch-retry["']/.test(source) ||
        /from\s+["']\.\.\/lib\/fetch-retry["']/.test(source);

      return directGlobalFetch || directFetchWithRetryImport
        ? [relative(process.cwd(), filePath)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
