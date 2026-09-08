import { afterEach, describe, expect, it } from "vitest";

import { checkRuntimeReachabilityPolicy } from "../ci/check-runtime-reachability";
import { getRuntimeReachabilityPolicy } from "../lib/runtime-reachability-policies.mts";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-runtime-reachability");

afterEach(cleanup);

function policy(id: string) {
  const found = getRuntimeReachabilityPolicy(id);
  if (!found) throw new Error(`Missing test policy: ${id}`);
  return found;
}

describe("runtime reachability policies", () => {
  it("rejects a DOM-only shared module reached by a scheduled runner", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled.ts", 'const loaders = { bad: () => import("./scheduled/bad") };\n');
    writeText(root, "worker/src/handlers/scheduled/bad.ts", 'import { href } from "@shared/lib/browser";\nexport { href };\n');
    writeText(root, "shared/lib/browser.ts", "export const href = window.location.href;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.violations).toEqual([
      { entrypoint: "worker/src/handlers/scheduled/bad.ts", forbidden: "shared/lib/browser.ts", kind: "reachable" },
    ]);
  });

  it("rejects the full registry from a mint-burn lane", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts", 'import { coins } from "@shared/lib/stablecoins/registry";\nexport { coins };\n');
    writeText(root, "worker/src/handlers/scheduled/five-minute-telegram.ts", "export const ok = true;\n");
    writeText(root, "worker/src/cron/prune-detail-cache.ts", "export const ok = true;\n");
    writeText(root, "worker/src/cron/snapshot-supply.ts", "export const ok = true;\n");
    writeText(root, "shared/lib/stablecoins/registry.ts", "export const coins = [];\n");

    const result = await checkRuntimeReachabilityPolicy(policy("mint-burn"), root);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts",
      forbidden: "shared/lib/stablecoins/registry.ts",
      kind: "reachable",
    });
  });

  it("rejects Worker implementation reachability from Pages Functions", async () => {
    const root = makeRoot();
    writeText(root, "functions/example.ts", 'import { secret } from "../worker/src/secret";\nexport { secret };\n');
    writeText(root, "worker/src/secret.ts", 'export const secret = "no";\n');

    const result = await checkRuntimeReachabilityPolicy(policy("pages-functions"), root);
    expect(result.violations).toEqual([
      { entrypoint: "functions/example.ts", forbidden: "worker/src/secret.ts", kind: "reachable" },
    ]);
  });

  it("rejects the full registry from memory-constrained cron lanes", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled/hourly-blacklist.ts", 'import { coins } from "@shared/lib/stablecoins/registry";\nexport { coins };\n');
    writeText(root, "worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts", "export const ok = true;\n");
    writeText(root, "worker/src/handlers/scheduled/daily-0300.ts", "export const ok = true;\n");
    writeText(root, "shared/lib/stablecoins/registry.ts", "export const coins = [];\n");

    const result = await checkRuntimeReachabilityPolicy(policy("memory-constrained-cron"), root);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled/hourly-blacklist.ts",
      forbidden: "shared/lib/stablecoins/registry.ts",
      kind: "reachable",
    });
  });

  it("rejects the fat stablecoin registry from a client bundle", async () => {
    const root = makeRoot();
    writeText(root, "src/client.tsx", '"use client";\nimport { coins } from "@shared/lib/stablecoins/registry";\nexport { coins };\n');
    writeText(root, "shared/lib/stablecoins/registry.ts", "export const coins = [];\n");

    const result = await checkRuntimeReachabilityPolicy(policy("client-registry"), root);
    expect(result.violations).toEqual([
      { entrypoint: "src/client.tsx", forbidden: "shared/lib/stablecoins/registry.ts", kind: "reachable" },
    ]);
  });

  it("limits importer allowances to each entrypoint's reachable graph", async () => {
    const root = makeRoot();
    writeText(root, "src/allowed.ts", 'export { value } from "./restricted";');
    writeText(root, "src/denied.ts", 'export { value } from "./restricted";');
    writeText(root, "src/restricted.ts", "export const value = 42;");
    writeText(root, "src/first.ts", 'export { value } from "./allowed";');
    writeText(root, "src/second.ts", 'export { value } from "./denied";');
    const fixturePolicy = {
      ...policy("client-registry"),
      entrypoints: { kind: "paths" as const, paths: ["src/first.ts", "src/second.ts"] },
      forbidden: {
        kind: "paths" as const,
        paths: ["src/restricted.ts"],
        allowedImporters: [{ prefix: "src/restricted.ts", importers: ["src/allowed.ts"] }],
      },
    };

    expect((await checkRuntimeReachabilityPolicy(fixturePolicy, root)).violations).toEqual([
      { entrypoint: "src/second.ts", forbidden: "src/restricted.ts", kind: "reachable" },
    ]);
    writeText(root, "src/first.ts", 'export { value } from "./allowed"; export { value as denied } from "./denied";');
    expect((await checkRuntimeReachabilityPolicy(fixturePolicy, root)).violations).toEqual([
      { entrypoint: "src/first.ts", forbidden: "src/restricted.ts", kind: "reachable" },
      { entrypoint: "src/second.ts", forbidden: "src/restricted.ts", kind: "reachable" },
    ]);
  });

  it("rejects forbidden direct imports even when unused exports are tree-shaken", async () => {
    const root = makeRoot();
    writeText(root, "src/entry.ts", 'import { value } from "./restricted"; export const ok = true;');
    writeText(root, "src/restricted.ts", "export const value = 42;");
    const result = await checkRuntimeReachabilityPolicy({
      ...policy("client-registry"),
      entrypoints: { kind: "paths", paths: ["src/entry.ts"] },
      forbidden: { kind: "paths", paths: [] },
      directImports: { entrypoints: ["src/entry.ts"], forbiddenSpecifiers: ["./restricted"] },
    }, root);
    expect(result.violations).toEqual([
      { entrypoint: "src/entry.ts", forbidden: "./restricted", kind: "direct-import" },
    ]);
  });
});
