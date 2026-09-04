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

  it("builds Pages without the Next compiler cache and consolidates artifact checks", () => {
    const workflow = readRepoFile(".github/workflows/pages-release.yml");
    const buildSizeCheck = readRepoFile("scripts/maintenance/report-build-size.mjs");

    expect(workflow).toContain('bootstrap-generated: "false"');
    expect(workflow).not.toContain("next-cache:");
    expect(workflow).not.toContain("next-cache-save:");
    expect(workflow).toContain('PHAROS_RELEASE_PR_TYPECHECKED: "1"');
    expect(workflow).toContain("npm run check:pages-release");
    expect(buildSizeCheck).toContain('path.join(nextStaticDir, "css")');
    expect(buildSizeCheck).toContain('.xl\\\\:w-\\\\[15rem\\\\]');
    const compileInputAt = workflow.indexOf("npm run prebuild -- --build-lifecycle=compile-input");
    const refreshAt = workflow.indexOf("refresh-pages-release-data.ts");
    const postRefreshAt = workflow.indexOf("npm run prebuild -- --build-lifecycle=post-refresh");
    expect(compileInputAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(compileInputAt);
    expect(postRefreshAt).toBeGreaterThan(refreshAt);
    expect(workflow).not.toContain("rm -rf .next");
  });

  it("uses a dependency-free PR preflight and merges all critical coverage shards", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");
    const parsed = parseYaml(workflow) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }>;
    };
    const preflight = parsed.jobs.preflight.steps ?? [];
    // Static, test, docs, and coverage shards are intentionally generated into one manifest-owned matrix job.
    const validationSteps = parsed.jobs.validation.steps ?? [];
    const prepareSteps = parsed.jobs.prepare.steps ?? [];

    expect(preflight.some((step) => step.run?.includes("generate-pr-workflow-matrix.ts --preflight"))).toBe(true);
    expect(preflight.some((step) => step.run?.includes("generate-pr-workflow-matrix.ts --matrix"))).toBe(true);
    expect(preflight.some((step) => step.uses === "./.github/actions/setup-workspace")).toBe(false);
    expect(
      preflight.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"],
    ).toBe(0);
    expect(
      validationSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"],
    ).toBe(0);
    expect(
      validationSteps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.filter,
    ).toBe("blob:none");
    expect(workflow).toContain("matrix: ${{ fromJSON(needs.preflight.outputs.matrix) }}");
    expect(workflow).toContain("PR_LANE_SHARD: ${{ matrix.shard }}");
    expect(workflow).toContain("matrix.lane == 'critical-coverage-shards'");
    expect(workflow).toContain("merge-multiple: true");
    expect(workflow).toContain("include-hidden-files: true");
    expect(
      prepareSteps.find((step) => step.uses === "./.github/actions/setup-workspace")?.with?.[
        "bootstrap-history"
      ],
    ).toBe("true");
    expect(workflow).toContain("PR_LANE_ID: critical-coverage");
    expect(workflow).toContain("install-playwright-firefox: ${{ matrix.lane == 'static'");
  });

  it("packages the Worker before production D1 mutation", () => {
    const workflow = readRepoFile(".github/workflows/deploy-cloudflare.yml");
    const packageStep = workflow.indexOf("npm run check:worker-package");
    const migrationStep = workflow.indexOf("wrangler d1 migrations apply stablecoin-db --remote");

    expect(packageStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(packageStep);
  });

  it("timestamps the Worker activation marker from Cloudflare deployment history", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml")) as {
      jobs: Record<string, {
        steps?: Array<{ id?: string; name?: string; env?: Record<string, string>; run?: string }>;
      }>;
    };
    const steps = workflow.jobs["deploy-worker"].steps ?? [];
    const verify = steps.find((step) => step.id === "verify-worker-deployment");
    const marker = steps.find((step) => step.name === "Record Worker activation marker");

    expect(verify?.run).toContain("wrangler deployments list --json");
    expect(verify?.run).toContain("listedDeployment.created_on");
    expect(verify?.run).toContain("worker_activation_at=${activationAtSec}");
    expect(marker?.env?.WORKER_ACTIVATED_AT).toBe(
      "${{ steps.verify-worker-deployment.outputs.worker_activation_at }}",
    );
    expect(marker?.run).toContain("cloudflare-deployment.created_on");
    expect(marker?.run).toContain("ON CONFLICT(key) DO NOTHING");
    expect(marker?.run).not.toContain("unixepoch()");
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
