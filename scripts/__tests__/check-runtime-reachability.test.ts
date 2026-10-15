import { afterEach, describe, expect, it } from "vitest";

import { checkRuntimeReachabilityPolicy } from "../ci/check-runtime-reachability";
import { getRuntimeReachabilityPolicy } from "../lib/runtime-reachability-policies.mts";
import { createTempRepoTracker } from "./helpers/test-state";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE } from "../../shared/lib/scheduled-runner-registry";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-runtime-reachability");

afterEach(cleanup);

function policy(id: string) {
  const found = getRuntimeReachabilityPolicy(id);
  if (!found) throw new Error(`Missing test policy: ${id}`);
  return found;
}

function writePublicationInvocationFixture(root: string, loadBeforeGuard = false): void {
  const ownerKeys = [...new Set(Object.values(SCHEDULED_SLOT_PLANS_BY_SCHEDULE)
    .filter((plan) => plan.worker === "heavy").map((plan) => plan.scheduleKey))];
  writeText(root, "worker/src/handlers/scheduled.ts", `
export const SLOT_RUNNER_LOADER_BY_KEY = {
  ${ownerKeys.map((key) => `${key}: () => import("./scheduled/${key}")`).join(",\n")},
  publicOnly: () => import("./scheduled/public-only")
};
export async function handleScheduledEvent(slotPlan, workerRole) {
  const loadRunner = slotPlan ? SLOT_RUNNER_LOADER_BY_KEY[slotPlan.scheduleKey] : undefined;
  ${loadBeforeGuard ? "await loadRunner();" : ""}
  if (slotPlan.worker !== workerRole) { return; }
  ${loadBeforeGuard ? "" : "await loadRunner();"}
}
`);
  for (const key of ownerKeys) writeText(root, `worker/src/handlers/scheduled/${key}.ts`, "export const run = true;\n");
  writeText(root, "worker/src/handlers/scheduled/public-only.ts", 'export { coins } from "@shared/lib/stablecoins/registry";\n');
  writeText(root, "shared/lib/stablecoins/registry.ts", 'export const coins = ["full-catalog"];\n');
  writeText(root, "worker/src/handlers/scheduled/context.ts", "export const context = true;\n");
  writeText(root, "worker/src/workflows/safety-score-v9-publication.entry.ts", "export const workflow = true;\n");
  writeText(root, "worker/src/cron/compute-safety-score-v9.ts", `
export { default as shock } from "@shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
export { default as incidents } from "@shared/data/safety-score-v9/incident-runtime-v1.generated.json";
`);
  writeText(root, "worker/src/lib/safety-score-v9/candidate.ts", "export const candidate = true;\n");
  writeText(root, "shared/data/safety-score-v9/shock-coverage-measurements-v1.json", '{"measurements":[1]}\n');
  writeText(root, "shared/data/safety-score-v9/incident-runtime-v1.generated.json", '{"incidents":[1]}\n');
  writeText(root, "worker/wrangler.heavy.toml", '[alias]\n"#pharos-full-catalog" = "./src/lib/full-stablecoin-catalog.ts"\n');
  writeText(root, "worker/src/lib/full-stablecoin-catalog.ts", 'export { default as coins } from "@shared/data/stablecoins/coins.worker-full.generated.json";\n');
  writeText(root, "shared/data/stablecoins/coins.worker-full.generated.json", '[{"id":"packed-full"}]\n');
}

