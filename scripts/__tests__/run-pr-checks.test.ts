import { describe, expect, it } from "vitest";

import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import {
  buildPrCheckPlan,
  createLaneCommand,
  extractPrCheckFlags,
} from "../maintenance/run-pr-checks.ts";

const localDefault = { withCoverage: false, withPages: false };
const optedIn = { withCoverage: true, withPages: true };

describe("local PR check orchestration", () => {
  it("selects only the preflight and docs lanes for docs-only changes", () => {
    const changedFiles = ["docs/testing.md"];

    expect(buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), localDefault)).toEqual([
      "classifier-smoke",
      "gitleaks",
      "verified-doc-links",
      "doc-source-paths",
      "doc-sync",
      "doc-ownership-invariants",
      "agents-doc-artifact",
    ]);
  });

  it("adds docs checks to the normal lanes for mixed docs changes", () => {
    const changedFiles = ["README.md", "src/app/page.tsx"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), optedIn);

    expect(plan).toEqual([
      "classifier-smoke",
      "gitleaks",
      "verified-doc-links",
      "doc-source-paths",
      "doc-sync",
      "doc-ownership-invariants",
      "agents-doc-artifact",
      "pr-static",
      "pr-tests",
      "pages-artifact",
    ]);
  });

  it("uses the classifier docs predicate for mixed root Markdown and source", () => {
    const changedFiles = ["AGENTS.md", "src/app/page.tsx"];
    const classification = classifyChangedFiles(changedFiles);
    expect(classification.docsChanged).toBe(true);
    expect(buildPrCheckPlan(changedFiles, classification, localDefault)).toContain("doc-sync");
  });

  it("hands doc-sync ownership to the docs lane for mixed plans", () => {
    const changedFiles = ["docs/testing.md", "shared/lib/classification.ts"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), localDefault);

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
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), localDefault);

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

  it("defers classifier-selected coverage and Pages lanes to CI unless opted in", () => {
    const changedFiles = ["scripts/lib/critical-coverage.mjs", "src/app/page.tsx"];
    const classification = classifyChangedFiles(changedFiles);
    expect(classification).toMatchObject({ criticalCoverageChanged: true, pagesArtifactRequired: true });

    const plan = buildPrCheckPlan(changedFiles, classification, localDefault);
    expect(plan).not.toContain("pages-artifact");
    expect(plan).not.toContain("critical-coverage");
    expect(buildPrCheckPlan(changedFiles, classification, { withCoverage: true, withPages: false })).not.toContain("pages-artifact");
    expect(buildPrCheckPlan(changedFiles, classification, optedIn).slice(-2)).toEqual(["pages-artifact", "critical-coverage"]);
  });

  it("consumes local-only flags without leaking them into test:pr arguments", () => {
    expect(extractPrCheckFlags(["--shard=1/2", "--with-coverage", "--with-pages", "--no-fetch", "--runInBand"])).toEqual({
      forwardedTestArgs: ["--shard=1/2", "--runInBand"],
      noFetch: true,
      withCoverage: true,
      withPages: true,
      plan: false,
    });
  });

  it("always starts with the classifier smoke and gitleaks lanes", () => {
    const changedFiles = ["src/app/page.tsx"];
    const plan = buildPrCheckPlan(changedFiles, classifyChangedFiles(changedFiles), localDefault);

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
    expect(gitleaks.cmd).toContain("--local-trusted");
    expect(gitleaks.cmd).toContain(`--base=${context.resolvedBaseSha}`);
    expect(gitleaks.cmd).toContain("--head=HEAD");

    const classifier = createLaneCommand("classifier-smoke", context);
    expect(classifier.extraEnv).toMatchObject({
      DEPLOY_BASE_SHA: "origin/main",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_HEAD_SHA: "HEAD",
    });
  });
});
