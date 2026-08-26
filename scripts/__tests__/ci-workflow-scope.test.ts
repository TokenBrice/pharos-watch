import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("CI workflow scope", () => {
  it("refreshes independent Pages snapshots concurrently without cross-surface rollback", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pages-release.yml")) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const refreshStep = workflow.jobs["pages-release"].steps?.find(
      (step) => step.name === "Refresh API-backed release data",
    );
    const run = refreshStep?.run ?? "";

    expect(run).toBe("node --import tsx scripts/maintenance/refresh-pages-release-data.ts");
  });

  it("preserves the Next compiler cache and consolidates Pages artifact checks", () => {
    const workflow = readRepoFile(".github/workflows/pages-release.yml");

    expect(workflow).toContain('bootstrap-generated: "false"');
    expect(workflow).toContain('next-cache: "true"');
    expect(workflow).toContain('next-cache-save: "true"');
    expect(workflow).toContain('PHAROS_RELEASE_PR_TYPECHECKED: "1"');
    expect(workflow).toContain("npm run check:pages-release");
    const compileInputAt = workflow.indexOf("npm run prebuild -- --build-lifecycle=compile-input");
    const refreshAt = workflow.indexOf("refresh-pages-release-data.ts");
    const postRefreshAt = workflow.indexOf("npm run prebuild -- --build-lifecycle=post-refresh");
    expect(compileInputAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(compileInputAt);
    expect(postRefreshAt).toBeGreaterThan(refreshAt);
    expect(workflow).not.toContain("rm -rf .next");
  });

  it("uses a dependency-free PR preflight and merges both critical coverage shards", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");
    const parsed = parseYaml(workflow) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }>;
    };
    const preflight = parsed.jobs.preflight.steps ?? [];
    const staticSteps = parsed.jobs.static.steps ?? [];
    const coverageShardSteps = parsed.jobs["critical-coverage-shards"].steps ?? [];

    expect(preflight.some((step) => step.run?.includes("classify-deploy-changes.ts"))).toBe(true);
    expect(preflight.some((step) => step.run?.includes("run-gitleaks.ts --range"))).toBe(true);
    expect(preflight.some((step) => step.uses === "./.github/actions/setup-workspace")).toBe(false);
    expect(
      staticSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"],
    ).toBe(0);
    expect(
      staticSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.filter,
    ).toBe("blob:none");
    expect(preflight.some((step) => step.run?.includes("git merge-base"))).toBe(true);
    expect(workflow).toContain("fetch-depth: 50");
    expect(workflow).toContain("git fetch --no-tags --unshallow origin");
    expect(workflow).toContain("matrix:\n        shard: [1, 2, 3, 4]");
    expect(workflow).toContain("npm run test:pr -- --shard=${{ matrix.shard }}/4");
    expect(workflow).toContain("npm run coverage:critical:shard -- --shard=${{ matrix.shard }}/4");
    expect(workflow).toContain("merge-multiple: true");
    expect(workflow).toContain("include-hidden-files: true");
    expect(
      coverageShardSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"],
    ).toBe(0);
    expect(
      coverageShardSteps.find((step) => step.uses === "./.github/actions/setup-workspace")?.with?.[
        "bootstrap-history"
      ],
    ).toBe("true");
    expect(workflow).toContain("npm run coverage:critical:merge");
    expect(workflow).toContain("install-playwright-firefox: ${{ needs.preflight.outputs.playwright_firefox_required }}");
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
    expect(acceptanceStep?.run).toContain('from "./scripts/lib/worker-http-probes.mts"');
    expect(acceptanceStep?.run).toContain('from "./scripts/lib/post-deploy-acceptance.mts"');
    expect(acceptanceStep?.run).toContain("Outcome:");
    expect(acceptanceStep?.run).toContain("automatic rollback");
    expect(acceptanceStep?.run).not.toContain("wrangler");
    expect(acceptanceStep?.run).not.toContain("CLOUDFLARE_API_TOKEN");
  });
});
