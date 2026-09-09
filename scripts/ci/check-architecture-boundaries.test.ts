import { afterEach, describe, expect, it } from "vitest";
import { checkArchitectureBoundaries } from "./check-architecture-boundaries";
import { createTempRepoTracker } from "../__tests__/helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-architecture-boundaries");
afterEach(cleanup);

function fixture() {
  const root = makeRoot();
  writeText(root, "tsconfig.json", JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", resolveJsonModule: true,
    paths: { "@/*": ["./src/*"], "@shared/*": ["./shared/*"], "transport": ["./worker/src/lib/fetch-retry.ts"] },
  } }));
  return root;
}

const ADAPTER = "worker/src/cron/reserve-adapters/example.ts";
const RECAP = "worker/src/cron/telegram-recap-planner.ts";
const SCRUBBER = "src/lib/api-key-verification-url.ts";
const ANALYTICS = "src/components/google-analytics.tsx";
const LIGHT = "src/lib/api-query-domains/stability-light.ts";

describe("resolved architecture boundaries", () => {
  it("rejects a nested adapter's aliased transport re-export but permits the approved request gateway", () => {
    const root = fixture();
    writeText(root, ADAPTER, 'export { request } from "./nested/helper";');
    writeText(root, "worker/src/cron/reserve-adapters/nested/helper.ts", 'export { request } from "transport";');
    writeText(root, "worker/src/lib/fetch-retry.ts", 'export const request = fetch;');
    expect(checkArchitectureBoundaries(root, ["reserve-network"])).toEqual(expect.arrayContaining([
      expect.stringContaining("worker/src/lib/fetch-retry.ts: forbidden dependency"),
    ]));
    writeText(root, "worker/src/cron/reserve-adapters/nested/helper.ts", 'export { request } from "../request";');
    writeText(root, "worker/src/cron/reserve-adapters/request.ts", 'export { request } from "transport";');
    expect(checkArchitectureBoundaries(root, ["reserve-network"])).toEqual([]);
  });

  it.each([
    'const request = fetch; export const run = () => request("url");',
    'const g = globalThis; const request = g["fetch"]; export { request };',
    'const { fetch: request } = globalThis; export { request };',
    'export const request = globalThis["fet" + "ch"];',
    'export const run = () => new WebSocket("url");',
  ])("rejects acquisition of network capabilities: %s", (source) => {
    const root = fixture();
    writeText(root, RECAP, 'export { run } from "@shared/lib/helper";');
    writeText(root, "shared/lib/helper.ts", source);
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      `recap-cost: ${RECAP} -> shared/lib/helper.ts: network capability`,
    ]);
  });

  it("permits comments, type-only edges, and locally shadowed network names", () => {
    const root = fixture();
    writeText(root, RECAP, `
      import type { Secret } from "./daily-digest";
      export type { Secret } from "./daily-digest";
      // fetch("not executable"); import("./daily-digest")
      export function run(window: string, fetch: () => number) { return window[0] + fetch(); }
      export const label = "api.openai.com fetch()";
    `);
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([]);
  });

  it("rejects relative route reachability through a shared re-export and accepts the content-layer cutover", () => {
    const root = fixture();
    writeText(root, "src/components/card.ts", 'export { value } from "@shared/lib/content";');
    writeText(root, "shared/lib/content.ts", 'export { value } from "../../src/app/learn/content";');
    writeText(root, "src/app/learn/content.ts", "export const value = 1;");
    expect(checkArchitectureBoundaries(root, ["frontend-routes"])).toEqual([
      "frontend-routes: src/components/card.ts -> shared/lib/content.ts -> src/app/learn/content.ts: forbidden dependency",
    ]);
    writeText(root, "shared/lib/content.ts", "export const value = 1;");
    expect(checkArchitectureBoundaries(root, ["frontend-routes"])).toEqual([]);
  });

  it("rejects route-owned script content registries, while permitting an index re-export", () => {
    const root = fixture();
    writeText(root, "src/lib/content.ts", "export const value = 1;");
    writeText(root, "src/app/learn/mechanisms/content/index.ts", 'export { value } from "@/lib/content";');
    expect(checkArchitectureBoundaries(root, ["frontend-routes"])).toEqual([]);
    writeText(root, "src/app/learn/mechanisms/content/nested/article.ts", "export const value = 1;");
    expect(checkArchitectureBoundaries(root, ["frontend-routes"])).toEqual([
      "frontend-routes: src/app/learn/mechanisms/content/nested/article.ts: route-owned content registry",
    ]);
  });

  it.each(['import("./weekly-recap")', 'require("./weekly-recap")'])("rejects executable recap loading via %s", (load) => {
    const root = fixture();
    writeText(root, RECAP, `export const run = () => ${load};`);
    writeText(root, "worker/src/cron/weekly-recap.ts", "export const run = () => 1;");
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      `recap-cost: ${RECAP} -> worker/src/cron/weekly-recap.ts: forbidden dependency`,
    ]);
    writeText(root, RECAP, "export const run = () => 1;");
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([]);
  });

  it("requires the analytics entry to reach a schema-free verification scrubber", () => {
    const root = fixture();
    writeText(root, ANALYTICS, 'export { scrub } from "@/lib/api-key-verification-url";');
    writeText(root, SCRUBBER, 'export { scrub } from "@shared/lib/bridge";');
    writeText(root, "shared/lib/bridge.ts", 'export { scrub } from "../types/index";');
    writeText(root, "shared/types/index.ts", "export const scrub = () => 1;");
    expect(checkArchitectureBoundaries(root, ["verification-url"])).toEqual([
      `verification-url: ${SCRUBBER} -> shared/lib/bridge.ts -> shared/types/index.ts: forbidden dependency`,
    ]);
    writeText(root, SCRUBBER, "export const scrub = () => 1;");
    expect(checkArchitectureBoundaries(root, ["verification-url"])).toEqual([]);
    writeText(root, ANALYTICS, "export const render = () => 1;");
    expect(checkArchitectureBoundaries(root, ["verification-url"])).toEqual([
      `verification-url: google-analytics must reach ${SCRUBBER}`,
    ]);
  });

  it("rejects transitive full stability schemas but erases type-only imports", () => {
    const root = fixture();
    writeText(root, LIGHT, 'export const load = () => import("@shared/lib/bridge");');
    writeText(root, "shared/lib/bridge.ts", 'export * from "../types/stability";');
    writeText(root, "shared/types/stability.ts", "export const schema = {};");
    expect(checkArchitectureBoundaries(root, ["stability-light"])).toEqual([
      `stability-light: ${LIGHT} -> shared/lib/bridge.ts -> shared/types/stability.ts: forbidden dependency`,
    ]);
    writeText(root, LIGHT, 'import type { Schema } from "@shared/types/stability"; export const parse = () => 1;');
    expect(checkArchitectureBoundaries(root, ["stability-light"])).toEqual([]);
  });

  it("rejects zod package subpaths reached by a lightweight contract", () => {
    const root = fixture();
    writeText(root, LIGHT, 'export { schema } from "./bridge";');
    writeText(root, "src/lib/api-query-domains/bridge.ts", 'export { schema } from "zod/v4";');
    writeText(root, "node_modules/zod/package.json", JSON.stringify({ name: "zod", exports: { "./v4": "./v4/index.js" } }));
    writeText(root, "node_modules/zod/v4/index.js", "export const schema = {};");
    expect(checkArchitectureBoundaries(root, ["stability-light"])).toEqual([
      `stability-light: ${LIGHT} -> src/lib/api-query-domains/bridge.ts -> package:zod: forbidden dependency`,
    ]);
  });

  it("resolves import-equals and refuses escaped require loaders", () => {
    const root = fixture();
    writeText(root, RECAP, 'import recap = require("./weekly-recap"); export { recap };');
    writeText(root, "worker/src/cron/weekly-recap.ts", "export const run = () => 1;");
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      `recap-cost: ${RECAP} -> worker/src/cron/weekly-recap.ts: forbidden dependency`,
    ]);
    writeText(root, RECAP, 'const load = require; export const run = () => load("./weekly-recap");');
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      `recap-cost: ${RECAP}: non-literal executable dependency (escaped require)`,
    ]);
  });

  it.each(['import("./missing")', 'require(target)', 'import("node:not-a-real-builtin")'])("fails closed on unresolved graph edges: %s", (load) => {
    const root = fixture();
    writeText(root, RECAP, `export const run = (target: string) => ${load};`);
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      expect.stringMatching(/recap-cost: .*: (unresolved dependency|non-literal executable dependency)/),
    ]);
  });

  it("expands template imports rather than hiding executable dependencies", () => {
    const root = fixture();
    writeText(root, RECAP, 'export const load = (id: string) => import(`./data/${id}.ts`);');
    writeText(root, "worker/src/cron/data/safe.ts", "export const value = 1;");
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([]);
    writeText(root, "worker/src/cron/data/weekly-recap.ts", "export const value = 1;");
    expect(checkArchitectureBoundaries(root, ["recap-cost"])).toEqual([
      `recap-cost: ${RECAP} -> worker/src/cron/data/weekly-recap.ts: forbidden dependency`,
    ]);
  });
});
