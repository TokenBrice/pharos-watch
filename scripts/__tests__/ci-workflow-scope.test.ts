import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("CI workflow scope", () => {
  it("keeps PR validation adaptive and leaves the Pages build to release", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");

    expect(workflow).toContain("npm run check:pr:static");
    expect(workflow).toContain("npm run test:pr -- --shard=");
    expect(workflow).toContain("npm run check:verified-doc-links");
    expect(workflow).not.toContain("npm run build");
    expect(workflow).not.toContain("node-version: \"26\"");
  });

  it("retains the full suite and compatibility proof as scheduled/manual coverage", () => {
    const nightly = readRepoFile(".github/workflows/nightly-validation.yml");

    expect(nightly).toContain("npm run lint:typed");
    expect(nightly).toContain("npm run typecheck:tests");
    expect(nightly).toContain("npm run test:all -- --shard=");
    expect(nightly).toContain("node-version: \"26\"");
  });

  it("runs the critical ratchet only for PRs that touch enrolled critical source", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");

    expect(workflow).toContain("critical_coverage_changed: ${{ steps.classify.outputs.critical_coverage_changed }}");
    expect(workflow).toContain("name: Touched critical coverage");
    expect(workflow).toContain("needs.detect-changes.outputs.critical_coverage_changed == 'true'");
    expect(workflow).toContain("CRITICAL_COVERAGE_COMPARE_REF: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("Touched critical coverage failed: ${CRITICAL_COVERAGE_RESULT}.");
  });

  it("makes the weekly all-critical coverage ratchet blocking", () => {
    const workflow = readRepoFile(".github/workflows/critical-coverage-ratchet.yml");

    expect(workflow).toContain("CRITICAL_COVERAGE_RATCHET_ALL: \"1\"");
    expect(workflow).toContain("npm run coverage:critical");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("packages the Worker before production D1 mutation", () => {
    const workflow = readRepoFile(".github/workflows/deploy-cloudflare.yml");
    const packageStep = workflow.indexOf("npm run check:worker-package");
    const migrationStep = workflow.indexOf("wrangler d1 migrations apply stablecoin-db --remote");

    expect(packageStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(packageStep);
  });

  it("records read-only post-deploy acceptance for successfully deployed surfaces", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml")) as {
      jobs: Record<string, {
        environment?: unknown;
        needs?: string[];
        outputs?: Record<string, string>;
        permissions?: Record<string, string>;
        steps?: Array<{ id?: string; name?: string; run?: string }>;
      }>;
    };
    const job = workflow.jobs["post-deploy-acceptance"];
    const acceptanceStep = job.steps?.find((step) => step.id === "acceptance");

    expect(job.needs).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs).toEqual({ outcome: "${{ steps.acceptance.outputs.outcome }}" });
    expect(acceptanceStep?.name).toContain("read-only");
    expect(acceptanceStep?.run).toContain("selectPostDeployProbes");
    expect(acceptanceStep?.run).toContain("collectWorkerHttpProbes");
    expect(acceptanceStep?.run).toContain("Outcome:");
    expect(acceptanceStep?.run).toContain("automatic rollback");
    expect(acceptanceStep?.run).not.toContain("wrangler");
    expect(acceptanceStep?.run).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("verifies package signatures even when the full-lockfile audit fails", () => {
    const workflow = readRepoFile(".github/workflows/dependency-audit.yml");
    const auditStep = workflow.indexOf("node scripts/ci/verify-dependency-audit.mjs");
    const signatureStep = workflow.indexOf("npm audit signatures");

    expect(auditStep).toBeGreaterThan(-1);
    expect(signatureStep).toBeGreaterThan(auditStep);
    expect(workflow.slice(auditStep, signatureStep)).toMatch(/if:\s*always\(\)/);
  });

  it("runs CodeQL after merge and weekly, not per PR", () => {
    const workflow = readRepoFile(".github/workflows/codeql.yml");

    expect(workflow).toContain("push:");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toContain("pull_request:");
  });

  it("analyzes workflow and action changes with Zizmor before merge", () => {
    const workflow = readRepoFile(".github/workflows/zizmor.yml");

    expect(workflow).toContain("push:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("schedule:");
    expect(workflow.match(/- "\.github\/actions\/\*\*"/g)).toHaveLength(2);
    expect(workflow.match(/- "\.github\/workflows\/\*\*"/g)).toHaveLength(2);
  });

  it("keeps Telegram load on the adaptive PR gate plus a weekly backstop", () => {
    const telegram = readRepoFile(".github/workflows/telegram-load.yml");
    const pr = readRepoFile(".github/workflows/pull-request-checks.yml");

    expect(telegram).toContain('- cron: "45 6 * * 1"');
    expect(telegram).not.toContain("pull_request:");
    expect(pr).toContain("npm run check:pr:static");
  });

  it("runs the Cloudflare account-state check weekly with its dedicated read-only secret", () => {
    const workflowSource = readRepoFile(".github/workflows/cloudflare-account-state-drift.yml");
    const workflow = parseYaml(workflowSource) as {
      on: { schedule: Array<{ cron: string }> };
      jobs: { "compare-account-state": { steps: Array<{ run?: string; env?: Record<string, string> }> } };
    };
    const checkStep = workflow.jobs["compare-account-state"].steps.find((step) => step.run);

    expect(workflow.on.schedule).toEqual([{ cron: "35 5 * * 1" }]);
    expect(checkStep?.run).toBe("npm run check:cloudflare-account-state");
    expect(checkStep?.env?.CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN).toBe(
      "${{ secrets.CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN }}",
    );
  });
});
