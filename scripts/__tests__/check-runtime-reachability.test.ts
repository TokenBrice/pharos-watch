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


function writePublicInitializationFixture(root: string): void {
  const selector = policy("public-safety-projections").entrypoints;
  if (selector.kind !== "paths") throw new Error("Public initialization roots must be explicit");
  for (const entrypoint of selector.paths) writeText(root, entrypoint, "export const publicRoot = true;\n");
}

describe("runtime reachability policies", () => {
  it.each([
    ["worker/src/lib/safety-score-v9/accepted-projections.ts", "./safety-score-v9/accepted-projections"],
    ["worker/src/lib/safety-score-v9/accepted-projection-readers.ts", "./safety-score-v9/accepted-projection-readers"],
  ] as const)("rejects transitive public HTTP initialization of %s", async (forbidden, specifier) => {
    const root = makeRoot();
    writePublicInitializationFixture(root);
    const entrypoint = "worker/src/handlers/http/request-dispatch.ts";
    const intermediary = "worker/src/lib/public-projection-regression.ts";
    writeText(root, entrypoint, 'export { heavy } from "../../lib/public-projection-regression";\n');
    writeText(root, intermediary, `export { default as heavy } from "${specifier}";\n`);
    writeText(root, forbidden, forbidden.endsWith(".json") ? '{"heavy":true}\n' : "export default true;\n");
    const result = await checkRuntimeReachabilityPolicy(policy("public-safety-projections"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toContainEqual({
      entrypoint, forbidden, kind: "reachable",
    });
  });

  it("covers the public entry, HTTP dispatch and all public V9 storage roots", () => {
    expect(policy("public-safety-projections").entrypoints).toEqual({
      kind: "paths",
      paths: [
        "worker/src/index.ts",
        "worker/src/handlers/http/request-dispatch.ts",
        "worker/src/lib/report-cards-v9-cache.ts",
        "worker/src/lib/public-health-assessment.ts",
        "worker/src/lib/safety-score-v9/publication-store.ts",
        "worker/src/lib/safety-score-index.ts",
      ],
    });
  });

  it("excludes deferred scheduled/admin imports but rejects static imports from the public entry", async () => {
    const root = makeRoot();
    writePublicInitializationFixture(root);
    const entrypoint = "worker/src/index.ts";
    const forbidden = "worker/src/lib/safety-score-v9/accepted-projection-readers.ts";
    writeText(root, entrypoint, 'export const scheduled = () => import("./handlers/scheduled");\n');
    writeText(root, "worker/src/handlers/http/request-dispatch.ts", 'export { admin } from "../../routes/registry";\n');
    writeText(root, "worker/src/routes/registry.ts", 'export { admin } from "./admin-routes";\n');
    writeText(root, "worker/src/routes/admin-routes.ts", 'export const admin = () => import("../handlers/admin");\n');
    writeText(root, "worker/src/handlers/scheduled.ts", 'export { default } from "../lib/safety-score-v9/accepted-projection-readers";\n');
    writeText(root, "worker/src/handlers/admin.ts", 'export { default } from "../lib/safety-score-v9/accepted-projections";\n');
    writeText(root, forbidden, "export default true;\n");
    writeText(root, "worker/src/lib/safety-score-v9/accepted-projections.ts", "export default true;\n");
    const deferred = await checkRuntimeReachabilityPolicy(policy("public-safety-projections"), root);
    expect(deferred.configurationErrors).toEqual([]);
    expect(deferred.violations).toEqual([]);

    writeText(root, entrypoint, 'export { default } from "./lib/safety-score-v9/accepted-projection-readers";\n');
    const initialized = await checkRuntimeReachabilityPolicy(policy("public-safety-projections"), root);
    expect(initialized.configurationErrors).toEqual([]);
    expect(initialized.violations).toContainEqual({
      entrypoint, forbidden, kind: "reachable",
    });
  });


  function writeScheduledFixture(root: string): void {
    writeText(root, "worker/src/handlers/scheduled.ts", "export const dispatch = true;\n");
    for (const role of ["public", "heavy"]) {
      writeText(root, `worker/src/handlers/scheduled/${role}-runners.ts`,
        `export const loaders = { ok: () => import("./${role}-ok") };\n`);
      writeText(root, `worker/src/handlers/scheduled/${role}-ok.ts`, "export const ok = true;\n");
    }
  }

  it.each(["public", "heavy"])("rejects a DOM-only shared module reached by a %s runner", async (role) => {
    const root = makeRoot();
    writeScheduledFixture(root);
    writeText(root, `worker/src/handlers/scheduled/${role}-ok.ts`,
      'import { href } from "@shared/lib/browser";\nexport { href };\n');
    writeText(root, "shared/lib/browser.ts", "export const href = window.location.href;\n");
    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.entrypointCount).toBe(5);
    expect(result.violations).toContainEqual({
      entrypoint: `worker/src/handlers/scheduled/${role}-ok.ts`,
      forbidden: "shared/lib/browser.ts", kind: "reachable",
    });
  });

  it("rejects missing dispatcher and role-map sources", async () => {
    const root = makeRoot();
    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.entrypointCount).toBe(0);
    expect(result.configurationErrors).toEqual([
      "Configured scheduled loader source is missing: worker/src/handlers/scheduled.ts",
      "Configured scheduled loader source is missing: worker/src/handlers/scheduled/public-runners.ts",
      "Configured scheduled loader source is missing: worker/src/handlers/scheduled/heavy-runners.ts",
    ]);
  });

  it.each(["public", "heavy"])("rejects a %s map with no dynamic-import entrypoints", async (role) => {
    const root = makeRoot();
    writeScheduledFixture(root);
    writeText(root, `worker/src/handlers/scheduled/${role}-runners.ts`, "export const loaders = {};\n");
    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.entrypointCount).toBe(4);
    expect(result.configurationErrors).toEqual([
      `Configured scheduled loader source has no dynamic-import entrypoints: worker/src/handlers/scheduled/${role}-runners.ts`,
    ]);
  });

  it("rejects a forbidden import directly from the scheduled handler", async () => {
    const root = makeRoot();
    writeScheduledFixture(root);
    writeText(root, "worker/src/handlers/scheduled.ts", 'export { href } from "@shared/lib/browser";\n');
    writeText(root, "shared/lib/browser.ts", "export const href = window.location.href;\n");
    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled.ts",
      forbidden: "shared/lib/browser.ts", kind: "reachable",
    });
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

  it("pins the ADR-24 full V9 snapshot boundary on the Telegram lane", () => {
    const telegramPolicy = policy("mint-burn");
    expect(telegramPolicy.entrypoints).toMatchObject({
      kind: "paths",
      paths: expect.arrayContaining(["worker/src/handlers/scheduled/five-minute-telegram.ts"]),
    });
    expect(telegramPolicy.forbidden).toMatchObject({
      kind: "paths",
      paths: expect.arrayContaining([
        "worker/src/lib/safety-score-active-source.ts",
        "worker/src/lib/report-cards-v9-cache.ts",
      ]),
    });
    expect(telegramPolicy.remediation).toContain("ADR-24");
  });

  it.each([
    ["safety-score-active-source", "loadActiveSafetyScoreSource"],
    ["report-cards-v9-cache", "loadPublishedReportCardsV9Snapshot"],
  ])("rejects full V9 snapshot reachability through Telegram context: %s", async (module, loader) => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts", "export const ok = true;\n");
    writeText(root, "worker/src/handlers/scheduled/five-minute-telegram.ts", 'export { buildAlertContextLines } from "../../cron/telegram/sources/telegram-alert-context";\n');
    writeText(root, "worker/src/cron/telegram/sources/telegram-alert-context.ts", `import { ${loader} } from "../../../lib/${module}";\nexport const buildAlertContextLines = ${loader};\n`);
    writeText(root, `worker/src/lib/${module}.ts`, `export const ${loader} = () => true;\n`);
    writeText(root, "worker/src/cron/prune-detail-cache.ts", "export const ok = true;\n");
    writeText(root, "worker/src/cron/snapshot-supply.ts", "export const ok = true;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("mint-burn"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled/five-minute-telegram.ts",
      forbidden: `worker/src/lib/${module}.ts`,
      kind: "reachable",
    });
  });

  it("allows the thin Telegram envelope with a type-only full source import", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts", "export const ok = true;\n");
    writeText(root, "worker/src/handlers/scheduled/five-minute-telegram.ts", 'export { loadActiveAlertSafetySourceAssessment } from "../../lib/alert-safety-source-cache";\n');
    writeText(root, "worker/src/lib/alert-safety-source-cache.ts", 'import type { ActiveSafetyScoreSource } from "./safety-score-active-source";\nexport const loadActiveAlertSafetySourceAssessment = (): Pick<ActiveSafetyScoreSource, "kind"> => ({ kind: "v9" });\n');
    writeText(root, "worker/src/lib/safety-score-active-source.ts", 'export interface ActiveSafetyScoreSource { kind: "v9" }\nexport const loadActiveSafetyScoreSource = () => ({ kind: "v9" });\n');
    writeText(root, "worker/src/cron/prune-detail-cache.ts", "export const ok = true;\n");
    writeText(root, "worker/src/cron/snapshot-supply.ts", "export const ok = true;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("mint-burn"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toEqual([]);
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
