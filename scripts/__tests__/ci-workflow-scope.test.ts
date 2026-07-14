import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function extractJob(workflow: string, jobName: string, nextJobName?: string): string {
  const start = workflow.indexOf(`  ${jobName}:`);
  if (start === -1) throw new Error(`Missing workflow job: ${jobName}`);
  if (!nextJobName) return workflow.slice(start);

  const end = workflow.indexOf(`  ${nextJobName}:`, start);
  return end === -1 ? workflow.slice(start) : workflow.slice(start, end);
}

describe("CI workflow scope", () => {
  it("keeps browser and mixed tooling setup on jobs that consume it", () => {
    const validate = readRepoFile(".github/workflows/validate-ci.yml");
    const prebuild = extractJob(validate, "validate-prebuild", "pages-build");
    const pages = extractJob(validate, "pages-build", "test-noncritical");
    const noncritical = extractJob(validate, "test-noncritical", "typecheck-worker");
    const typecheckWorker = extractJob(validate, "typecheck-worker", "validate");

    expect(prebuild).toContain('install-playwright-firefox: "true"');
    expect(pages).toContain("GENERATED_ARTIFACTS_SKIP: og-editorial");
    expect(pages).toContain('install-playwright-chromium: "true"');
    expect(pages).not.toContain("install-playwright-firefox");
    expect(noncritical).toContain("fetch-depth: 1");
    expect(noncritical).not.toContain("tooling-cache:");
    expect(typecheckWorker).toContain("tooling-cache:");
    expect(validate).not.toContain("coverage-critical:");

    expect(readRepoFile(".github/workflows/telegram-load.yml")).not.toContain("tooling-cache:");
    expect(readRepoFile(".github/workflows/safe-browsing-monitor.yml")).not.toContain("tooling-cache:");
  });

  it("routes internal-docs PRs through the focused documentation checks", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");
    const validate = extractJob(workflow, "validate", "validate-docs");
    const validateDocs = extractJob(workflow, "validate-docs", "node26-proof");
    const nodeProof = extractJob(workflow, "node26-proof", "gitleaks");

    expect(workflow).toContain("docs_only: ${{ steps.classify.outputs.docs_only }}");
    expect(workflow).toContain("pages_deploy_required: ${{ steps.classify.outputs.pages_deploy_required }}");
    expect(validate).toContain("if: ${{ needs.detect-changes.outputs.docs_only != 'true' }}");
    expect(validate).toContain(
      "run_pages_build_and_seo: ${{ needs.detect-changes.outputs.pages_deploy_required == 'true' }}",
    );
    expect(validateDocs).toContain("if: ${{ needs.detect-changes.outputs.docs_only == 'true' }}");
    expect(validateDocs).not.toContain("tooling-cache:");
    expect(validateDocs).toContain("npm run check:verified-doc-links");
    expect(validateDocs).toContain("npm run check:doc-source-paths");
    expect(validateDocs).toContain("npm run check:doc-sync");
    expect(validateDocs).toContain("npm run check:agent-doc-sync");
    expect(nodeProof).toContain("if: ${{ needs.detect-changes.outputs.node_compat_changed == 'true' }}");
  });

  it("keeps path-scoped advisory scans backed by full scheduled scans", () => {
    const codeql = readRepoFile(".github/workflows/codeql.yml");
    const zizmor = readRepoFile(".github/workflows/zizmor.yml");

    expect(codeql.match(/- "\*\*\/\*\.tsx"/g)).toHaveLength(2);
    expect(codeql).toContain('- ".github/codeql/**"');
    expect(codeql).toContain('- cron: "0 6 * * 1"');
    expect(zizmor.match(/- "\.github\/workflows\/\*\*"/g)).toHaveLength(2);
    expect(zizmor).toContain('- cron: "15 6 * * 1"');
  });

  it("cancels stale Telegram PR work and bounds the Safe Browsing monitor", () => {
    const telegram = readRepoFile(".github/workflows/telegram-load.yml");
    const safeBrowsing = readRepoFile(".github/workflows/safe-browsing-monitor.yml");

    expect(telegram).toContain("group: telegram-load-${{ github.event.pull_request.number || github.ref }}");
    expect(telegram).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(safeBrowsing).toContain("timeout-minutes: 10");
  });
});
