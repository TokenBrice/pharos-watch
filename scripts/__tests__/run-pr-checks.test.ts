import { describe, expect, it } from "vitest";

import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import {
  buildPrCheckPlan,
  createLaneCommand,
  extractPrCheckFlags,
} from "../maintenance/run-pr-checks.ts";

describe("local PR check orchestration", () => {
  it("selects only the preflight and docs lanes for docs-only changes", () => {
    const changedFiles = ["docs/testing.md"];

    expect(buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false })).toEqual([
      "classifier-smoke",
      "gitleaks",
      "verified-doc-links",
      "doc-source-paths",
      "doc-sync",
      "agents-doc-artifact",
    ]);
  });

  it("adds docs checks to the normal lanes for mixed docs changes", () => {
    const changedFiles = ["README.md", "src/app/page.tsx"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false });

    expect(plan).toEqual([
      "classifier-smoke",
      "gitleaks",
      "verified-doc-links",
      "doc-source-paths",
      "doc-sync",
      "agents-doc-artifact",
      "pr-static",
      "pr-tests",
    ]);
  });

  it("hands doc-sync ownership to the docs lane for mixed plans", () => {
    const changedFiles = ["docs/testing.md", "shared/lib/classification.ts"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false });

    expect(plan).toContain("doc-sync");
    expect(plan).toContain("pr-static");
    const context = {
      base: "origin/main",
      env: { NODE_ENV: "test" as const },
      forwardedTestArgs: [],
      head: "HEAD",
      resolvedBaseSha: "91c2702677808b4380fe5dfde1bf5c09b570d2f0",
      skipDocSync: true,
    };
    expect(createLaneCommand("pr-static", context).cmd).toContain("--skip-doc-sync");
    // The docs lane keeps its own complete command; ownership only removes the
    // static lane's duplicate execution.
    expect(createLaneCommand("doc-sync", context).cmd).not.toContain("--skip-doc-sync");
  });

  it("keeps the static lane's own doc-sync when the docs lane is not in the plan", () => {
    const changedFiles = ["shared/lib/classification.ts"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false });

    expect(plan).not.toContain("doc-sync");
    const staticCommand = createLaneCommand("pr-static", {
      base: "origin/main",
      env: { NODE_ENV: "test" as const },
      forwardedTestArgs: [],
      head: "HEAD",
      resolvedBaseSha: "91c2702677808b4380fe5dfde1bf5c09b570d2f0",
    });
    expect(staticCommand.cmd).not.toContain("--skip-doc-sync");
  });

  it("runs touched critical coverage when the classifier requests it", () => {
    const changedFiles = ["scripts/lib/critical-coverage.mjs"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false });

    expect(plan.at(-1)).toBe("critical-coverage");
  });

  it("suppresses touched critical coverage when requested", () => {
    const changedFiles = ["scripts/lib/critical-coverage.mjs"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: true });

    expect(plan).not.toContain("critical-coverage");
  });

  it("consumes local-only flags without leaking them into test:pr arguments", () => {
    expect(extractPrCheckFlags(["--shard=1/2", "--skip-coverage", "--no-fetch", "--runInBand"])).toEqual({
      forwardedTestArgs: ["--shard=1/2", "--runInBand"],
      noFetch: true,
      skipCoverage: true,
    });
  });

  it("always starts with the classifier smoke and gitleaks lanes", () => {
    const changedFiles = ["src/app/page.tsx"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), { skipCoverage: false });

    expect(plan.slice(0, 2)).toEqual(["classifier-smoke", "gitleaks"]);
  });

  it("passes the resolved base SHA to coverage as CRITICAL_COVERAGE_COMPARE_REF, mirroring the CI merge job", () => {
    const command = createLaneCommand("critical-coverage", {
      base: "origin/main",
      env: { NODE_ENV: "test", PATH: "/usr/bin" },
      forwardedTestArgs: [],
      head: "HEAD",
      resolvedBaseSha: "91c2702677808b4380fe5dfde1bf5c09b570d2f0",
    });

    expect(command.cmd).toContain("coverage:critical");
    expect(command.extraEnv?.CRITICAL_COVERAGE_COMPARE_REF).toBe("91c2702677808b4380fe5dfde1bf5c09b570d2f0");
  });

  it("scopes the gitleaks and classifier smokes to the requested base..head range", () => {
    const context = {
      base: "origin/main",
      env: { NODE_ENV: "test" as const },
      forwardedTestArgs: [],
      head: "HEAD",
      resolvedBaseSha: "91c2702677808b4380fe5dfde1bf5c09b570d2f0",
    };

    const gitleaks = createLaneCommand("gitleaks", context);
    expect(gitleaks.extraEnv).toMatchObject({ GITLEAKS_BASE_REF: "origin/main", GITLEAKS_HEAD_REF: "HEAD" });

    const classifier = createLaneCommand("classifier-smoke", context);
    expect(classifier.extraEnv).toMatchObject({
      DEPLOY_BASE_SHA: "origin/main",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_HEAD_SHA: "HEAD",
    });
  });
});
