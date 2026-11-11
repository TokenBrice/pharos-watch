import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  classifyChangedFiles,
  classifyDeployChanges,
  emitGithubOutputs,
  hasCriticalCssPipelineImpact,
  hasDeployImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
  hasV9ResourceImpact,
} from "../ci/classify-deploy-changes.ts";
import { DEPLOY_IMPACT_REGISTRY } from "../lib/automation-registry.mjs";
import { splitNullDelimited } from "../lib/changed-files.mts";
import { hasLaneInputImpact, hasPagesArtifactImpact } from "../lib/lane-input-closure.mts";
import { collectModuleSpecifiers } from "../lib/pr-import-graph.mts";

describe("contracts workspace deployment selection", () => {
  it("keeps source-only contracts in both deployed runtime surfaces", () => {
    expect(classifyChangedFiles(["shared/contracts/api-meta.ts"])).toMatchObject({
      pagesChanged: true,
      pagesArtifactRequired: true,
      pagesDeployRequired: true,
      workerChanged: true,
      workerDeployRequired: true,
    });
    expect(hasWorkerReleaseImpact(["shared/contracts/api-meta.ts"])).toBe(true);
    expect(hasPagesPublishImpact(["shared/contracts/api-meta.ts"])).toBe(true);
  });
});

describe("Pages artifact selection", () => {
  it.each([
    "src/app/page.tsx",
    "src/components/header.tsx",
    "src/styles/tokens/semantic.css",
    "src/assets/fonts/Geist-Regular.woff2",
    "src/data/blog/posts/pharos-at-six-months.md",
    "src/app/favicon.ico",
    "src/app/robots.ts",
    "next.config.mjs",
    "tailwind.config.ts",
    "postcss.config.cjs",
    "shared/contracts/package.json",
    "scripts/build-data/build-stablecoin-detail-snapshots.ts",
    "scripts/maintenance/generate-depeg-event-search-data.ts",
    "scripts/build-data/generate-stablecoin-client-projections.ts",
    "scripts/maintenance/inline-homepage-critical-css.ts",
    "scripts/maintenance/critical-css-worker.mjs",
    "scripts/maintenance/report-build-size.mjs",
    "scripts/ci/check-seo-static.mjs",
    "scripts/ci/check-feature-flag-inlining.ts",
    "scripts/ci/check-phishing-signatures.ts",
    "scripts/ci/run-pages-artifact-lane.ts",
  ])("requires the artifact lane for Pages/build-pipeline path %s", (path) => {
    expect(classifyChangedFiles([path])).toMatchObject({ pagesChanged: true, pagesArtifactRequired: true });
  });

  it.each(["docs/testing.md", "worker/src/api/health.ts", "worker/wrangler.toml"])(
    "does not require the lane for an isolated non-Pages path %s", (path) => {
      expect(classifyChangedFiles([path]).pagesArtifactRequired).toBe(false);
    },
  );

  it.each([
    // Agent tooling mirrors repository skills; none of it is compiled or read.
    ".claude/skills/ci-slim-pass/SKILL.md",
    ".codex/skills/ci-slim-pass/SKILL.md",
    ".agents/skills/ci-slim-pass/SKILL.md",
    ".impeccable/config.json",
    ".omp/config.yml",
  ])("validates a skill or agent-tooling change without building either lane %s", (path) => {
    expect(classifyChangedFiles([path])).toMatchObject({
      pagesArtifactRequired: false,
      v9ResourceRequired: false,
    });
  });

  it.each([
    // Deploys, but cannot change the static export the PR lane builds.
    "shared/lib/admin-gate.ts",
    "functions/api/admin/[[path]].ts",
    "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts",
  ])("validates without building for a Pages path outside the export closure %s", (path) => {
    expect(classifyChangedFiles([path])).toMatchObject({
      pagesChanged: true,
      pagesDeployRequired: true,
      pagesArtifactRequired: false,
    });
    expect(hasPagesPublishImpact([path])).toBe(true);
  });

  it.each([
    // The closure is built from the post-change tree, so a deleted module is in
    // no closure: base∪head semantics make every deletion an input.
    "src/app/legacy-route/page.tsx",
    "shared/lib/retired-helper.ts",
  ])("builds the artifact for a path the checkout no longer contains %s", (path) => {
    expect(existsSync(resolve(import.meta.dirname, "../..", path)), path).toBe(false);
    expect(classifyChangedFiles([path])).toMatchObject({ pagesChanged: true, pagesArtifactRequired: true });
  });

  it.each([
    "shared/lib/__tests__/retired-helper.test.ts",
    "worker/src/lib/__tests__/retired-helper.test-support.ts",
  ])("runs neither lane for a deleted test-only file %s", (path) => {
    expect(existsSync(resolve(import.meta.dirname, "../..", path)), path).toBe(false);
    expect(classifyChangedFiles([path])).toMatchObject({ pagesArtifactRequired: false, v9ResourceRequired: false });
  });

  it("keeps a deleted Worker module out of the export lane while v9 still runs", () => {
    const path = "worker/src/api/retired-route.ts";
    expect(existsSync(resolve(import.meta.dirname, "../..", path)), path).toBe(false);
    expect(classifyChangedFiles([path])).toMatchObject({ pagesArtifactRequired: false, v9ResourceRequired: true });
  });

  it("loads with plain node before any install, as the deploy plan job runs it", () => {
    // deploy-cloudflare.yml `plan` runs this CLI with `node` and no node_modules:
    // every runtime import must be a builtin or an explicit-extension repo module.
    const root = resolve(import.meta.dirname, "../..");
    // Package imports inside a function the classifier never calls.
    const lazyPackageImports = new Set(["scripts/lib/smoke-runtime.mjs -> playwright"]);
    const seen = new Set<string>();
    const problems: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const { specifiers, patterns } = collectModuleSpecifiers(readFileSync(resolve(root, file), "utf8"));
      if (patterns.length) problems.push(`${file}: computed import`);
      for (const specifier of specifiers) {
        if (isBuiltin(specifier)) continue;
        if (!specifier.startsWith(".")) {
          if (!lazyPackageImports.has(`${file} -> ${specifier}`)) problems.push(`${file} -> ${specifier} (package)`);
          continue;
        }
        const target = relative(root, resolve(dirname(resolve(root, file)), specifier)).replaceAll("\\", "/");
        if (!existsSync(resolve(root, target))) { problems.push(`${file} -> ${specifier} (not loadable by node)`); continue; }
        visit(target);
      }
    };
    visit("scripts/ci/classify-deploy-changes.ts");
    expect(problems).toEqual([]);
    expect(seen.size).toBeGreaterThan(5);
  });

  it("selects the lane for its own selector module", () => {
    expect(hasPagesArtifactImpact(["scripts/lib/lane-input-closure.mts"])).toBe(true);
    expect(classifyChangedFiles(["scripts/lib/lane-input-closure.mts"]).pagesArtifactRequired).toBe(true);
  });

  it.each(["docs/retired-runbook.md", ".claude/skills/ci-slim-pass/retired.md"])(
    "keeps an area neither lane reads out of the lane when it is deleted %s", (path) => {
      expect(existsSync(resolve(import.meta.dirname, "../..", path)), path).toBe(false);
      expect(classifyChangedFiles([path])).toMatchObject({
        pagesArtifactRequired: false,
        v9ResourceRequired: false,
      });
    },
  );

  it("keeps the export's on-disk inputs, which are never import edges", () => {
    for (const path of [
      "docs/depeg-detection.md",
      "public/_redirects",
      "public/datasets/stablecoins.json",
      "shared/data/stablecoins/coins/usdc-circle.json",
      "data/depeg-events/2024.json",
    ]) {
      expect(classifyChangedFiles([path]).pagesArtifactRequired, path).toBe(true);
    }
  });

  it("keeps every module behind the lane's npm scripts selected", () => {
    const scripts: Record<string, string> = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ).scripts;
    // Every repository path a lane command names, not just the first: a chained
    // command (`a.ts && b.ts`) must select the lane for each of its modules.
    const modulePath = /((?:scripts|src|shared|worker|functions)\/[\w./[\]-]+\.(?:[cm]?[jt]sx?|mjs))/g;
    for (const name of [
      "check:pages-artifact",
      "generated:compile-input",
      "generated:post-refresh",
      "postbuild",
      "check:pages-release",
      "check:feature-flag-inlining",
      "check:build-size",
      "check:phishing-signatures",
      "seo:check",
    ]) {
      const files = [...(scripts[name] ?? "").matchAll(modulePath)].map((match) => match[1]!);
      expect(files.length, name).toBeGreaterThan(0);
      for (const file of files) {
        expect(hasPagesArtifactImpact([file]), `${name} -> ${file}`).toBe(true);
      }
    }
  });

  it.each([[[]], [[""]], [["../outside.ts"]], [["/outside/page.tsx"]], [["src//app/page.tsx"]], [["unclassified/runtime.ts"]]])(
    "builds the artifact for an empty, malformed or unclassifiable diff %j", (files) => {
      expect(hasPagesArtifactImpact(files)).toBe(true);
    },
  );

  it("builds the artifact when the lane's closure cannot be built", () => {
    const missing = {
      existsSync: () => false,
      readFileSync: () => "",
      statSync: () => ({ isFile: () => true }),
    };
    expect(hasLaneInputImpact(["src/components/header.tsx"], {
      id: "unreadable-lane",
      roots: ["src/app/page.tsx"],
      ignoredPrefixes: ["src/"],
      deletionNonInputPrefixes: [],
    }, { fs: missing })).toBe(true);
  });

  it.each([
    "src/components/__tests__/header.test.tsx",
    "shared/lib/classification.spec.ts",
    "src/app/__tests__/page.test.tsx",
  ])("validates but does not build the artifact for test-only path %s", (path) => {
    expect(classifyChangedFiles([path])).toMatchObject({ pagesChanged: true, pagesArtifactRequired: false });
  });
});

