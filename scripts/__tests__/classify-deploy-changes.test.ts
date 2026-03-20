import { describe, expect, it } from "vitest";

import {
  classifyDeployChanges,
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
    expect(hasWorkerDeployImpact(["shared/lib/stablecoins.ts"])).toBe(true);
    expect(hasWorkerDeployImpact([".github/workflows/deploy-cloudflare.yml"])).toBe(true);
  });
});

describe("classifyDeployChanges", () => {
  it("runs the full worker deploy path for non-push events", () => {
    expect(classifyDeployChanges({ eventName: "workflow_dispatch" }).workerChanged).toBe(true);
  });

  it("falls back to full worker deploy when the push base sha is unavailable", () => {
    expect(classifyDeployChanges({
      baseSha: "0000000000000000000000000000000000000000",
      eventName: "push",
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    }).workerChanged).toBe(true);
  });

  it("skips worker deploy work for push diffs without worker-impacting files", () => {
    const exec = () => "src/app/page.tsx\ndocs/testing.md\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.workerChanged).toBe(false);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "docs/testing.md"]);
  });

  it("keeps worker deploy work enabled for push diffs that touch shared or worker code", () => {
    const exec = () => "src/app/page.tsx\nshared/lib/classification.ts\n";

    const result = classifyDeployChanges({
      baseSha: "70ed0512d6a23dccc2e5a4e65ff3ab3f4c0e45e2",
      eventName: "push",
      exec,
      headSha: "25197af364c3c9ada9f9f394e4d65f62e6554f6e",
    });

    expect(result.workerChanged).toBe(true);
    expect(result.changedFiles).toEqual(["src/app/page.tsx", "shared/lib/classification.ts"]);
  });
});
