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

  it("rejects the fat stablecoin registry from a client bundle", async () => {
    const root = makeRoot();
    writeText(root, "src/client.tsx", '"use client";\nimport { coins } from "@shared/lib/stablecoins/registry";\nexport { coins };\n');
    writeText(root, "shared/lib/stablecoins/registry.ts", "export const coins = [];\n");

    const result = await checkRuntimeReachabilityPolicy(policy("client-registry"), root);
    expect(result.violations).toEqual([
      { entrypoint: "src/client.tsx", forbidden: "shared/lib/stablecoins/registry.ts", kind: "reachable" },
    ]);
  });
});