describe("critical CSS pipeline selection", () => {
  it.each([
    "src/app/globals.css",
    "src/styles/tokens/semantic.css",
    "src/components/harbor/harbor.module.css",
    "tailwind.config.ts",
    "postcss.config.mjs",
    "next.config.ts",
    "scripts/maintenance/inline-homepage-critical-css.ts",
    "scripts/maintenance/critical-css-worker.mjs",
    "package.json",
    "package-lock.json",
  ])("requires the full critical-CSS pass for %s", (path) => {
    expect(classifyChangedFiles([path]).pagesCriticalCssFullPass).toBe(true);
    expect(hasCriticalCssPipelineImpact([path])).toBe(true);
  });

  it.each([
    "src/app/page.tsx",
    "src/components/header.tsx",
    "shared/data/stablecoins/coins/usdc-circle.json",
    "docs/testing.md",
  ])("permits the gate-scoped pass for %s", (path) => {
    expect(classifyChangedFiles([path]).pagesCriticalCssFullPass).toBe(false);
  });

  it.each([[[]], [[""]], [["../outside.css"]], [["../outside.ts"]], [["./src/app/page.tsx"]], [["src//app/page.tsx"]],
    [["/outside/page.tsx"]], [["src/app/../page.tsx"]], [["..\\outside.ts"]]])("fails closed to the full pass for unknown input %j", (files) => {
    expect(hasCriticalCssPipelineImpact(files)).toBe(true);
  });
});

