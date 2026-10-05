import { runInNewContext } from "node:vm";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";
import { withTempRepo } from "./helpers/test-state";

describe("Vitest JSON module transforms", () => {
  it("preserves catalog evidence without a per-character SSR source map", async () => {
    const catalog = Array.from({ length: 200 }, (_, index) => ({
      id: `coin-${index}`,
      mintAuthority: {
        evidence: [{ url: `https://example.com/${index}`, note: "Complete nested authority evidence" }],
        controls: [{ actors: ["governance", "guardian"], threshold: index % 3 }],
      },
    }));
    const source = `${JSON.stringify(catalog, null, 2)}\n`;
    expect(source.length).toBeGreaterThan(10_000);

    await withTempRepo("pharos-vitest-json", { "catalog.json": source }, async (root) => {
      const server = await createServer({
        root,
        configFile: false,
        json: config.json,
        server: { middlewareMode: true, watch: null },
        appType: "custom",
        logLevel: "silent",
      });
      try {
        const transformed = await server.environments.ssr.transformRequest("/catalog.json");
        expect(transformed).not.toBeNull();
        expect(transformed!.map).toBeNull();
        expect(transformed!.code).toContain("JSON.parse(");
        const exports: { default?: unknown } = {};
        runInNewContext(transformed!.code, { __vite_ssr_exports__: exports });
        expect(JSON.stringify(exports.default)).toBe(JSON.stringify(catalog));
      } finally {
        await server.close();
      }
    });
  });
});