describe("runtime reachability policies", () => {
  it("proves heavy-owned invocation reachability while excluding rejected non-owner lazy slots", async () => {
    const root = makeRoot();
    writePublicationInvocationFixture(root);
    const result = await checkRuntimeReachabilityPolicy(policy("safety-score-v9-publication"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("fails closed when role rejection moves after loading a runner", async () => {
    const root = makeRoot();
    writePublicationInvocationFixture(root, true);
    const result = await checkRuntimeReachabilityPolicy(policy("safety-score-v9-publication"), root);
    expect(result.configurationErrors).toContain("Scheduled owner role rejection must return before invoking loadRunner()");
  });

  it("reports the exact chain for a reintroduced transitive full-catalog alias import", async () => {
    const root = makeRoot();
    writePublicationInvocationFixture(root);
    writeText(root, "worker/src/lib/safety-score-v9/candidate.ts", 'export { coins } from "./prep-regression";\n');
    writeText(root, "worker/src/lib/safety-score-v9/prep-regression.ts", 'export { coins } from "#pharos-full-catalog";\n');
    const result = await checkRuntimeReachabilityPolicy(policy("safety-score-v9-publication"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/lib/safety-score-v9/candidate.ts",
      forbidden: "shared/data/stablecoins/coins.worker-full.generated.json",
      kind: "reachable",
      chain: [
        "worker/src/lib/safety-score-v9/candidate.ts",
        "worker/src/lib/safety-score-v9/prep-regression.ts",
        "worker/src/lib/full-stablecoin-catalog.ts",
        "shared/data/stablecoins/coins.worker-full.generated.json",
      ],
    });
  });

  it("requires shock measurements and generated incident evidence to stay reachable", async () => {
    const root = makeRoot();
    writePublicationInvocationFixture(root);
    writeText(root, "worker/src/cron/compute-safety-score-v9.ts", "export const compute = true;\n");
    const result = await checkRuntimeReachabilityPolicy(policy("safety-score-v9-publication"), root);
    expect(result.configurationErrors).toEqual([
      "Required runtime evidence is not reachable: shared/data/safety-score-v9/shock-coverage-measurements-v1.json",
      "Required runtime evidence is not reachable: shared/data/safety-score-v9/incident-runtime-v1.generated.json",
    ]);
  });

  it("rejects a DOM-only shared module reached by a scheduled runner", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled.ts", 'const loaders = { bad: () => import("./scheduled/bad") };\n');
    writeText(root, "worker/src/handlers/scheduled/bad.ts", 'import { href } from "@shared/lib/browser";\nexport { href };\n');
    writeText(root, "shared/lib/browser.ts", "export const href = window.location.href;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);
    expect(result.configurationErrors).toEqual([]);
    expect(result.entrypointCount).toBe(2);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled/bad.ts",
      forbidden: "shared/lib/browser.ts",
      kind: "reachable",
    });
  });

  it("rejects a missing scheduled loader source", async () => {
    const root = makeRoot();

    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);

    expect(result.entrypointCount).toBe(0);
    expect(result.configurationErrors).toEqual([
      "Configured scheduled loader source is missing: worker/src/handlers/scheduled.ts",
    ]);
  });

  it("rejects a scheduled loader with no dynamic-import entrypoints", async () => {
    const root = makeRoot();
    writeText(root, "worker/src/handlers/scheduled.ts", "export const scheduled = true;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);

    expect(result.entrypointCount).toBe(1);
    expect(result.configurationErrors).toEqual([
      "Configured scheduled loader source has no dynamic-import entrypoints: worker/src/handlers/scheduled.ts",
    ]);
  });

  it("rejects a forbidden import directly from the scheduled handler", async () => {
    const root = makeRoot();
    writeText(
      root,
      "worker/src/handlers/scheduled.ts",
      'import { href } from "@shared/lib/browser";\nconst loaders = { ok: () => import("./scheduled/ok") };\nexport { href, loaders };\n',
    );
    writeText(root, "worker/src/handlers/scheduled/ok.ts", "export const ok = true;\n");
    writeText(root, "shared/lib/browser.ts", "export const href = window.location.href;\n");

    const result = await checkRuntimeReachabilityPolicy(policy("scheduled"), root);

    expect(result.configurationErrors).toEqual([]);
    expect(result.violations).toContainEqual({
      entrypoint: "worker/src/handlers/scheduled.ts",
      forbidden: "shared/lib/browser.ts",
      kind: "reachable",
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
    writeText(root, "worker/src/handlers/scheduled/five-minute-telegram.ts", 'export { buildAlertContextLines } from "../../cron/telegram-alert-context";\n');
    writeText(root, "worker/src/cron/telegram-alert-context.ts", `import { ${loader} } from "../lib/${module}";\nexport const buildAlertContextLines = ${loader};\n`);
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