describe("V9 resource selection", () => {
  it.each([
    "shared/lib/safety-score-v9/compile.ts",
    "shared/lib/safety-score-v9/new-module.ts",
    "worker/src/lib/safety-score-v9/publication-store.ts",
    "worker/src/lib/safety-score-v9/native-input.ts",
    "worker/src/lib/db-cache.ts",
    "worker/src/lib/safety-score-v9/report-cards-snapshot.ts",
    "worker/src/cron/safety-score-v9/compute-safety-score-v9.ts",
    "worker/src/lib/native-token-supply.ts",
    "worker/src/test-helpers/v9-fixed-input.ts",
    "worker/migrations/0263_safety_score_capture_archive.sql",
    "shared/test-utils/sqlite-d1.ts",
    "shared/lib/supply.ts",
    "shared/lib/stablecoins/full-catalog.ts",
    // Sources of generated artifacts the probe bundles (derived from the
    // registry's outputs inside the lane closure, not a restated artifact id).
    "shared/lib/classification.ts",
    "shared/data/dead-stablecoins.json",
    "shared/types/core.ts",
    "shared/data/stablecoins/coins/usdc-circle.json",
    "shared/data/safety-score-v9/methodology-policy-candidate-v1.json",
    "scripts/maintenance/run-v9-resource-lane.ts",
    "scripts/lib/lane-input-closure.mts",
    "scripts/build-data/generate-worker-stablecoin-catalog.ts",
    "scripts/ci/select-generated-artifacts.mts",
    "scripts/lib/changed-files.mts",
    "scripts/lib/local-bin.mts",
    "scripts/lib/wrangler-toml.mjs",
    "worker/scripts/measure-v9-resource.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-budget.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-fixture.test-support.ts",
    "worker/src/lib/__tests__/safety-score-v9-resource-probe.test-support.ts",
    "worker/wrangler.heavy.toml",
    ".ci/safety-score-v9-resource-budget.json",
    "package-lock.json",
    ".nvmrc",
    "tsconfig.test-typecheck.json",
  ])("selects the audited source/data/harness/toolchain input %s", (file) => {
    expect(classifyChangedFiles([file]).v9ResourceRequired).toBe(true);
  });

  it.each([
    "src/components/header.tsx",
    "worker/src/api/health.ts",
    "worker/src/cron/blacklist/sync-blacklist.ts",
    "worker/src/cron/dex-liquidity/persistence.ts",
    "worker/src/cron/sync-stablecoins/enrich-prices-shared.ts",
    "worker/scripts/list-curation-expiry-queue.ts",
    "scripts/build-data/build-stablecoin-detail-snapshots.ts",
    "docs/testing.md",
  ])("does not select the resource lane for unrelated input %s", (file) => {
    expect(classifyChangedFiles([file]).v9ResourceRequired).toBe(false);
  });

  it.each(["worker/src/lib/retired-cache.ts", "shared/lib/retired-v9-module.ts"])(
    "selects the resource lane for a path the checkout no longer contains %s", (file) => {
      expect(existsSync(resolve(import.meta.dirname, "../..", file)), file).toBe(false);
      expect(classifyChangedFiles([file]).v9ResourceRequired).toBe(true);
    },
  );

  it.each([
    { files: [] }, { files: [""] }, { files: ["../outside.ts"] },
    { files: ["/tmp/outside.ts"] }, { files: ["unclassified/runtime.ts"] },
  ])("fails closed for missing or unclassifiable file input $files", ({ files }) => {
    expect(hasV9ResourceImpact(files)).toBe(true);
  });

  it.each([
    { eventName: "workflow_dispatch" },
    { eventName: "push", headSha: "head" },
    { eventName: "push", baseSha: "base", headSha: "head", execFile: () => { throw new Error("diff failed"); } },
  ])("fails closed when change collection is unavailable: %j", (options) => {
    expect(classifyDeployChanges(options).v9ResourceRequired).toBe(true);
  });

  it("emits the resource selection for workflow matrix transport", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      emitGithubOutputs(classifyChangedFiles(["package-lock.json"]));
      expect(write).toHaveBeenCalledWith("v9_resource_required=true\n");
      write.mockClear();
      emitGithubOutputs(classifyChangedFiles(["src/components/header.tsx"]));
      expect(write).toHaveBeenCalledWith("v9_resource_required=false\n");
    } finally {
      write.mockRestore();
    }
  });
});

