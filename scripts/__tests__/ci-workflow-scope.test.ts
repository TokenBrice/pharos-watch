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
    const setup = steps.find((step) => step.uses === "$/.github/actions/setup-workspace");
    expect(setup?.with?.["bootstrap-generated"]).toBe("false");
    expect(setup?.with?.["install-deps"]).toBe("false");
    expect(setup?.with?.["cache-npm"]).toBe("false");
    expect(setup?.with?.["next-cache"]).toBeUndefined();
    expect(setup?.with?.["next-cache-save"]).toBeUndefined();
    expect(steps.some((step) => step.uses?.startsWith("actions/cache"))).toBe(false);
    const restore = steps.findIndex((step) => step.run?.includes("tar --zstd -xf"));
    const refresh = steps.findIndex((step) => step.run === "node --import tsx scripts/maintenance/refresh-pages-release-data.ts");
    const build = steps.findIndex((step) => step.run?.split("\n").includes(
      "node --import tsx scripts/maintenance/run-generated-artifacts.ts --build-lifecycle=post-refresh",
    ));
    const check = steps.findIndex((step) => step.run === "npm run check:pages-release");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(restore);
    expect(build).toBeGreaterThan(refresh);
    expect(check).toBeGreaterThan(build);
    expect(steps[build].env?.PHAROS_RELEASE_PR_TYPECHECKED).toBe("1");
  });

  it("prepares only pure/history inputs in parallel with the Worker and gates live Pages work", () => {
    const deploy = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml"));
    const rebuild = parseYaml(readRepoFile(".github/workflows/rebuild-pages.yml"));
    const prepare = parseYaml(readRepoFile(".github/workflows/pages-prepare.yml"));
    const release = parseYaml(readRepoFile(".github/workflows/pages-release.yml"));
    const artifactName = "pages-workspace-production-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}";
    const steps = prepare.jobs["pages-prepare"].steps as Array<{
      uses?: string; run?: string; with?: Record<string, unknown>;
    }>;

    expect(deploy.jobs["deploy-worker"].needs).toBe("plan");
    expect(deploy.jobs["pages-prepare"].needs).toBe("plan");
    expect(deploy.jobs["pages-prepare"].uses).toBe("$/.github/workflows/pages-prepare.yml");
    expect(deploy.jobs["pages-prepare"].if).toBe("${{ needs.plan.outputs.pages_required == 'true' }}");
    expect(deploy.jobs["pages-release"].needs).toEqual(["plan", "deploy-worker", "pages-prepare"]);
    expect(deploy.jobs["pages-release"].if).toContain("always()");
    expect(deploy.jobs["pages-release"].if).toContain("needs.plan.result == 'success'");
    expect(deploy.jobs["pages-release"].if).toContain("needs.plan.outputs.pages_required == 'true'");
    expect(deploy.jobs["pages-release"].if).toContain("needs.pages-prepare.result == 'success'");
    expect(String(deploy.jobs["pages-release"].if).replace(/\s+/g, " ")).toContain(
      "needs.plan.outputs.worker_required != 'true' || needs.deploy-worker.result == 'success'",
    );
    expect(rebuild.jobs["pages-prepare"].uses).toBe("$/.github/workflows/pages-prepare.yml");
    expect(rebuild.jobs["pages-release"].needs).toBe("pages-prepare");
    expect(rebuild.jobs["pages-release"].uses).toBe(deploy.jobs["pages-release"].uses);
    expect(rebuild.jobs["pages-release"].with.refresh_data).toBe(true);

    expect(prepare.jobs["pages-prepare"].environment).toBeUndefined();
    expect(prepare.on.workflow_call?.secrets).toBeUndefined();
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    expect(steps.some((step) => step.run ===
      "node --import tsx scripts/maintenance/run-generated-artifacts.ts --build-lifecycle=compile-input")).toBe(true);
    expect(steps.some((step) => /refresh-pages-release-data|post-refresh|next build|pages deploy/.test(step.run ?? ""))).toBe(false);
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({
      name: artifactName, "compression-level": 0, "if-no-files-found": "error",
    });
    expect(steps.find((step) => step.run?.includes("tar -I"))?.run).toContain("zstd -T0 -3");
    const download = release.jobs["pages-release"].steps.find(
      (step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toBe(artifactName);
    expect(release.jobs["pages-release"].environment.name).toBe("production");
  });

  it("prepares validation independently of secrets and merges only coverage shards", () => {
    const workflow = readRepoFile(".github/workflows/pull-request-checks.yml");
    const parsed = parseYaml(workflow);
    const jobs = parsed.jobs;
    expect(jobs.preflight).toBeUndefined();
    expect(jobs.secrets.needs).toBeUndefined();
    expect(jobs.prepare.needs).toBeUndefined();
    expect(jobs.validation.needs).toBe("prepare");
    expect(jobs["critical-coverage-shards"].needs).toBe("prepare");
    expect(jobs["critical-coverage"].needs).toEqual(["prepare", "critical-coverage-shards"]);
    expect(jobs["pr-gate"].needs).toEqual(["secrets", "prepare", "validation", "critical-coverage-shards", "critical-coverage"]);
    expect(jobs["pr-gate"].if).toBe("${{ always() }}");
    expect(jobs.validation.strategy["max-parallel"]).toBe(10);
    expect(jobs["critical-coverage-shards"].strategy["max-parallel"]).toBe(8);
    expect(jobs.validation.strategy.matrix).toBe("${{ fromJSON(needs.prepare.outputs.matrix) }}");
    expect(jobs["critical-coverage-shards"].strategy.matrix).toBe("${{ fromJSON(needs.prepare.outputs.coverage_matrix) }}");
    const prepareSteps = jobs.prepare.steps;
    const setups = prepareSteps.filter((step: { uses?: string }) => step.uses === "$/.github/actions/setup-workspace");
    expect(setups).toHaveLength(2);
    expect(setups[0].with).toMatchObject({ "bootstrap-history": "true", "workspace-artifact": "none", "install-ripgrep": "true" });
    expect(setups[1].with).toMatchObject({ "install-deps": "false", "cache-npm": "false", "workspace-artifact": "publish" });
    const docs = prepareSteps.find((step: { id?: string }) => step.id === "docs");
    expect(docs.if).toBe("${{ steps.classify.outputs.docs_only == 'true' }}");
    expect(docs.env.PR_LANE_ID).toBe("docs");
    expect(prepareSteps.indexOf(docs)).toBeLessThan(prepareSteps.indexOf(setups[1]));
    expect(prepareSteps.some((step: { run?: string }) => step.run?.includes("generate-pr-workflow-matrix.ts --classify"))).toBe(true);
    expect(prepareSteps.some((step: { run?: string }) => step.run?.includes("--plan-out=.tmp/pr-test-plan.json"))).toBe(true);
    for (const job of ["validation", "critical-coverage-shards", "critical-coverage"]) {
      const steps = jobs[job].steps;
      const checkout = steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toMatchObject({ "fetch-depth": 0, filter: "blob:none", "persist-credentials": false });
      const setup = steps.find((step: { uses?: string }) => step.uses === "$/.github/actions/setup-workspace");
      expect(setup.with).toMatchObject({ "install-deps": "false", "cache-npm": "false", "workspace-artifact": "restore" });
    }
    expect(workflow).toContain("PR_TEST_PLAN_FILE: ${{ matrix.lane == 'tests' && '.tmp/pr-test-plan.json' || '' }}");
    expect(workflow).toContain("merge-multiple: true");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("install-playwright-firefox: ${{ matrix.lane == 'static-guards'");
    expect(workflow).toContain("static-cache: ${{ matrix.lane == 'static-compile'");
    expect(workflow).toContain("matrix.lane == 'static-guards' || matrix.lane == 'docs'");
    const timings = jobs["critical-coverage-shards"].steps.find((step: { with?: { name?: string } }) => step.with?.name === "pr-coverage-timings-${{ matrix.shard }}");
    expect(timings.with["retention-days"]).toBe(7);
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
        steps?: Array<{
          env?: Record<string, string>; id?: string; name?: string; run?: string;
          uses?: string; with?: Record<string, string>;
        }>;
      }>;
    };
    const job = workflow.jobs["post-deploy-acceptance"];
    const acceptance = job.steps?.find((step) => step.id === "acceptance");

    expect(job.needs).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs).toEqual({ outcome: "${{ steps.acceptance.outputs.outcome }}" });
    expect(acceptance?.run).toContain("scripts/ci/run-post-deploy-acceptance.ts");
    expect(workflow.jobs["deploy-worker"].outputs).toEqual({
      worker_version: "${{ steps.verify-worker-deployment.outputs.worker_version }}",
    });
    const identity = job.steps?.find((step) => step.id === "verify-worker-identity");
    const deployIdentity = workflow.jobs["deploy-worker"].steps?.find(
      (step) => step.id === "verify-worker-deployment",
    );
    expect(identity?.run).toBe(deployIdentity?.run);
    expect(identity?.run).toContain("scripts/ci/verify-worker-deployment.ts");
    const setup = job.steps?.find((step) => step.uses === "$/.github/actions/setup-workspace");
    expect(setup?.with).toMatchObject({
      "install-deps": "false", "cache-npm": "false", "bootstrap-generated": "false",
    });
    expect(job.steps?.some((step) => /npm|npx|wrangler/.test(step.run ?? ""))).toBe(false);
    expect(acceptance?.env).toMatchObject({
      EXPECTED_PAGES_COMMIT: "${{ github.sha }}",
      EXPECTED_WORKER_VERSION: "${{ needs.deploy-worker.outputs.worker_version }}",
      OBSERVED_WORKER_VERSION: "${{ steps.verify-worker-identity.outputs.worker_version }}",
    });
  });

  it("installs each nightly Node 24 lane independently and keeps the Node 26 probe separate", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml")) as {
      jobs: Record<string, {
        needs?: string | string[];
        "continue-on-error"?: boolean;
        steps?: Array<{ uses?: string; run?: string; if?: string; "continue-on-error"?: boolean; with?: Record<string, unknown> }>;
      }>;
    };
    // The workspace-artifact fan-out was measured across three paired
    // nightlies and lengthened the critical path (+104s median) while the npm
    // cache was already hot in every job, so each lane installs on its own.
    expect(workflow.jobs.prepare).toBeUndefined();
    for (const job of ["full-static", "full-tests", "node26-proof"]) {
      const setup = workflow.jobs[job].steps?.find(
        (step) => step.uses === "$/.github/actions/setup-workspace");
      expect(workflow.jobs[job].needs).toBeUndefined();
      expect(setup?.with?.["workspace-artifact"]).toBeUndefined();
      expect(setup?.with?.["install-deps"]).toBeUndefined();
      expect(setup?.with?.["bootstrap-history"]).toBe("true");
    }
    expect(workflow.jobs["node26-proof"].steps?.find(
      (step) => step.uses === "$/.github/actions/setup-workspace")?.with?.["node-version"]).toBe("26");
    const fullStatic = workflow.jobs["full-static"];
    expect(fullStatic["continue-on-error"]).toBeUndefined();
    const staticSteps = fullStatic.steps ?? [];
    const save = staticSteps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(save).toBeGreaterThan(-1);
    expect(staticSteps.filter((step) => step.run).map((step) => step.run)).toEqual([
      "npm run lint", "npm run typecheck", "npm run typecheck:worker",
      "npm run lint:typed", "npm run typecheck:tests", "npm run check:structural",
    ]);
    for (const command of ["lint:typed", "typecheck:tests", "check:structural"]) {
      const index = staticSteps.findIndex((step) => step.run === `npm run ${command}`);
      expect(index).toBeGreaterThan(save);
      expect(staticSteps[index]["continue-on-error"]).toBeUndefined();
      expect(staticSteps[index].if).toBeUndefined();
    }
  });

  it("runs the weekly gitleaks scan without npm installation", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/weekly-validation.yml")) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; run?: string; with?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs.gitleaks.steps ?? [];
    expect(steps.some((step) => step.uses === "$/.github/actions/setup-workspace")).toBe(false);
    // Type stripping for the dependency-free runner needs the pinned Node 24.
    expect(steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with).toMatchObject({
      "node-version": "24.16.0",
    });
    const scan = steps.find((step) => step.run?.includes("run-gitleaks.ts"));
    expect(scan?.run).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ci/run-gitleaks.ts --range");
  });
});

