import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("CI workflow scope", () => {
  it("builds Pages without the Next compiler cache and consolidates artifact checks", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pages-release.yml"));
    const steps = workflow.jobs["pages-release"].steps as Array<{
      uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>;
    }>;
    const setup = steps.find((step) => step.uses === "./.github/actions/setup-workspace");
    expect(setup?.with?.["bootstrap-generated"]).toBe("false");
    expect(setup?.with?.["next-cache"]).toBeUndefined();
    expect(setup?.with?.["next-cache-save"]).toBeUndefined();
    expect(steps.some((step) => step.uses?.startsWith("actions/cache"))).toBe(false);
    const compile = steps.findIndex((step) => step.run === "npm run prebuild -- --build-lifecycle=compile-input");
    const refresh = steps.findIndex((step) => step.run === "node --import tsx scripts/maintenance/refresh-pages-release-data.ts");
    const build = steps.findIndex((step) => step.run?.split("\n").includes("npm run prebuild -- --build-lifecycle=post-refresh"));
    const check = steps.findIndex((step) => step.run === "npm run check:pages-release");
    expect(compile).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(compile);
    expect(build).toBeGreaterThan(refresh);
    expect(check).toBeGreaterThan(build);
    expect(steps[build].env?.PHAROS_RELEASE_PR_TYPECHECKED).toBe("1");
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
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml"));
    const steps = workflow.jobs["deploy-worker"].steps as Array<{ run?: string }>;
    const packageStep = steps.findIndex((step) => step.run === "npm run check:worker-package");
    const migrationStep = steps.findIndex((step) =>
      step.run === "cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote");
    expect(packageStep).toBeGreaterThanOrEqual(0);
    expect(migrationStep).toBeGreaterThan(packageStep);
  });

  it("passes the verified Worker activation output to the marker step", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml")) as {
      jobs: Record<string, {
        steps?: Array<{ id?: string; name?: string; env?: Record<string, string>; run?: string }>;
      }>;
    };
    const steps = workflow.jobs["deploy-worker"].steps ?? [];
    const verify = steps.find((step) => step.id === "verify-worker-deployment");
    const marker = steps.find((step) => step.name === "Record Worker activation marker");

    // The activation second is selected by the tested entrypoint, not inline YAML.
    expect(verify?.run).toContain("scripts/ci/verify-worker-deployment.ts");
    expect(marker?.env?.WORKER_ACTIVATED_AT).toBe(
      "${{ steps.verify-worker-deployment.outputs.worker_activation_at }}",
    );
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
    const acceptance = job.steps?.find((step) => step.id === "acceptance");

    expect(job.needs).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs).toEqual({ outcome: "${{ steps.acceptance.outputs.outcome }}" });
    expect(acceptance?.run).toContain("scripts/ci/run-post-deploy-acceptance.ts");
  });

  it("fans the nightly Node 24 validation out from one prepared workspace artifact", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml")) as {
      jobs: Record<string, {
        needs?: string | string[];
        steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const prepareSetup = workflow.jobs.prepare.steps?.find(
      (step) => step.uses === "./.github/actions/setup-workspace");
    expect(prepareSetup?.with?.["workspace-artifact"]).toBe("publish");
    expect(prepareSetup?.with?.["bootstrap-history"]).toBe("true");
    for (const job of ["full-static", "full-tests"]) {
      const setup = workflow.jobs[job].steps?.find(
        (step) => step.uses === "./.github/actions/setup-workspace");
      expect(workflow.jobs[job].needs).toContain("prepare");
      expect(setup?.with?.["workspace-artifact"]).toBe("restore");
      expect(setup?.with?.["install-deps"]).toBe("false");
    }
    // The artifact carries Node 24 state; the Node 26 probe installs independently.
    const node26Setup = workflow.jobs["node26-proof"].steps?.find(
      (step) => step.uses === "./.github/actions/setup-workspace");
    expect(node26Setup?.with?.["node-version"]).toBe("26");
    expect(node26Setup?.with?.["workspace-artifact"]).toBeUndefined();
    expect(node26Setup?.with?.["install-deps"]).toBeUndefined();
  });

  it("runs the weekly gitleaks scan without npm installation", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/weekly-validation.yml")) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; run?: string; with?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs.gitleaks.steps ?? [];
    expect(steps.some((step) => step.uses === "./.github/actions/setup-workspace")).toBe(false);
    // Type stripping for the dependency-free runner needs the pinned Node 24.
    expect(steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with).toMatchObject({
      "node-version": "24.16.0",
    });
    const scan = steps.find((step) => step.run?.includes("run-gitleaks.ts"));
    expect(scan?.run).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ci/run-gitleaks.ts --range");
  });
});
