import { describe, expect, it } from "vitest";

import {
  classifyDeployChanges,
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeChangedFiles,
} from "../classify-deploy-changes.mjs";

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
    expect(hasWorkerDeployImpact([
      "src/app/page.tsx",
      "src/components/header.tsx",
      "docs/testing.md",
    ])).toBe(false);
  });

  it("returns true for worker, shared, and workflow-infra changes", () => {
    expect(hasWorkerDeployImpact(["worker/src/api/health.ts"])).toBe(true);
    expect(hasWorkerDeployImpact(["shared/data/stablecoins/usd-major.json"])).toBe(true);
    expect(hasWorkerDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
  });
});

describe("hasPagesDeployImpact", () => {
  it("returns false for worker-only changes", () => {
    expect(hasPagesDeployImpact([
      "worker/src/api/health.ts",
      "worker/src/cron/sync-stablecoins.ts",
      "docs/testing.md",
    ])).toBe(false);
  });

  it("returns true for frontend, shared, and deploy-infra changes", () => {
    expect(hasPagesDeployImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasPagesDeployImpact(["src/lib/api.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["src/hooks/use-stablecoins.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["functions/api/admin/[[path]].ts"])).toBe(true);
    expect(hasPagesDeployImpact(["shared/data/stablecoins/usd-major.json"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-prepare.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-publish.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/pages-release.yml"])).toBe(true);
    expect(hasPagesDeployImpact([".github/workflows/rebuild-pages.yml"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/generate-llms-txt.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/generate-docs-metadata.ts"])).toBe(true);
    expect(hasPagesDeployImpact(["scripts/generate-markdown-exports.ts"])).toBe(true);
  });
});

describe("hasDeployImpact", () => {
  it("returns false when the diff does not touch deploy surfaces", () => {
    expect(hasDeployImpact(["docs/testing.md", "agents/plans/example.md"])).toBe(false);
  });

  it("returns true when either Pages or worker deploy surfaces changed", () => {
    expect(hasDeployImpact(["src/app/page.tsx"])).toBe(true);
    expect(hasDeployImpact(["worker/src/api/health.ts"])).toBe(true);
  });

  it("treats deploy support infrastructure as deploy-impacting", () => {
    const deploySupportFiles = [
      "scripts/lib/deploy-impact.mjs",
      "scripts/lib/validate-contract.mjs",
      ".github/actions/setup-workspace/action.yml",
      "scripts/check-cron-abort-contract.mjs",
      "scripts/check-cron-connection-budget.ts",
      "scripts/check-env-contract.mjs",
      "scripts/check-sql-interpolation-safety.mjs",
      "scripts/test-merge-gate.mjs",
    ];

    for (const file of deploySupportFiles) {
      expect(hasDeployImpact([file]), file).toBe(true);
      expect(hasWorkerDeployImpact([file]), file).toBe(true);
      expect(hasPagesDeployImpact([file]), file).toBe(true);
    }
  });
});

describe("classifyDeployChanges", () => {
  it("runs the full worker deploy path for non-push events", () => {
    const result = classifyDeployChanges({ eventName: "workflow_dispatch" });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.pagesChanged).toBe(true);
  });

  it("falls back to full worker deploy when the push base sha is unavailable", () => {
    const result = classifyDeployChanges({
      baseSha: "0000000000000000000000000000000000000000",
      eventName: "push",
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });
    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.pagesChanged).toBe(true);
  });

  it("runs only the Pages path for frontend-only push diffs", () => {
    const exec = () => "src/app/page.tsx\ndocs/testing.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "docs/testing.md"]);
  });

  it("runs only the worker path for worker-only push diffs", () => {
    const exec = () => "worker/src/api/health.ts\ndocs/testing.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.pagesChanged).toBe(false);
    expect(result.changedFiles).toEqual(["worker/src/api/health.ts", "docs/testing.md"]);
  });

  it("keeps both deploy paths enabled for shared or deploy-infra changes", () => {
    const exec = () => "src/app/page.tsx\nshared/lib/classification.ts\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(true);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "shared/lib/classification.ts"]);
  });

  it("treats pages workflow-only changes as Pages-impacting", () => {
    const exec = () => ".github/workflows/pages-prepare.yml\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(true);
    expect(result.workerChanged).toBe(false);
    expect(result.pagesChanged).toBe(true);
    expect(result.changedFiles).toEqual([".github/workflows/pages-prepare.yml"]);
  });

  it("skips the deploy path for docs-only push diffs", () => {
    const exec = () => "docs/testing.md\nagents/plans/notes.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.deployRequired).toBe(false);
    expect(result.workerChanged).toBe(false);
    expect(result.pagesChanged).toBe(false);
    expect(result.changedFiles).toEqual(["docs/testing.md", "agents/plans/notes.md"]);
  });

  it("uses three-dot diff syntax so merge-base is the comparison point", () => {
    const received: string[] = [];
    const exec = (cmd: string) => {
      received.push(cmd);
      return "src/app/page.tsx\n";
    };

    classifyDeployChanges({
      baseSha: "aaa",
      eventName: "push",
      exec,
      headSha: "bbb",
    });

    expect(received).toEqual(["git diff --name-only aaa...bbb"]);
  });
});