it("runs secret scanning from trusted base code and policy before checking out PR content", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml"));
  const steps = workflow.jobs.secrets.steps;
  const checkouts = steps.filter((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  expect(checkouts[0].with.ref).toBe("${{ github.event.pull_request.base.sha }}");
  const snapshot = steps.findIndex((step: { run?: string }) => step.run?.includes('--snapshot-trusted="$RUNNER_TEMP/trusted-gitleaks"'));
  const scanner = steps.findIndex((step: { run?: string }) => step.run?.includes('run-gitleaks.ts" --range --policy-root='));
  expect(snapshot).toBeGreaterThan(steps.indexOf(checkouts[0]));
  expect(snapshot).toBeLessThan(scanner);
  expect(scanner).toBeGreaterThan(steps.indexOf(checkouts[0]));
  expect(scanner).toBeLessThan(steps.indexOf(checkouts[1]));
  expect(steps[scanner].env.GITLEAKS_HEAD_REF).toBe("${{ github.event.pull_request.head.sha }}");
});

it("scans PR merge-resolution lines for the full PR range including historical merges", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml"));
  const steps = workflow.jobs.secrets.steps;
  const tree = steps.findIndex((step: { run?: string }) => step.run?.includes('run-gitleaks.ts" --tree'));
  expect(tree).toBeGreaterThan(-1);
  expect(steps[tree].env.GITLEAKS_BASE_REF).toBe("${{ github.event.pull_request.base.sha }}");
  expect(steps[tree].env.GITLEAKS_HEAD_REF).toBe("${{ github.event.pull_request.head.sha }}");
  expect(steps[tree].run).toContain('--policy-root="$RUNNER_TEMP/trusted-gitleaks"');
  const candidate = steps.find((step: { run?: string }) => step.run?.includes("--candidate-policy"));
  expect(candidate.run).toContain('--trusted-root="$RUNNER_TEMP/trusted-gitleaks"');
  expect(steps.indexOf(candidate)).toBeGreaterThan(tree);
});

