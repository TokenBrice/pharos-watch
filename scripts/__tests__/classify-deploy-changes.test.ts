import { describe, expect, it } from "vitest";

import {
  classifyDeployChanges,
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasPagesUiImpact,
  hasWorkerPackagePromotionImpact,
  hasWorkerDeployImpact,
  hasWorkerPromotionImpact,
  normalizeChangedFiles,
} from "../ci/classify-deploy-changes.mjs";
import { DEPLOY_IMPACT_REGISTRY } from "../lib/automation-registry.mjs";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";

describe("normalizeChangedFiles", () => {
  it("normalizes separators and removes blank lines", () => {
    expect(normalizeChangedFiles("worker\\src\\index.ts\n\nsrc/app/page.tsx\n")).toEqual([
      "worker/src/index.ts",
      "src/app/page.tsx",
    ]);
  });
});

describe("hasWorkerDeployImpact", () => {
  it("returns false for frontend-only changes", () => {
    expect(hasWorkerDeployImpact(["src/app/page.tsx", "src/components/header.tsx", "docs/testing.md"])).toBe(false);
  });

  it("returns true for worker, shared, and workflow-infra changes", () => {
    expect(hasWorkerDeployImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerDeployImpact(["shared/data/stablecoins/usd-major.json"])).toBe(true);
    expect(hasWorkerDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
  });

  it("does not run worker checks for known Pages-only shared helpers", () => {
    const pagesOnlySharedFiles = [
      "shared/lib/public-docs.ts",
      "shared/lib/pharosville-api-contract.ts",
      "shared/types/pharosville.ts",
      "shared/lib/selector/engine.ts",
      "shared/data/funding/donations.json",
    ];

    for (const file of pagesOnlySharedFiles) {
      expect(hasWorkerDeployImpact([file]), file).toBe(false);
      expect(hasWorkerPromotionImpact([file]), file).toBe(false);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
    }
  });
});

describe("hasPagesDeployImpact", () => {
  it("returns false for worker-only changes", () => {
    expect(
      hasPagesDeployImpact(["worker/src/api/health.ts", "worker/src/cron/sync-stablecoins.ts", "docs/testing.md"]),
    ).toBe(false);
  });

  it("returns true for frontend, shared, and deploy-infra changes", () => {
    expect(hasPagesDeployImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasPagesDeployImpact(["src/lib/api.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["src/hooks/use-stablecoins.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["functions/api/admin/[[path]].ts"])).toBe(true);
    expect(hasPagesDeployImpact(["shared/data/stablecoins/usd-major.json"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-release.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/rebuild-pages.yml"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-llms-txt.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-docs-metadata.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/build-world-map-svg.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-markdown-exports.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-openapi-spec.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/generate-postman-collection.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/maintenance/wait-pages-release-marker.mjs"])).toBe(true);
  });

  it("validates tests without treating them as publishable Pages changes", () => {
    const files = [
      "src/components/__tests__/header.test.tsx",
      "shared/lib/classification.spec.ts",
      "functions/__tests__/proxy.test.ts",
    ];

    expect(hasPagesDeployImpact(files)).toBe(true);
    expect(hasPagesPublishImpact(files)).toBe(false);
    expect(hasPagesUiImpact(files)).toBe(false);
  });

  it("publishes every Markdown source rendered by the public docs route", () => {
    for (const doc of PUBLIC_DOCS) {
      const file = `docs/${doc.source}`;
      expect(hasPagesDeployImpact([file]), file).toBe(true);
      expect(hasPagesPublishImpact([file]), file).toBe(true);
    }
  });
});

describe("hasOnlyInternalDocsImpact", () => {
  it("recognizes internal docs but excludes public docs and mixed changes", () => {
    expect(hasOnlyInternalDocsImpact(["docs/testing.md", "README.md"])).toBe(true);
    expect(hasOnlyInternalDocsImpact(["docs/api-reference.md"])).toBe(false);
    expect(hasOnlyInternalDocsImpact(["docs/testing.md", "scripts/__tests__/example.test.ts"])).toBe(false);
  });
});

describe("hasPagesUiImpact", () => {
  it("returns false for workflow-only and script-only Pages changes", () => {
    expect(
      hasPagesUiImpact([
        ".github/workflows/pages-release.yml",
        "scripts/maintenance/generate-markdown-exports.ts",
        "scripts/lib/validation-lanes.mjs",
      ]),
    ).toBe(false);
  });

  it("returns true for frontend/runtime surface changes", () => {
    expect(hasPagesUiImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasPagesUiImpact(["public/logo.svg"])).toBe(true);
    expect(hasPagesUiImpact(["shared/lib/classification.ts"])).toBe(true);
    expect(hasPagesUiImpact(["functions/api/admin/[[path]].ts"])).toBe(true);
    expect(hasPagesUiImpact(["data/depeg-events.json"])).toBe(true);
  });
});

describe("hasWorkerPromotionImpact", () => {
  it("returns true only for Worker runtime, Worker config, D1 migrations, and shared runtime changes", () => {
    expect(hasWorkerPromotionImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerPromotionImpact(["worker/wrangler.toml"])).toBe(true);
    expect(hasWorkerPromotionImpact(["worker/migrations/0107_example.sql"])).toBe(true);
    expect(hasWorkerPromotionImpact(["shared/data/stablecoins/usd-major.json"])).toBe(true);
    expect(hasWorkerPromotionImpact(["shared/lib/classification.ts"])).toBe(true);
  });

  it("returns false for validation, root package, tests, and known Pages-only shared changes", () => {
    expect(hasWorkerPromotionImpact(["package.json", "package-lock.json"])).toBe(false);
    expect(hasWorkerPromotionImpact(["scripts/lib/validation-lanes.mjs"])).toBe(false);
    expect(hasWorkerPromotionImpact(["scripts/maintenance/smoke-ui.mjs"])).toBe(false);
    expect(hasWorkerPromotionImpact(["worker/migrations/MANIFEST.md"])).toBe(false);
    expect(hasWorkerPromotionImpact(["worker/src/api/__tests__/health.test.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/lib/public-docs.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/lib/__tests__/public-docs.test.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/lib/pharosville-api-contract.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/types/pharosville.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/lib/selector/engine.ts"])).toBe(false);
    expect(hasWorkerPromotionImpact(["shared/data/funding/donations.json"])).toBe(false);
  });
});

describe("hasWorkerPackagePromotionImpact", () => {
  it("returns false for frontend-only root package changes", () => {
    expect(
      hasWorkerPackagePromotionImpact(`
diff --git a/package.json b/package.json
-    "gsap": "3.15.0",
diff --git a/package-lock.json b/package-lock.json
-    "node_modules/gsap": {
`),
    ).toBe(false);
  });

  it("returns true for root package changes that can affect the Worker bundle", () => {
    expect(
      hasWorkerPackagePromotionImpact(`
diff --git a/package.json b/package.json
-    "zod": "^4.3.5",
+    "zod": "^4.3.6",
`),
    ).toBe(true);
    expect(
      hasWorkerPackagePromotionImpact(`
diff --git a/package-lock.json b/package-lock.json
-    "node_modules/@noble/hashes": {
+    "node_modules/@noble/hashes": {
`),
    ).toBe(true);
  });

  it("falls back to Worker promotion for package-lock metadata hunks without enclosing package context", () => {
    expect(
      hasWorkerPackagePromotionImpact(`
diff --git a/package-lock.json b/package-lock.json
@@ -1123 +1123 @@
-      "version": "4.3.6",
+      "version": "4.3.7",
@@ -1124 +1124 @@
-      "resolved": "https://registry.npmjs.org/zod/-/zod-4.3.6.tgz",
+      "resolved": "https://registry.npmjs.org/zod/-/zod-4.3.7.tgz",
@@ -1125 +1125 @@
-      "integrity": "sha512-old",
+      "integrity": "sha512-new",
`),
    ).toBe(true);
  });
});

describe("hasDeployImpact", () => {
  it("returns false when the diff does not touch deploy surfaces", () => {
    expect(hasDeployImpact(["docs/testing.md", "docs/process/example.md"])).toBe(false);
  });

  it("returns true when either Pages or worker deploy surfaces changed", () => {
    expect(hasDeployImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasDeployImpact(["worker/src/api/health.ts"])).toBe(true);
  });

  it("treats deploy support infrastructure as deploy-impacting", () => {
    const deploySupportFiles = [
      "scripts/lib/deploy-impact.mjs",
      "scripts/lib/validation-lanes.mjs",
      ".github/scripts/wait-for-workflow-job.mjs",
      ".github/actions/setup-workspace/action.yml",
      "scripts/ci/check-cron-abort-contract.mjs",
      "scripts/ci/check-cron-connection-budget.ts",
      "scripts/ci/check-doc-source-paths.mjs",
      "scripts/ci/check-env-contract.mjs",
      "scripts/ci/check-sql-interpolation-safety.mjs",
      "scripts/maintenance/generate-cemetery-dataset.ts",
      "scripts/maintenance/run-critical-coverage.mjs",
      "scripts/maintenance/run-generated-artifacts.mjs",
      "scripts/maintenance/run-noncritical-tests.mjs",
      "scripts/maintenance/run-validate-prebuild.mjs",
      "scripts/maintenance/run-validation-phase.mjs",
      "scripts/maintenance/test-merge-gate.mjs",
    ];

    for (const file of deploySupportFiles) {
      expect(hasDeployImpact([file]), file).toBe(true);
      expect(hasWorkerDeployImpact([file]), file).toBe(true);
      expect(hasWorkerPromotionImpact([file]), file).toBe(false);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
    }
  });

  it("treats static export build guardrails as Pages-only deploy infrastructure", () => {
    const files = [
      "scripts/ci/check-build-attribution.mjs",
      "scripts/maintenance/build-world-map-svg.ts",
      "scripts/maintenance/explain-build-chunks.mjs",
      "scripts/maintenance/report-build-size.mjs",
      "scripts/maintenance/update-build-attribution-baseline.mjs",
    ];

    for (const file of files) {
      expect(hasDeployImpact([file]), file).toBe(true);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
      expect(hasWorkerDeployImpact([file]), file).toBe(false);
      expect(hasWorkerPromotionImpact([file]), file).toBe(false);
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
  it("runs the full worker deploy path for non-push events", () => {
    const result = classifyDeployChanges({ eventName: "workflow_dispatch" });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerPromotionRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
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
    expect(result.workerPromotionRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
  });

  it("runs only the Pages path for frontend-only push diffs", () => {
    const execFile = () => "src/app/page.tsx\ndocs/testing.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerPromotionRequired).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "docs/testing.md"]);
  });

  it("runs only the worker path for worker-only push diffs", () => {
    const execFile = () => "worker/src/api/health.ts\ndocs/testing.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerPromotionRequired).toBe(true);
    expect(result.pagesChanged).toBe(false);
    expect(result.pagesUiChanged).toBe(false);
    expect(result.changedFiles).toEqual(["worker/src/api/health.ts", "docs/testing.md"]);
  });

  it("keeps both deploy paths enabled for shared or deploy-infra changes", () => {
    const execFile = () => "src/app/page.tsx\nshared/lib/classification.ts\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerPromotionRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "shared/lib/classification.ts"]);
  });

  it("keeps broad validation enabled while skipping Worker promotion for Pages and tooling cleanup diffs", () => {
    const execFile = (_cmd: string, args: readonly string[]) => {
      if (args.includes("--unified=0")) {
        return `
diff --git a/package.json b/package.json
-    "gsap": "3.15.0",
diff --git a/package-lock.json b/package-lock.json
-    "node_modules/gsap": {
`;
      }
      return [
        "package.json",
        "package-lock.json",
        "public/_redirects",
        "scripts/lib/validation-lanes.mjs",
        "scripts/maintenance/smoke-ui.mjs",
        "shared/lib/public-docs.ts",
        "src/app/pharosville/page.tsx",
      ].join("\n");
    };

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerPromotionRequired).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
  });

  it("promotes the Worker for root package changes that can affect its bundle", () => {
    const execFile = (_cmd: string, args: readonly string[]) => {
      if (args.includes("--unified=0")) {
        return `
diff --git a/package.json b/package.json
-    "zod": "^4.3.5",
+    "zod": "^4.3.6",
`;
      }
      return "package.json\npackage-lock.json\n";
    };

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerPromotionRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
  });

  it("treats pages workflow-only changes as Pages-impacting", () => {
    const execFile = () => ".github/workflows/pages-release.yml\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerPromotionRequired).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesUiChanged).toBe(false);
    expect(result.changedFiles).toEqual([".github/workflows/pages-release.yml"]);
  });

  it("skips the deploy path for docs-only push diffs", () => {
    const execFile = () => "docs/testing.md\ndocs/process/notes.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(false);
    expect(result.docsOnly).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerPromotionRequired).toBe(false);
    expect(result.pagesChanged).toBe(false);
    expect(result.pagesDeployRequired).toBe(false);
    expect(result.pagesUiChanged).toBe(false);
    expect(result.changedFiles).toEqual(["docs/testing.md", "docs/process/notes.md"]);
  });

  it("validates test-only Pages changes without publishing them", () => {
    const execFile = () => "src/components/__tests__/header.test.tsx\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.docsOnly).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(false);
    expect(result.pagesUiChanged).toBe(false);
    expect(result.workerChanged).toBe(false);
  });

  it("publishes when production source is renamed into a test path", () => {
    const execFile = () => "src/components/header.tsx\nsrc/components/__tests__/header.test.tsx\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
    expect(result.pagesUiChanged).toBe(true);
  });

  it("passes push refs to git diff as arguments", () => {
    const received: unknown[] = [];
    const execFile = (cmd: string, args: readonly string[]) => {
      received.push([cmd, args]);
      return "src/app/page.tsx\n";
    };

    classifyDeployChanges({
      baseSha: "aaa; touch /tmp/should-not-run",
      eventName: "push",
      execFile,
      headSha: "bbb && echo injected",
    });

    expect(received).toEqual([
      ["git", ["diff", "--name-only", "--no-renames", "aaa; touch /tmp/should-not-run...bbb && echo injected"]],
    ]);
  });
});
