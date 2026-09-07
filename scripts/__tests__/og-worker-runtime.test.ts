import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import sharp from "sharp";
import { unstable_dev, unstable_readConfig } from "wrangler";

it("renders a PNG through the production Satori and resvg pipeline in workerd", async () => {
  const root = resolve(import.meta.dirname, "../..");
  mkdirSync(resolve(root, "agents"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, "agents/og-worker-test-"));
  const config = resolve(scratch, "wrangler.json");
  const entry = resolve(scratch, "worker.ts");
  const production = unstable_readConfig({ config: resolve(root, "worker/wrangler.toml") });
  writeFileSync(config, JSON.stringify({
    name: "og-runtime-test",
    compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags,
    tsconfig: "../../worker/tsconfig.json",
    rules: production.rules,
  }));
  writeFileSync(entry, `
    import { createElement } from "react";
    import { renderPng } from ${JSON.stringify(resolve(root, "worker/src/api/og.tsx"))};
    import { CardFrame } from ${JSON.stringify(resolve(root, "worker/src/lib/og-templates/shared.tsx"))};
    export default {
      async fetch() {
        const image = await renderPng(createElement(CardFrame, {
          title: "Pharos", lastUpdated: "Runtime smoke",
          children: createElement("div", null, "Stablecoin analytics"),
        }));
        return new Response(image, { headers: { "Content-Type": "image/png" } });
      },
    };
  `);
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  try {
    worker = await unstable_dev(entry, {
      config, local: true, persist: false, logLevel: "error", port: 0,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    });
    // Two real GETs exercise both cold initialization and isolate reuse.
    for (let i = 0; i < 2; i++) {
      const response = await worker.fetch();
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const image = sharp(Buffer.from(await response.arrayBuffer()));
      expect(await image.metadata()).toMatchObject({ format: "png", width: 1200, height: 628 });
      await image.raw().toBuffer();
    }
  } finally {
    await worker?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