it("runs the mechanism-refresh verifier only from a trusted snapshot inside the token step", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/protocol-api-mechanism-refresh.yml"));
  const steps = workflow.jobs.refresh.steps as Array<{ name?: string; env?: Record<string, string>; run?: string }>;
  const tokenStep = steps.find((step) => step.env?.GH_TOKEN?.includes("MECHANISM_REFRESH_GITHUB_TOKEN"));
  expect(tokenStep).toBeDefined();
  const run = tokenStep!.run!;
  const snapshot = run.indexOf("cp scripts/ci/verify-mechanism-refresh-diff.ts");
  const prepareBranch = run.indexOf("--stage prepare-branch");
  expect(snapshot).toBeGreaterThanOrEqual(0);
  expect(snapshot).toBeLessThan(prepareBranch);
  // After prepare-branch switches the worktree to the automation branch, every
  // verifier invocation must resolve outside the mutable worktree.
  for (const line of run.split("\n")) {
    if (!line.includes("verify-mechanism-refresh-diff.ts") || line.includes("cp ")) continue;
    expect(line).toContain("$TRUSTED_VERIFIER/");
  }
  // The snapshot must carry each of the verifier's own relative imports.
  const verifier = readRepoFile("scripts/ci/verify-mechanism-refresh-diff.ts");
  const imports = [...verifier.matchAll(/from "\.\.\/lib\/([^"]+)"/g)].map((match) => match[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const lib of imports) expect(run).toContain(`scripts/lib/${lib}`);
});
