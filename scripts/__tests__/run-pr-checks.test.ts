import { describe, expect, it } from "vitest";

import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import {
  buildPrCheckPlan,
  createLaneCommand,
} from "../maintenance/run-pr-checks.ts";

const localDefault = { withPages: false };
const optedIn = { withPages: true };

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

  it("defers the classifier-selected Pages lane to CI unless opted in", () => {
    const changedFiles = ["src/app/page.tsx"];
    const classification = classifyChangedFiles(changedFiles);
    expect(classification).toMatchObject({ pagesArtifactRequired: true });

    const plan = buildPrCheckPlan(changedFiles, classification, localDefault);
    expect(plan).not.toContain("pages-artifact");
    expect(buildPrCheckPlan(changedFiles, classification, optedIn).at(-1)).toBe("pages-artifact");
  });

  it("selects resource probes only for V9 impact and fails closed when classification is unavailable", () => {
    const changedFiles = ["worker/src/lib/safety-score-v9/resource-budget.ts"];
    const classification = classifyChangedFiles(changedFiles);
    expect(buildPrCheckPlan(changedFiles, classification, localDefault)).toContain("v9-resource");
    const { v9ResourceRequired: _required, ...unclassified } = classification;
    expect(buildPrCheckPlan(changedFiles, unclassified, localDefault)).toContain("v9-resource");
    expect(buildPrCheckPlan(changedFiles, { ...classification, v9ResourceRequired: false }, localDefault))
      .not.toContain("v9-resource");
  });

  it("scopes the gitleaks and classifier smokes to the requested base..head range", () => {
    const context = {
      base: "origin/main",
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
