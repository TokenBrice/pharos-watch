import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import sharp from "sharp";
import { unstable_dev, unstable_readConfig, type Unstable_DevWorker } from "wrangler";

it("renders a PNG through the production Satori and resvg pipeline in workerd", async () => {
  const root = resolve(import.meta.dirname, "../..");
  mkdirSync(resolve(root, "agents"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, "agents/og-worker-test-"));
  let worker: Unstable_DevWorker | undefined;
  try {
  const config = resolve(scratch, "wrangler.json");
  const entry = resolve(scratch, "worker.ts");
  const production = unstable_readConfig({ config: resolve(root, "worker/wrangler.toml") });
  writeFileSync(config, JSON.stringify({
    name: "og-runtime-test",
    compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags,
    tsconfig: "../../worker/tsconfig.json",
    rules: production.rules,
    // Only the renderer alias: the catalog alias would change this graph's catalog source.
    alias: { harfbuzzjs: resolve(root, "worker", production.alias?.harfbuzzjs ?? "missing-harfbuzzjs-alias") },
  }));
  writeFileSync(entry, `
    import { createElement } from "react";
    import { CardFrame } from ${JSON.stringify(resolve(root, "worker/src/lib/og-templates/shared.tsx"))};
    import { RouteCard } from ${JSON.stringify(resolve(root, "worker/src/lib/og-templates/route-card.tsx"))};
    export default {
      async fetch(request) {
        // Production loads the OG route lazily inside a request, after startup.
        const { renderPng } = await import(${JSON.stringify(resolve(root, "worker/src/api/og.tsx"))});
        const element = new URL(request.url).pathname === "/route"
          ? createElement(RouteCard, {
              cardKey: "flows", variant: "live",
              data: { hero: "≥ $200.0M", context: "Runtime smoke", support: ["Printed $1", "Shredded $1"], stamp: "As of 12 Oct 2026, 14:05 UTC" },
            })
          : createElement(CardFrame, {
              title: "Pharos", lastUpdated: "Runtime smoke",
              children: createElement("div", null, "Stablecoin analytics"),
            });
        const image = await renderPng(element);
        return new Response(image, { headers: { "Content-Type": "image/png" } });
      },
    };
  `);
    worker = await unstable_dev(entry, {
      config, local: true, persist: false, logLevel: "error", port: 0,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    });
    // Two real GETs exercise both cold initialization and isolate reuse; the
    // third renders the route-card template through the same pipeline.
    for (const path of ["/", "/", "/route"]) {
      const response = await worker.fetch(path);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const image = sharp(Buffer.from(await response.arrayBuffer()));
      expect(await image.metadata()).toMatchObject({ format: "png", width: 1200, height: 628 });
      await image.raw().toBuffer();
    }
  } finally {
    try {
      await worker?.stop();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}, 60_000);
