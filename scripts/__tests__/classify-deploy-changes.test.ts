import { describe, expect, it } from "vitest";

import {
  classifyChangedFiles,
  classifyDeployChanges,
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
  normalizeChangedFiles,
} from "../ci/classify-deploy-changes.mjs";
import { DEPLOY_IMPACT_REGISTRY } from "../lib/automation-registry.mjs";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";

describe("normalizeChangedFiles", () => {
  it("normalizes separators and removes blank entries", () => {
    expect(normalizeChangedFiles("worker\\src\\index.ts\0\0src/app/page.tsx\0")).toEqual([
      "worker/src/index.ts",
      "src/app/page.tsx",
    ]);
  });

  it("keeps a path containing a newline intact", () => {
    expect(normalizeChangedFiles("src/app/we\nird.tsx\0src/app/page.tsx\0")).toEqual([
      "src/app/we\nird.tsx",
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
    expect(hasWorkerDeployImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
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
      expect(hasWorkerReleaseImpact([file]), file).toBe(false);
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
    expect(hasPagesDeployImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
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
        "scripts/ci/run-changed-eslint.mjs",
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

describe("hasWorkerReleaseImpact", () => {
  it("returns true for Worker runtime, config, D1 migrations, root packages, and shared runtime changes", () => {
    expect(hasWorkerReleaseImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerReleaseImpact(["worker/wrangler.toml"])).toBe(true);
    expect(hasWorkerReleaseImpact(["worker/migrations/0107_example.sql"])).toBe(true);
    expect(hasWorkerReleaseImpact(["shared/data/stablecoins/coins/usdc-circle.json"])).toBe(true);
    expect(hasWorkerReleaseImpact(["shared/lib/classification.ts"])).toBe(true);
    expect(hasWorkerReleaseImpact(["package.json", "package-lock.json"])).toBe(true);
  });

  it("returns false for validation, tests, and known Pages-only shared changes", () => {
    expect(hasWorkerReleaseImpact(["scripts/maintenance/run-pr-static-checks.mjs"])).toBe(false);
    expect(hasWorkerReleaseImpact(["scripts/maintenance/smoke-ui.mjs"])).toBe(false);
    expect(hasWorkerReleaseImpact(["worker/migrations/MANIFEST.md"])).toBe(false);
    expect(hasWorkerReleaseImpact(["worker/src/api/__tests__/health.test.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/lib/public-docs.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/lib/__tests__/public-docs.test.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/lib/pharosville-api-contract.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/types/pharosville.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/lib/selector/engine.ts"])).toBe(false);
    expect(hasWorkerReleaseImpact(["shared/data/funding/donations.json"])).toBe(false);
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

  it("deploys for deploy-classifier infrastructure but not validation-only tooling", () => {
    const deploySupportFiles = [
      "scripts/lib/deploy-impact.mjs",
      "scripts/lib/automation-registry.mjs",
      "scripts/ci/classify-deploy-changes.mjs",
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
      "scripts/ci/check-env-contract.mjs",
      "scripts/maintenance/run-all-tests.mjs",
      "scripts/maintenance/run-pr-static-checks.mjs",
    ]) {
      expect(hasDeployImpact([file]), file).toBe(false);
    }
  });

  it("keeps scheduled coverage ratchet infrastructure out of deploy impact", () => {
    const files = ["scripts/maintenance/run-critical-coverage.mjs"];

    expect(hasDeployImpact(files)).toBe(false);
    expect(hasWorkerDeployImpact(files)).toBe(false);
    expect(hasWorkerReleaseImpact(files)).toBe(false);
    expect(hasPagesDeployImpact(files)).toBe(false);
  });

  it("deploys for static export inputs but not validation-only build reports", () => {
    expect(hasPagesDeployImpact(["scripts/maintenance/build-world-map-svg.ts"])).toBe(true);
    expect(hasWorkerDeployImpact(["scripts/maintenance/build-world-map-svg.ts"])).toBe(false);

    for (const file of ["scripts/maintenance/report-build-size.mjs", "scripts/ci/check-phishing-signatures.mjs"]) {
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
  it("marks enrolled critical source changes for the targeted coverage ratchet", () => {
    expect(classifyChangedFiles(["worker/src/lib/auth.ts"]).criticalCoverageChanged).toBe(true);
    expect(classifyChangedFiles(["worker/src/lib/auth.test.ts"]).criticalCoverageChanged).toBe(false);
  });

  it("runs the full worker deploy path for non-push events", () => {
    const result = classifyDeployChanges({ eventName: "workflow_dispatch" });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
    expect(result.docsOnly).toBe(false);
    expect(result.criticalCoverageChanged).toBe(true);
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
    expect(result.pagesDeployRequired).toBe(true);
  });

  it("runs only the Pages path for frontend-only push diffs", () => {
    const execFile = () => "src/app/page.tsx\0docs/testing.md\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerDeployRequired).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual(["docs/testing.md", "src/app/page.tsx"]);
  });

  it("runs only the worker path for worker-only push diffs", () => {
    const execFile = () => "worker/src/api/health.ts\0docs/testing.md\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(false);
    expect(result.changedFiles).toEqual(["docs/testing.md", "worker/src/api/health.ts"]);
  });

  it("keeps both deploy paths enabled for shared or deploy-infra changes", () => {
    const execFile = () => "src/app/page.tsx\0shared/lib/classification.ts\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual(["shared/lib/classification.ts", "src/app/page.tsx"]);
  });

  it("conservatively deploys both surfaces for root package changes", () => {
    const execFile = () => [
        "package.json",
        "package-lock.json",
        "public/_redirects",
        "scripts/maintenance/run-pr-static-checks.mjs",
        "scripts/maintenance/smoke-ui.mjs",
        "shared/lib/public-docs.ts",
        "src/app/pharosville/page.tsx",
      ].join("\0");

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.workerDeployRequired).toBe(true);
    expect(result.pagesChanged).toBe(true);
  });

  it("treats pages workflow-only changes as Pages-impacting", () => {
    const execFile = () => ".github/workflows/pages-release.yml\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerDeployRequired).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual([".github/workflows/pages-release.yml"]);
  });

  it("skips the deploy path for docs-only push diffs", () => {
    const execFile = () => "docs/testing.md\0docs/process/notes.md\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(false);
    expect(result.docsOnly).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.workerDeployRequired).toBe(false);
    expect(result.pagesChanged).toBe(false);
    expect(result.pagesDeployRequired).toBe(false);
    expect(result.changedFiles).toEqual(["docs/process/notes.md", "docs/testing.md"]);
  });

  it("validates test-only Pages changes without publishing them", () => {
    const execFile = () => "src/components/__tests__/header.test.tsx\0";

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
    expect(result.workerChanged).toBe(false);
  });

  it("publishes when production source is renamed into a test path", () => {
    const execFile = () => "src/components/header.tsx\0src/components/__tests__/header.test.tsx\0";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      execFile,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.pagesChanged).toBe(true);
    expect(result.pagesDeployRequired).toBe(true);
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