describe("emitGithubOutputs", () => {
  it("emits only the seven consumed workflow outputs while retaining classification fields", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const classification = classifyChangedFiles(["package-lock.json"]);
      emitGithubOutputs(classification);
      expect(write.mock.calls.map(([line]) => line)).toEqual([
        "docs_only=false\n",
        "pages_artifact_required=true\n",
        "pages_critical_css_full_pass=true\n",
        "pages_deploy_required=true\n",
        "playwright_firefox_required=false\n",
        "v9_resource_required=true\n",
        "worker_deploy_required=true\n",
      ]);
      expect(classification).toMatchObject({
        deployRequired: true,
        docsChanged: false,
        pagesChanged: true,
        workerChanged: true,
      });
    } finally {
      write.mockRestore();
    }
  });
});

describe("splitNullDelimited", () => {
  it("keeps a path containing a newline intact", () => {
    expect(splitNullDelimited("src/app/we\nird.tsx\0src/app/page.tsx\0")).toEqual([
      "src/app/we\nird.tsx",
      "src/app/page.tsx",
    ]);
  });
});

describe("hasWorkerDeployImpact", () => {
  it.each(["worker/wrangler.toml", "worker/wrangler.heavy.toml", "worker/src/index.heavy.ts"])(
    "selects the paired Worker release for %s",
    (file) => {
      expect(classifyChangedFiles([file])).toMatchObject({ workerChanged: true, workerDeployRequired: true });
    },
  );
  it("returns true for worker, shared, and workflow-infra changes", () => {
    expect(hasWorkerDeployImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerDeployImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
    expect(hasWorkerDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
  });

  it("does not run worker checks for known Pages-only shared helpers", () => {
    const pagesOnlySharedFiles = [
      "shared/lib/public-docs.ts",
      "shared/lib/pharosville-api-contract.ts",
      "shared/types/pharosville.ts",
      "shared/lib/selector/engine.ts",
      "shared/data/funding/costs.json",
    ];

    for (const file of pagesOnlySharedFiles) {
      expect(hasWorkerDeployImpact([file]), file).toBe(false);
      expect(hasWorkerReleaseImpact([file]), file).toBe(false);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
    }
  });
});

describe("hasPagesDeployImpact", () => {
  it("returns true for frontend, shared, and deploy-infra changes", () => {
    expect(hasPagesDeployImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasPagesDeployImpact(["src/lib/api.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["src/hooks/use-stablecoins.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["functions/api/admin/[[path]].ts"])).toBe(true);
    expect(hasPagesDeployImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-release.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-prepare.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/rebuild-pages.yml"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-llms-txt.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-docs-metadata.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/build-world-map-svg.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-markdown-exports.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-openapi-spec.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-postman-collection.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/wait-pages-release-marker.ts"])).toBe(true);
  });

  it("validates tests without treating them as publishable Pages changes", () => {
    const files = [
      "src/components/__tests__/header.test.tsx",
      "shared/lib/classification.spec.ts",
      "functions/__tests__/proxy.test.ts",
    ];

    expect(hasPagesDeployImpact(files)).toBe(true);
    expect(hasPagesPublishImpact(files)).toBe(false);
  });

});

describe("hasWorkerReleaseImpact", () => {
  it("returns true for Worker runtime, config, D1 migrations, root packages, and shared runtime changes", () => {
    expect(hasWorkerReleaseImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerReleaseImpact(["worker/wrangler.toml"])).toBe(true);
    expect(hasWorkerReleaseImpact(["worker/migrations/0107_example.sql"])).toBe(true);
    expect(hasWorkerReleaseImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
    expect(hasWorkerReleaseImpact(["shared/lib/classification.ts"])).toBe(true);
    expect(hasWorkerReleaseImpact(["package.json", "package-lock.json"])).toBe(true);
  });

  it("releases both surfaces for the donation ledger consumed by supporter claims", () => {
    expect(classifyChangedFiles(["shared/data/funding/donations.json"])).toMatchObject({
      workerChanged: true,
      workerDeployRequired: true,
      pagesChanged: true,
      pagesDeployRequired: true,
    });
  });
});

describe("hasDeployImpact", () => {
  it("deploys for deploy-classifier infrastructure but not validation-only tooling", () => {
    const deploySupportFiles = [
      "scripts/lib/deploy-impact.mts",
      "scripts/lib/automation-registry.mjs",
      "scripts/ci/classify-deploy-changes.ts",
      ".github/workflows/deploy-cloudflare.yml",
    ];

    for (const file of deploySupportFiles) {
      expect(hasDeployImpact([file]), file).toBe(true);
      expect(hasWorkerDeployImpact([file]), file).toBe(true);
      expect(hasWorkerReleaseImpact([file]), file).toBe(false);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
    }

    for (const file of [
      ".github/actions/setup-workspace/action.yml",
      "scripts/ci/check-env-contract.ts",
      "scripts/maintenance/run-all-tests.ts",
      "scripts/maintenance/run-pr-static-checks.ts",
    ]) {
      expect(hasDeployImpact([file]), file).toBe(false);
    }
  });

  it("derives deploy support impact from the structured automation registry", () => {
    const registryDeploySupportFiles = [
      ...DEPLOY_IMPACT_REGISTRY.fullDeployInfra.exactPaths,
      ...DEPLOY_IMPACT_REGISTRY.fullDeployGuardrails.exactPaths,
    ];

    for (const file of registryDeploySupportFiles) {
      expect(hasDeployImpact([file]), file).toBe(true);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
      expect(hasWorkerDeployImpact([file]), file).toBe(true);
    }
  });
});

describe("classifyDeployChanges", () => {
  it("requests Firefox only when changed sources select a browser-rendered artifact", () => {
    expect(classifyChangedFiles(["src/app/page.tsx"]).playwrightFirefoxRequired).toBe(true);
    expect(classifyChangedFiles(["scripts/maintenance/build-og-editorial.mjs"]).playwrightFirefoxRequired).toBe(true);
    expect(classifyChangedFiles(["src/lib/mechanism-explainer-registry.ts"]).playwrightFirefoxRequired).toBe(false);
    expect(classifyChangedFiles(["src/components/stablecoin-detail/mechanism-diagrams/example.tsx"]).playwrightFirefoxRequired).toBe(false);
    expect(classifyChangedFiles(["worker/src/lib/auth.ts"]).playwrightFirefoxRequired).toBe(false);
  });

  it("runs the full worker deploy path for non-push events", () => {
    const result = classifyDeployChanges({ eventName: "workflow_dispatch" });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
    expect(result.pagesCriticalCssFullPass).toBe(true);
    expect(result.docsOnly).toBe(false);
  });

  it("falls back to full worker deploy when the push base sha is unavailable", () => {
    const result = classifyDeployChanges({
      baseSha: "0000000000000000000000000000000000000000",
      eventName: "push",
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesArtifactRequired).toBe(true);
    expect(result.pagesCriticalCssFullPass).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
  });

  it.each([
    { name: "frontend-only", files: ["src/app/page.tsx", "docs/testing.md"], worker: false, pages: true, publish: true, docsOnly: false },
    { name: "worker-only", files: ["worker/src/api/health.ts", "docs/testing.md"], worker: true, pages: false, publish: false, docsOnly: false },
    { name: "mixed shared source", files: ["src/app/page.tsx", "shared/lib/classification.ts"], worker: true, pages: true, publish: true, docsOnly: false },
    { name: "root packages", files: ["package.json", "package-lock.json", "public/_redirects",
      "scripts/maintenance/run-pr-static-checks.ts", "scripts/maintenance/smoke-ui.mjs",
      "shared/lib/public-docs.ts", "src/app/pharosville/page.tsx"], worker: true, pages: true, publish: true, docsOnly: false },
    { name: "Pages workflow", files: [".github/workflows/pages-release.yml"], worker: false, pages: true, publish: true, docsOnly: false },
    { name: "Pages preparation workflow", files: [".github/workflows/pages-prepare.yml"], worker: false, pages: true, publish: true, docsOnly: false },
    { name: "internal docs", files: ["docs/testing.md", "docs/process/notes.md"], worker: false, pages: false, publish: false, docsOnly: true },
    { name: "Pages tests", files: ["src/components/__tests__/header.test.tsx"], worker: false, pages: true, publish: false, docsOnly: false },
    { name: "source renamed to test", files: ["src/components/header.tsx", "src/components/__tests__/header.test.tsx"],
      worker: false, pages: true, publish: true, docsOnly: false },
  ])("routes $name push diffs", ({ files, worker, pages, publish, docsOnly }) => {
    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile: (_file, args) => args[0] === "ls-tree" ? "" : files.join("\0"),
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });
    expect(result).toMatchObject({
      deployRequired: worker || pages,
      workerChanged: worker,
      workerDeployRequired: worker,
      pagesChanged: pages,
      pagesArtifactRequired: publish,
      pagesDeployRequired: publish,
      docsOnly,
      changedFiles: [...files].sort(),
    });
  });

  it("routes the editorial-style generator source through full PR checks", () => {
    const result = classifyChangedFiles(["docs/editorial-style.md"]);

    expect(result.deployRequired).toBe(false);
    expect(result.docsOnly).toBe(false);
  });

  it("passes push refs to git diff as arguments", () => {
    const received: unknown[] = [];
    const execFile = (cmd: string, args: readonly string[]) => {
      received.push([cmd, args]);
      return "src/app/page.tsx\0";
    };

    classifyDeployChanges({
      baseSha: "aaa; touch /tmp/should-not-run",
      eventName: "push",
      execFile,
      headSha: "bbb && echo injected",
    });

    expect(received).toEqual([
      ["git", ["diff", "--name-only", "--no-renames", "-z", "aaa; touch /tmp/should-not-run...bbb && echo injected"]],
    ]);
  });
});
