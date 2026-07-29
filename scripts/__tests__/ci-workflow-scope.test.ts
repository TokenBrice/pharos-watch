import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("packages the Worker before production D1 mutation", () => {
    const workflow = readRepoFile(".github/workflows/deploy-cloudflare.yml");
    const packageStep = workflow.indexOf("npm run check:worker-package");
    const migrationStep = workflow.indexOf("wrangler d1 migrations apply stablecoin-db --remote");

    expect(packageStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(packageStep);
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
});
