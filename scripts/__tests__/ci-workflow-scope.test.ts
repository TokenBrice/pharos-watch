import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";

type WorkflowStep = {
  id?: string; name?: string; uses?: string; run?: string; if?: string; "working-directory"?: string;
  permissions?: Record<string, string>;
  "continue-on-error"?: boolean; "timeout-minutes"?: number;
  with?: Record<string, unknown>; env?: Record<string, string>;
};
type WorkflowJob = {
  environment?: unknown; needs?: string | string[]; if?: string;
  permissions?: Record<string, string>; "continue-on-error"?: boolean;
  "timeout-minutes"?: number; env?: Record<string, string>;
  outputs?: Record<string, string>; strategy?: Record<string, unknown>; steps?: WorkflowStep[];
};
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, WorkflowJob> };

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function readWorkflow(name: string) {
  return parseYaml(readRepoFile(`.github/workflows/${name}`));
}

describe("CI workflow scope", () => {
  it.each([
    ["weekly-validation", "ci-report"], ["agent-maintenance-candidates", null],
    ["curation-expiry-sweep", null], ["ddr-curation-watch", null], ["ops-followups", null],
    ["post-deploy-first-execution", null],
  ])("serializes %s issue publication without cancellation", (name, job) => {
    const workflow = readWorkflow(`${name}.yml`);
    expect((job ? workflow.jobs[job] : workflow).concurrency).toEqual({ group: `${name}-publication`, "cancel-in-progress": false });
  });

  it("transports ignored compile/serve inputs without an unused Next cache branch", () => {
    const action = parseYaml(readRepoFile(".github/actions/setup-workspace/action.yml"));
    expect([action.inputs["next-cache"], action.inputs["next-cache-save"]]).toEqual([undefined, undefined]);
    expect(action.runs.steps.some((step: { with?: { path?: string } }) => step.with?.path === ".next/cache")).toBe(false);
    const packageStep = action.runs.steps.find((step: { name?: string }) => step.name === "Package required workspace");
    expect(packageStep.env.WORKSPACE_PATHS.trim().split("\n")).toEqual(expect.arrayContaining([
      "public/llms.txt", "src/lib/case-study-client-index.ts", "src/data/changelogs/index.ts",
    ]));
  });

  it("runs per-PR data, admission, and corpus-budget checks once in parallel with test planning", () => {
    const workflow = readWorkflow("pull-request-checks.yml") as Workflow;
    const steps = workflow.jobs.prepare.steps!;
    const setup = steps.findIndex((step) => step.uses === "./.github/actions/setup-workspace");
    const gate = steps.findIndex((step) => step.id === "test-corpus-budget");
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(setup);
    expect([steps[gate].if, steps[gate]["continue-on-error"]]).toEqual([undefined, undefined]);
    for (const cmd of ["check:incident-review-keys", "check:new-asset-evidence-packet", "check:test-corpus-budget", "check-donation-ledger-transition.ts"]) {
      expect(steps.filter((step) => step.run?.includes(cmd))).toHaveLength(1);
    }
    expect(steps[gate].env).toEqual({
      DOCS_ONLY: "${{ steps.classify.outputs.docs_only }}",
      GIT_OPTIONAL_LOCKS: "0",
      PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      TEST_BUDGET_OVERRIDE: "${{ contains(github.event.pull_request.labels.*.name, 'test-budget-override') }}",
      NEW_ASSET_GATE_OVERRIDE: "${{ contains(github.event.pull_request.labels.*.name, 'new-asset-gate-override') }}",
    });
    expect(steps[gate].run?.match(/--override/g)).toHaveLength(2);
    for (const frag of [
      'if [[ "${TEST_BUDGET_OVERRIDE}" == "true" ]]; then budget_args+=(--override); fi',
      'if [[ "${NEW_ASSET_GATE_OVERRIDE}" == "true" ]]; then new_asset_args+=(--override); fi',
      'echo "exit-code=${budget_status}" >> "${GITHUB_OUTPUT}"',
      "GITHUB_STEP_SUMMARY",
    ]) expect(steps[gate].run).toContain(frag);
    for (const check of ["plan", "donor", "incident", "budget", "new_asset"]) expect(steps[gate].run).toContain(`wait "\${${check}_pid}" || ${check}_status=$?`);
    expect(steps[gate].run!.trim().split("\n").map((line) => line.trim()).slice(-4)).toEqual([
      'if [[ "${plan_status}" != "0" || "${donor_status}" != "0" || "${incident_status}" != "0" || "${new_asset_status}" != "0" ]]; then',
      expect.stringContaining("::error::Prepare checks failed"), "exit 1", "fi",
    ]);
    expect(workflow.jobs.prepare.outputs?.test_corpus_budget).toBe("${{ steps.test-corpus-budget.outputs.exit-code }}");
    const prGate = workflow.jobs["pr-gate"];
    expect(prGate.env?.TEST_CORPUS_BUDGET).toBe("${{ needs.prepare.outputs.test_corpus_budget }}");
    const require = prGate.steps!.find((step) => step.name === "Require the manifest-selected validation path");
    expect(require?.run).toContain('if [ "${TEST_CORPUS_BUDGET:-missing}" != "0" ]; then');
    expect(require?.run).toContain("exit 1");

    const nightly = readWorkflow("nightly-validation.yml") as Workflow;
    expect(nightly.jobs["full-static"].steps!.filter((step) => step.run?.startsWith("npm run check:test-corpus-budget"))).toHaveLength(1);
    expect(nightly.jobs["full-static"].steps!.some((step) => step.run?.includes("check:test-corpus-budget -- --metrics-only"))).toBe(true);
  });

  it("feeds nightly Lighthouse trusted retained release data with a token confined to acquisition", () => {
    const job = (readWorkflow("nightly-validation.yml") as Workflow).jobs.lighthouse;
    const steps = job.steps!;
    expect(job.if).toContain("refs/heads/main");
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(job.env?.GH_TOKEN).toBeUndefined();
    const acquire = steps.findIndex((step) => step.run?.includes("preparePagesReleaseData"));
    const build = steps.findIndex((step) => step.run === "npm run check:pages-artifact");
    expect(acquire).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(acquire);
    expect(steps[acquire].env?.GH_TOKEN).toBe("${{ github.token }}");
    const directory = steps[acquire].env?.PAGES_RELEASE_DATA_DIR;
    expect(directory).toContain("runner.temp");
    expect(steps[build].env?.PAGES_RELEASE_DATA_DIR).toBe(directory);
    for (const [index, step] of steps.entries()) {
      if (index !== acquire) expect(step.env?.GH_TOKEN).toBeUndefined();
      expect(step.run ?? "").not.toContain("acquireReleaseData:false");
    }
  });

  it("bootstraps full history before the blocking weekly critical coverage", () => {
    const weekly = readWorkflow("weekly-validation.yml") as Workflow;
    const coverage = Object.values(weekly.jobs).find((job) => job.steps?.some((step) => step.run === "npm run coverage:critical"))!;
    const steps = coverage.steps!;
    expect(coverage.env?.CRITICAL_COVERAGE_RATCHET_ALL).toBe("1");
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    const setup = steps.findIndex((step) => step.uses === "$/.github/actions/setup-workspace");
    const run = steps.findIndex((step) => step.run === "npm run coverage:critical");
    expect(setup).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(setup);
    expect(steps[setup].with?.["bootstrap-history"]).toBe("true");
  });

  it("installs each nightly Node 24 lane independently", () => {
    const workflow = readWorkflow("nightly-validation.yml") as Workflow;
    expect(workflow.jobs.prepare).toBeUndefined();
    for (const job of ["full-static", "full-tests"]) {
      const setup = workflow.jobs[job].steps?.find((step) => step.uses === "$/.github/actions/setup-workspace");
      expect([workflow.jobs[job].needs, setup?.with?.["workspace-artifact"], setup?.with?.["install-deps"], setup?.with?.["bootstrap-history"]]).toEqual([undefined, undefined, undefined, "true"]);
    }
    const fullStatic = workflow.jobs["full-static"];
    expect(fullStatic["continue-on-error"]).toBeUndefined();
    const staticSteps = fullStatic.steps ?? [];
    const save = staticSteps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(save).toBeGreaterThan(-1);
    expect(staticSteps.filter((step) => step.run?.startsWith("npm run ")).map((step) => step.run)).toEqual([
      "npm run lint", "npm run typecheck", "npm run typecheck:worker",
      "npm run lint:typed", "npm run typecheck:tests", "npm run check:structural",
      "npm run check:unused-code", "npm run check:sensitive-page-copy",
      "npm run check:cron-connections", "npm run check:sql-safety",
      "npm run check:test-corpus-budget -- --metrics-only",
    ]);
    for (const step of staticSteps) {
      if (!step.run?.startsWith("npm run ")) continue;
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.if).toContain("!cancelled()");
      expect(step.if).toContain("steps.workspace.outcome == 'success'");
    }
    for (const command of ["lint", "typecheck", "typecheck:worker"]) {
      expect(staticSteps.findIndex((step) => step.run === `npm run ${command}`)).toBeLessThan(save);
    }
    for (const command of ["lint:typed", "typecheck:tests", "check:structural", "check:unused-code", "check:sensitive-page-copy", "check:cron-connections", "check:sql-safety"]) {
      expect(staticSteps.findIndex((step) => step.run === `npm run ${command}`)).toBeGreaterThan(save);
    }
    expect(staticSteps[save]["continue-on-error"]).toBeUndefined();
    expect(staticSteps[save].if).toContain("!cancelled()");
    for (const command of ["lint", "typecheck", "typecheck:worker"]) {
      const id = staticSteps.find((step) => step.run === `npm run ${command}`)?.id;
      expect(id, `Missing step id for npm run ${command}`).toBeDefined();
      expect(staticSteps[save].if).toContain(`steps.${id}.outcome == 'success'`);
    }
    const aggregate = staticSteps.find((step) => step.name === "Report mandatory static outcomes");
    expect(aggregate).toBeDefined();
    expect(aggregate!.if).toContain("steps.workspace.outcome == 'success'");
    expect(staticSteps.indexOf(aggregate!)).toBeGreaterThan(staticSteps.findIndex((step) => step.run === "npm run check:structural"));
    const outcomeEnv = Object.entries(aggregate!.env ?? {});
    expect(outcomeEnv).toHaveLength(11);
    for (const failedExpression of [undefined, ...outcomeEnv.map(([, expression]) => expression)]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "" };
      for (const [key, expression] of outcomeEnv) env[key] = expression === failedExpression ? "failure" : "success";
      const result = spawnSync("bash", ["-c", aggregate!.run!], { env, encoding: "utf8" });
      expect(result.stderr.toString()).toBe("");
      expect(result.status).toBe(failedExpression === undefined ? 0 : 1);
      if (failedExpression !== undefined) {
        const id = /steps\.([^.]+)\.outcome/.exec(failedExpression)![1];
        const command = staticSteps.find((step) => step.id === id)?.run;
        expect(command).toBeDefined();
        expect(result.stdout).toContain(command!.slice("npm run ".length));
      }
    }
  });

  it("keeps Node 26 advisory typing weekly and V9 resources unconditional only nightly", () => {
    const nightly = readWorkflow("nightly-validation.yml");
    const weekly = readWorkflow("weekly-validation.yml");
    expect(nightly.jobs["node26-proof"]).toBeUndefined();
    const probe = weekly.jobs["node26-proof"];
    expect([probe["continue-on-error"], probe.needs]).toEqual([true, undefined]);
    expect(probe.steps.find((step: WorkflowStep) => step.uses === "$/.github/actions/setup-workspace").with).toMatchObject({
      "node-version": "26", "bootstrap-history": "true", "static-cache": "true",
    });
    expect(probe.steps.filter((step: WorkflowStep) => step.run).map((step: WorkflowStep) => step.run))
      .toEqual(["npm run typecheck", "npm run typecheck:worker"]);
    expect(nightly.jobs["v9-resource"].if).toBeUndefined();
    expect(nightly.jobs["v9-resource"].steps.filter((step: WorkflowStep) => step.run === "npm run test:v9-resource")).toHaveLength(1);
    expect(weekly.jobs["v9-resource"]).toBeUndefined();
    expect(readRepoFile(".github/workflows/weekly-validation.yml")).not.toContain("npm run test:v9-resource");
    expect(nightly.jobs["full-tests"].strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    const shardRun = nightly.jobs["full-tests"].steps.find((step: WorkflowStep) =>
      step.run?.includes("npm test -- --shard=${{ matrix.shard }}/4"));
    for (const frag of [
      "--reporter=default --reporter=github-actions --reporter=json",
      "--outputFile=.tmp/vitest-shard-${{ matrix.shard }}.json",
      "--reporter=./scripts/test/vitest-file-timings-reporter.mts",
    ]) expect(shardRun?.run).toContain(frag);
    expect(shardRun?.env).toEqual({ PHAROS_VITEST_FILE_TIMINGS: ".tmp/vitest-file-timings-${{ matrix.shard }}.json" });
  });

  it("runs CodeQL weekly on Monday and manual dispatch, not pushes", () => {
    const workflow = readWorkflow("codeql.yml");
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
  });

  it("restricts auxiliary production publishers to main for manual and scheduled runs", () => {
    const scenarios = readWorkflow("dependency-scenarios-refresh.yml");
    const map = readWorkflow("safety-map-refresh.yml");
    const curation = readWorkflow("curation-expiry-sweep.yml");
    for (const workflow of [scenarios, map, curation]) {
      expect(workflow.on).toHaveProperty("workflow_dispatch");
      expect(workflow.on.schedule.length).toBeGreaterThan(0);
    }
    for (const job of [scenarios.jobs.scenarios, map.jobs.plan, curation.jobs.sweep]) {
      expect(job.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    }
    expect(curation.on.schedule).toEqual([{ cron: "45 5 * * 2" }]);
    expect(scenarios.on.schedule).toEqual([{ cron: "17 2 * * *" }]);
    expect(Object.keys(map.jobs)).toEqual(["plan"]);
    const steps = map.jobs.plan.steps as WorkflowStep[];
    expect(steps.filter((step) => step.uses?.startsWith("actions/checkout@"))).toHaveLength(1);
    expect(steps.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(false);
    const setups = steps.filter((step) => step.uses === "$/.github/actions/setup-workspace");
    expect(setups).toHaveLength(2);
    expect(setups[0].if).toBeUndefined();
    expect(setups[0].with).toMatchObject({ "browser-cache": "false", "bootstrap-generated": "false", "install-playwright-firefox": "false" });
    expect(setups[1].if).toBe("${{ steps.plan.outputs.should_render == 'true' }}");
    expect(setups[1].with).toMatchObject({ "install-deps": "false", "browser-cache": "true", "install-playwright-firefox": "true" });
    expect(steps.indexOf(setups[1])).toBeGreaterThan(steps.findIndex((step) => step.id === "plan"));
    for (const name of [
      "Bootstrap render inputs", "Verify render credentials", "Render and validate publication files",
      "Upload the rendered map", "Publish in commit-marker order and verify readback",
    ]) expect(steps.find((step) => step.name === name)?.if).toBe("${{ steps.plan.outputs.should_render == 'true' }}");
    for (const phase of ["render", "publish"]) {
      const step = steps.find((step) => step.run?.includes(`publish-safety-score-map.ts ${phase}`));
      expect(step?.env?.PLAN_TOKEN).toBe("${{ steps.plan.outputs.plan_token }}");
      expect(step?.run).toContain('--plan-token="${PLAN_TOKEN}"');
    }
    const summaries = steps.filter((step) => step.run?.includes("publish-safety-score-map.ts summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].if).toBe("${{ always() && steps.plan.outcome == 'success' }}");
    expect(steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))).toHaveLength(1);
    expect(steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.path).toContain("${{ env.MAP_OUT_DIR }}/latest.webp");
  });

  it("replays scenarios under the resolved compatible evaluator checkout without credentials", () => {
    const steps = readWorkflow("dependency-scenarios-refresh.yml").jobs.scenarios.steps as WorkflowStep[];
    const index = (predicate: (step: WorkflowStep) => boolean) => {
      const found = steps.findIndex(predicate);
      expect(found).toBeGreaterThan(-1);
      return found;
    };
    expect(steps[0].with).toMatchObject({ "persist-credentials": false, "fetch-depth": 0 });
    const plan = index((s) => s.run?.includes("--mode plan") === true), resolveSource = index((s) => s.id === "source");
    expect(steps[resolveSource].run).toContain("--mode resolve-source");
    expect(steps[resolveSource].env).toEqual({ TRUSTED_REF: "${{ github.sha }}" });
    const checkout = index((s) => s.run?.includes("git worktree add --detach") === true);
    expect(steps[checkout].env).toEqual({ COMMIT_SHA: "${{ steps.source.outputs.commit_sha }}" });
    const setups = steps.filter((s) => s.uses?.startsWith("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"));
    expect(setups.map((s) => s.with?.["node-version-file"])).toEqual(["${{ env.EVALUATOR_DIR }}/.nvmrc", ".nvmrc"]);
    const historicalNode = steps.indexOf(setups[0]!), currentNode = steps.indexOf(setups[1]!);
    const install = index((s) => s.run?.includes("npm ci") === true && s["working-directory"] === "${{ env.EVALUATOR_DIR }}");
    expect(steps[install].run).toContain("npm run generate:safety-score-v9-evaluation-build -- --check");
    expect(steps[install].run).toContain("git diff --exit-code");
    const historical = index((s) => s.run?.includes("--accepted-cache-export") === true);
    expect(steps[historical]["working-directory"]).toBe("${{ env.EVALUATOR_DIR }}");
    expect(steps[historical].run).toContain("--mode compute");
    const publish = index((s) => s.run?.includes("--mode publish") === true);
    const order = [plan, resolveSource, checkout, historicalNode, install, historical, currentNode, publish];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const [position, step] of steps.entries()) {
      expect(JSON.stringify(step).includes("secrets."), step.name ?? step.uses).toBe(position === plan || position === publish);
    }
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect((upload?.with?.path as string).trim().split("\n")).toEqual(["${{ env.SCENARIO_OUT_DIR }}/artifact.json", "${{ env.SCENARIO_OUT_DIR }}/artifact.verified.sha256", "${{ env.SCENARIO_OUT_DIR }}/source.json"]);
  });

  it("checks public live cache policy independently of secret-bearing account evidence", () => {
    const workflow = readWorkflow("production-canaries.yml");
    const step = workflow.jobs.transport.steps.find((entry: WorkflowStep) => entry.run === "node scripts/ci/check-live-api-cache-policy.mjs");
    expect(step).toBeDefined();
    expect(step.if).toBe("${{ !cancelled() }}");
    expect(step.env).toEqual({ SITE_SESSION_SIGNING_KEY: "${{ secrets.SITE_SESSION_SIGNING_KEY }}" });
    expect(workflow.jobs.transport.env).toBeUndefined();
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
  });

  it.each([
    ["pages-release.yml", ["Refresh API-backed release data", "Build clean production export", "Reject signing key in exported site", "Reject secrets in retained release data"]],
    ["production-canaries.yml", ["Check live production Pages assets", "Check live direct and same-origin API Cache-Control", "Capture home and detail viewport matrix"]],
    ["weekly-validation.yml", ["Capture production dependency coverage"]],
  ])("scopes the session signing key to lane readers in %s", (file, consumers) => {
    const workflow = readWorkflow(file);
    const holders: string[] = [];
    expect(workflow.env?.SITE_SESSION_SIGNING_KEY).toBeUndefined();
    for (const job of Object.values(workflow.jobs) as WorkflowJob[]) {
      expect(job.env?.SITE_SESSION_SIGNING_KEY).toBeUndefined();
      for (const step of job.steps ?? []) if (step.env?.SITE_SESSION_SIGNING_KEY !== undefined) {
        expect(step.env.SITE_SESSION_SIGNING_KEY).toBe("${{ secrets.SITE_SESSION_SIGNING_KEY }}");
        holders.push(step.name!);
      }
    }
    expect(holders).toEqual(consumers);
  });

  it("builds Pages without the Next compiler cache and consolidates artifact checks", () => {
    const steps = readWorkflow("pages-release.yml").jobs["pages-release"].steps as WorkflowStep[];
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(1);
    expect(steps.find((s) => s.uses?.startsWith("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"))?.with).toEqual({ "node-version-file": ".nvmrc" });
    expect(steps.some((s) => s.uses?.includes("setup-workspace") || s.uses?.startsWith("actions/cache"))).toBe(false);
    const restore = steps.findIndex((s) => s.run?.includes("tar --zstd -xf"));
    const refresh = steps.findIndex((s) => s.run === "node --import tsx scripts/maintenance/refresh-pages-release-data.ts");
    const build = steps.findIndex((s) => s.run?.split("\n").includes("npm run generated:post-refresh"));
    const check = steps.findIndex((s) => s.run?.includes("npm run check:pages-release"));
    const retain = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(restore);
    expect(build).toBeGreaterThan(refresh);
    expect(check).toBeGreaterThan(build);
    expect(steps[check + 1].name).toBe("Reject secrets in retained release data");
    expect(retain).toBe(check + 2);
    expect(steps[check].run).toContain("createPagesReleaseDataArchive");
    const gates = steps[check].run!.trim().split("\n");
    expect(gates).toEqual(expect.arrayContaining(['wait "$gates_pid" || gates_status=$?', 'wait "$archive_pid" || archive_status=$?']));
    expect(gates.at(-1)).toBe('[ "$gates_status" -eq 0 ] && [ "$archive_status" -eq 0 ]');
    expect(steps[refresh].env).toMatchObject({
      SITE_API_SHARED_SECRET: "${{ secrets.SITE_API_SHARED_SECRET }}",
      DIGEST_API_URL: "https://site-api.pharos.watch",
      DEPEG_EVENTS_API_URL: "https://site-api.pharos.watch",
      PUBLIC_DATASETS_API_URL: "https://site-api.pharos.watch",
    });
    expect(steps[build].env).toMatchObject({
      PHAROS_RELEASE_PR_TYPECHECKED: "1", PHAROS_DETAIL_SNAPSHOT_SOURCE: "bulk", PHAROS_OG_EVERGREEN_MAP_ONLY: "1",
      SITE_API_SHARED_SECRET: "${{ secrets.SITE_API_SHARED_SECRET }}",
    });
    expect(steps[build].run).toContain('if [ -z "${SITE_API_SHARED_SECRET//[[:space:]]/}" ]; then');
    expect(steps[build].run?.indexOf("exit 1")).toBeLessThan(steps[build].run!.indexOf("npm run generated:post-refresh"));
    expect(steps[build].run).toContain("env -u SITE_API_SHARED_SECRET npx --no-install next build --webpack");
    expect(steps[build].run).toContain("env -u SITE_API_SHARED_SECRET -u SITE_SESSION_SIGNING_KEY npm run postbuild");
    expect(steps.filter((s) => s.env?.SITE_API_SHARED_SECRET != null).map((s) => s.name)).toEqual([
      "Refresh API-backed release data", "Build clean production export", "Reject signing key in exported site", "Reject secrets in retained release data",
    ]);
  });

  it.each(["deploy-cloudflare.yml", "pages-release.yml", "rebuild-pages.yml", "pages-prepare.yml"])(
    "never enables the PR snapshot replay age waiver in %s", (workflow) => {
      expect(readRepoFile(`.github/workflows/${workflow}`)).not.toContain("PHAROS_PAGES_REPLAY");
    },
  );

  it("takes every pinned setup-node version from .nvmrc after checkout", () => {
    expect(parseYaml(readRepoFile(".github/actions/setup-workspace/action.yml")).inputs["node-version"].default).toBe(readRepoFile(".nvmrc").trim());
    const jobs: string[] = [];
    for (const file of ["deploy-cloudflare.yml", "pages-release.yml", "pull-request-checks.yml", "weekly-validation.yml", "nightly-validation.yml"]) {
      for (const [name, job] of Object.entries((readWorkflow(file) as Workflow).jobs)) {
        const steps = job.steps ?? [], setup = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
        if (setup < 0) continue;
        jobs.push(name);
        expect(steps[setup].with).toEqual({ "node-version-file": ".nvmrc" });
        const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
        expect(checkout).toBeGreaterThanOrEqual(0);
        expect(checkout).toBeLessThan(setup);
      }
    }
    expect(jobs).toEqual(["plan", "post-deploy-acceptance", "pages-release", "secrets", "pages-artifact", "gitleaks", "ci-report", "test-timings"]);
  });

  it("rejects absent bulk credentials before running release generators", () => {
    const build = (readWorkflow("pages-release.yml").jobs["pages-release"].steps as WorkflowStep[]).find((step) => step.name === "Build clean production export")!;
    const credentialGate = build.run!.slice(0, build.run!.indexOf("npm run generated:post-refresh"));
    for (const credential of [undefined, "", " \t\n", "test-site-credential"]) {
      const env = { ...process.env };
      delete env.SITE_API_SHARED_SECRET;
      if (credential !== undefined) env.SITE_API_SHARED_SECRET = credential;
      const result = spawnSync("bash", ["-c", credentialGate], { env, encoding: "utf8" });
      expect(result.status).toBe(credential === "test-site-credential" ? 0 : 1);
      expect(result.stdout).not.toContain("test-site-credential");
    }
  });

  it("prepares only pure/history inputs in parallel with the Worker and gates live Pages work", () => {
    const deploy = readWorkflow("deploy-cloudflare.yml"), rebuild = readWorkflow("rebuild-pages.yml");
    const prepare = readWorkflow("pages-prepare.yml"), release = readWorkflow("pages-release.yml");
    const artifactName = "pages-workspace-production-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}";
    const steps = prepare.jobs["pages-prepare"].steps as WorkflowStep[];
    expect(deploy.jobs["deploy-worker"].needs).toEqual(["plan"]);
    const workerDeployCondition = String(deploy.jobs["deploy-worker"].if).replace(/\s+/g, " ");
    expect(workerDeployCondition).toContain("!cancelled()");
    expect(workerDeployCondition).not.toContain("always()");
    expect(workerDeployCondition).toContain("needs.plan.outputs.worker_required == 'true'");
    expect(deploy.jobs["pages-prepare"]).toMatchObject({ needs: "plan", uses: "$/.github/workflows/pages-prepare.yml", if: "${{ needs.plan.outputs.pages_required == 'true' }}" });
    expect(deploy.jobs["pages-release"].needs).toEqual(["plan", "deploy-worker", "pages-prepare"]);
    for (const frag of ["always()", "needs.plan.result == 'success'", "needs.plan.outputs.pages_required == 'true'", "needs.pages-prepare.result == 'success'"]) expect(deploy.jobs["pages-release"].if).toContain(frag);
    expect(String(deploy.jobs["pages-release"].if).replace(/\s+/g, " ")).toContain("needs.plan.outputs.worker_required != 'true' || needs.deploy-worker.result == 'success'");
    expect(rebuild.jobs["pages-prepare"].uses).toBe("$/.github/workflows/pages-prepare.yml");
    expect(rebuild.jobs["pages-release"]).toMatchObject({ needs: "pages-prepare", uses: deploy.jobs["pages-release"].uses });
    expect([rebuild.jobs["pages-release"].with.refresh_data, deploy.jobs["pages-release"].with.refresh_data, release.on.workflow_call.inputs.refresh_data]).toEqual([undefined, undefined, undefined]);
    const releaseSteps = release.jobs["pages-release"].steps as WorkflowStep[];
    const refresh = releaseSteps.find((s) => s.name === "Refresh API-backed release data")!;
    expect([refresh.if, refresh.run]).toEqual([undefined, "node --import tsx scripts/maintenance/refresh-pages-release-data.ts"]);
    expect(releaseSteps.some((s) => s.name === "Validate release-data refresh result" || s.run?.includes("PAGES_REFRESH_RESULT_PATH"))).toBe(false);
    expect([prepare.jobs["pages-prepare"].environment, prepare.on.workflow_call?.secrets]).toEqual([undefined, undefined]);
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    expect(steps.some((s) => s.run === "npm run generated:compile-input")).toBe(true);
    expect(steps.some((s) => /refresh-pages-release-data|post-refresh|next build|pages deploy/.test(s.run ?? ""))).toBe(false);
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    const name = steps.find((s) => s.id === "workspace-artifact-name")!;
    expect(name.env?.WORKSPACE_ARTIFACT_NAME).toBe(artifactName);
    expect(name.run).not.toContain("${{");
    expect(prepare.jobs["pages-prepare"].outputs.workspace_artifact_name).toBe("${{ steps.workspace-artifact-name.outputs.name }}");
    expect(prepare.on.workflow_call.outputs.workspace_artifact_name.value).toBe("${{ jobs.pages-prepare.outputs.workspace_artifact_name }}");
    for (const caller of [deploy, rebuild]) expect(caller.jobs["pages-release"].with.workspace_artifact_name).toBe("${{ needs.pages-prepare.outputs.workspace_artifact_name }}");
    expect(release.on.workflow_call.inputs.workspace_artifact_name).toMatchObject({ required: true, type: "string" });
    expect(release.on.workflow_call.secrets.SITE_API_SHARED_SECRET).toEqual({ required: true });
    expect(release.on.workflow_call.secrets.SITE_SESSION_SIGNING_KEY).toEqual({ required: false });
    for (const key of ["SITE_API_SHARED_SECRET", "SITE_SESSION_SIGNING_KEY", "R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID", "R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY"]) {
      for (const caller of [deploy, rebuild]) expect(caller.jobs["pages-release"].secrets[key]).toBe(`\${{ secrets.${key} }}`);
    }
    expect(release.jobs["pages-release"].env.SITE_API_SHARED_SECRET).toBeUndefined();
    expect(upload?.with).toMatchObject({ name: "${{ steps.workspace-artifact-name.outputs.name }}", "compression-level": 0, "if-no-files-found": "error" });
    const packStep = steps.find((s) => s.run?.includes("tar -I"))!;
    expect(packStep.run).toContain("zstd -T0 -3");
    const packedPaths = packStep.env?.WORKSPACE_PATHS?.trim().split("\n") ?? [];
    const compileInputOutputs = (GENERATED_ARTIFACT_REGISTRY as Array<{ buildLifecycle: string; outputPaths: string[] }>)
      .filter((a) => a.buildLifecycle === "compile-input")
      .flatMap((a) => a.outputPaths);
    expect(packedPaths).toEqual(expect.arrayContaining(["node_modules", ...compileInputOutputs]));
    const download = releaseSteps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with?.name).toBe("${{ inputs.workspace_artifact_name }}");
    expect(download?.with?.name).not.toContain("run_attempt");
    expect(release.jobs["pages-release"].environment.name).toBe("production");
  });

  it("accepts the earlier Pages producer attempt while rejecting unsafe or unrelated names", () => {
    const steps = readWorkflow("pages-release.yml").jobs["pages-release"].steps as WorkflowStep[];
    const validation = steps.find((step) => step.name === "Validate prepared workspace artifact name")!;
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(steps.indexOf(validation)).toBeLessThan(steps.indexOf(download));
    expect(validation.env?.WORKSPACE_ARTIFACT_NAME).toBe("${{ inputs.workspace_artifact_name }}");
    expect(validation.run).not.toContain("${{");
    const sha = "a".repeat(40);
    const producerName = `pages-workspace-production-123-1-${sha}`;
    for (const [name, status] of [
      [producerName, 0], ["", 1], [`pages-workspace-production-456-1-${sha}`, 1],
      ["pages-workspace-production-123-1-" + "b".repeat(40), 1],
      [`pages-workspace-production-123-0-${sha}`, 1], [`${producerName}\ninjected=value`, 1], ["$(exit 0)", 1],
    ] as const) {
      const result = spawnSync("bash", ["-e", "-c", validation.run!], {
        env: { ...process.env, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sha, WORKSPACE_ARTIFACT_NAME: name },
        encoding: "utf8",
      });
      expect(result.status).toBe(status);
    }
  });

  it("packages both Workers before one migration and deploys heavy then public with individual proofs", () => {
    const steps = readWorkflow("deploy-cloudflare.yml").jobs["deploy-worker"].steps as WorkflowStep[];
    const workerBootstrap = steps.findIndex((s) => s.run?.includes("npm run bootstrap:generated:worker"));
    const packageStep = steps.findIndex((s) => s.run?.includes("npm run check:worker-package"));
    const migrations = steps.map((s, i) => /d1 migrations apply/.test(s.run ?? "") ? i : -1).filter((i) => i >= 0);
    const heavyDeploy = steps.findIndex((s) => /wrangler deploy.*--config wrangler\.heavy\.toml/.test(s.run ?? ""));
    const publicDeploy = steps.findIndex((s) => /wrangler deploy.*--config wrangler\.toml/.test(s.run ?? ""));
    const heavyVerify = steps.findIndex((s) => s.id === "verify-heavy-deployment");
    const publicVerify = steps.findIndex((s) => s.id === "verify-worker-deployment");
    expect(workerBootstrap).toBeGreaterThanOrEqual(0);
    expect(steps[workerBootstrap].run).toContain("assertBootstrapTrackedOutputsUnchanged");
    expect(packageStep).toBeGreaterThan(workerBootstrap);
    for (const cmd of [
      "env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npm run check:migrations",
      "env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npm run check:worker-package",
      "wrangler queues info pharos-reserve-continuation --config worker/wrangler.toml",
      "wrangler queues info pharos-reserve-continuation-dlq --config worker/wrangler.toml",
      "wrangler queues info pharos-v9-continuation --config worker/wrangler.heavy.toml",
      "wrangler queues info pharos-v9-continuation-dlq --config worker/wrangler.heavy.toml",
      "npm run check:remote-d1-baseline-ledger",
    ]) expect(steps[packageStep].run).toContain(cmd);
    for (const pid of ["migrations", "package", "queue_main", "queue_dlq", "v9_queue_main", "v9_queue_dlq", "baseline"]) expect(steps[packageStep].run).toContain(`:\${${pid}_pid}:`);
    expect(steps[packageStep].run!.split("\n").map((line) => line.trim())).toEqual(expect.arrayContaining(['wait "${pid}" || status=$?', "failed=1"]));
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBeGreaterThan(packageStep);
    expect(heavyDeploy).toBeGreaterThan(migrations[0]);
    expect(heavyVerify).toBeGreaterThan(heavyDeploy);
    expect(publicDeploy).toBeGreaterThan(heavyVerify);
    expect(publicVerify).toBeGreaterThan(publicDeploy);
    for (const i of [heavyDeploy, publicDeploy]) expect(steps[i].run).toContain('--message "GitHub Actions deploy ${GITHUB_SHA}"');
    expect(steps[heavyVerify].run).toContain("--script-name stablecoin-heavy");
    expect(steps[publicVerify].run).toContain("--script-name stablecoin-api");
    expect(steps.slice(0, heavyDeploy).some((s) => /deployments list|versions list/.test(s.run ?? ""))).toBe(false);
  });

  it("records both verified role markers monotonically only after paired proof", () => {
    const steps = readWorkflow("deploy-cloudflare.yml").jobs["deploy-worker"].steps as WorkflowStep[];
    const markerIndex = steps.findIndex((step) => step.name === "Record verified Worker activation markers");
    const marker = steps[markerIndex];
    expect(markerIndex).toBeGreaterThan(steps.findIndex((step) => step.id === "verify-worker-deployment"));
    expect(marker.env).toMatchObject({
      PUBLIC_ACTIVATED_AT: "${{ steps.verify-worker-deployment.outputs.worker_activation_at }}",
      PUBLIC_VERSION: "${{ steps.verify-worker-deployment.outputs.worker_version }}",
      HEAVY_ACTIVATED_AT: "${{ steps.verify-heavy-deployment.outputs.worker_activation_at }}",
      HEAVY_VERSION: "${{ steps.verify-heavy-deployment.outputs.worker_version }}",
    });
    for (const frag of ["for role in heavy public", "worker-active-version:${role}", "worker-version-activated:${version}", "ON CONFLICT(key) DO NOTHING", "WHERE excluded.updated_at >= cache.updated_at", "exit 1"]) expect(marker.run).toContain(frag);
    expect(marker.run).not.toContain("exit 0");
    expect(marker.run).not.toContain("date +");
  });

  it("records read-only post-deploy acceptance for successfully deployed surfaces", () => {
    const workflow = readWorkflow("deploy-cloudflare.yml") as Workflow;
    const job = workflow.jobs["post-deploy-acceptance"];
    const acceptance = job.steps?.find((step) => step.name === "Record deployment identity and operational acceptance");
    expect([job.needs, job.environment, job.permissions, job.outputs, acceptance?.if]).toEqual([
      ["plan", "deploy-worker", "pages-release"], undefined, { contents: "read" }, undefined, "${{ always() }}",
    ]);
    expect(acceptance?.run).toContain("scripts/ci/run-post-deploy-acceptance.ts");
    expect(workflow.jobs["deploy-worker"].outputs).toEqual({
      worker_version: "${{ steps.verify-worker-deployment.outputs.worker_version }}",
      heavy_worker_version: "${{ steps.verify-heavy-deployment.outputs.worker_version }}",
    });
    const identity = job.steps?.find((step) => step.id === "verify-worker-identity");
    expect(identity?.run).toBe(workflow.jobs["deploy-worker"].steps?.find((step) => step.id === "verify-worker-deployment")?.run);
    expect(identity?.run).toContain("scripts/ci/verify-worker-deployment.ts");
    const heavyIdentity = job.steps?.find((step) => step.id === "verify-heavy-identity");
    expect(heavyIdentity?.run).toBe(workflow.jobs["deploy-worker"].steps?.find((step) => step.id === "verify-heavy-deployment")?.run);
    expect(heavyIdentity?.if).toBe("${{ always() && needs.deploy-worker.result == 'success' }}");
    expect(job.steps?.some((step) => step.name === "Require unchanged heavy activation identity")).toBe(false);
    expect(job.steps?.find((step) => step.uses?.startsWith("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"))?.with).toEqual({ "node-version-file": ".nvmrc" });
    expect(job.steps?.some((step) => step.uses?.includes("setup-workspace"))).toBe(false);
    expect(job.steps?.some((step) => /npm|npx|wrangler/.test(step.run ?? ""))).toBe(false);
    expect(acceptance?.env).toMatchObject({
      EXPECTED_PAGES_COMMIT: "${{ github.sha }}", EXPECTED_WORKER_VERSION: "${{ needs.deploy-worker.outputs.worker_version }}",
      OBSERVED_WORKER_VERSION: "${{ steps.verify-worker-identity.outputs.worker_version }}", EXPECTED_HEAVY_WORKER_VERSION: "${{ needs.deploy-worker.outputs.heavy_worker_version }}",
      OBSERVED_HEAVY_WORKER_VERSION: "${{ steps.verify-heavy-identity.outputs.worker_version }}", PHAROS_API_KEY: "${{ secrets.PHAROS_API_KEY }}",
    });
  });

  it("gates every Shock Coverage Refresh credential path on main", () => {
    const shock = readWorkflow("shock-coverage-refresh.yml") as Workflow;
    expect(shock.jobs.targets.if).toBe("${{ github.ref == 'refs/heads/main' && (github.event_name != 'schedule' || github.event.schedule == '41 3 * * *') }}");
    expect([shock.jobs.measure.if, shock.jobs.refresh.if]).toEqual(["${{ github.ref == 'refs/heads/main' }}", "${{ github.ref == 'refs/heads/main' }}"]);
  });

  it("restores Worker incident evidence from its own completed main run even when an evidence job alerts", () => {
    const monitor = readWorkflow("worker-memory-monitor.yml") as Workflow;
    const restore = monitor.jobs.incidents.steps!.find((step) => step.name === "Restore latest rolling evidence archive")!;
    expect(restore.env).toMatchObject({ GH_REPO: "${{ github.repository }}" });
    for (const guard of [
      "actions/artifacts?per_page=100", '.path == ".github/workflows/worker-memory-monitor.yml"',
      '(.event == "schedule" or .event == "workflow_dispatch")', '.status == "completed"',
      '.conclusion != "cancelled"', ".head_sha == $head_sha", ".head_repository.full_name == $repo",
      'startswith("worker-incidents-\\($run_id)-")',
      'if ! run_json="$(gh api "repos/$GH_REPO/actions/runs/$run_id")"; then',
      "refusing to start a fresh window", "actions/runs/$run_id",
    ]) expect(restore.run).toContain(guard);
    expect(restore.run).not.toContain('.conclusion == "success"');
    expect(restore.id).toBe("restore-archive");
    expect(monitor.jobs.incidents.steps!.find((step) => step.name === "Capture deployment delivery child and publication evidence")!.if).toContain("steps.restore-archive.outcome == 'success'");
  });

  it("keeps the curation expiry sweep process-only with sentinel verdicts and by-week renewal views", () => {
    const workflow = readWorkflow("curation-expiry-sweep.yml") as Workflow;
    const job = workflow.jobs.sweep, steps = job.steps!;
    const sentinels = steps.find((s) => s.id === "sentinels")!, renewals = steps.find((s) => s.id === "renewals")!;
    const calendar = steps.find((s) => s.id === "calendar")!, issue = steps.find((s) => s.run?.includes("gh issue edit"))!;
    const commands = steps.map((s) => s.run ?? "").join("\n");
    expect([workflow.permissions, job.permissions]).toEqual([{ contents: "read" }, { contents: "read", issues: "write" }]);
    expect(commands).not.toMatch(/\bgit push\b|\bgh pr (create|merge|edit|close)\b|ledger-append/);
    expect(issue.run).toContain("gh issue edit");
    for (const arg of [
      "worker/scripts/check-safety-score-v9-ledger-sentinels.ts", "--registry agents/sweep/missing-data-registry.json",
      "--ledger .github/artifacts/safety-score-missing-data-reviewed-ledger.json", "--replay agents/sweep/replay.json", "--markdown agents/sweep/sentinel-resolutions.md",
    ]) expect(sentinels.run).toContain(arg);
    expect(steps.indexOf(steps.find((s) => s.id === "registry")!)).toBeLessThan(steps.indexOf(sentinels));
    expect(renewals.run).toContain("--days 14 --by-week");
    expect(calendar.run).toContain('--horizon "$RENEWAL_HORIZON" --by-week');
    expect(calendar.env?.RENEWAL_HORIZON).toBe("2027-01-19");
    expect(steps.indexOf(sentinels)).toBeLessThan(steps.indexOf(renewals));
    expect(steps.indexOf(renewals)).toBeLessThan(steps.indexOf(calendar));
    for (const step of [sentinels, renewals, calendar]) expect(step["timeout-minutes"]).toBe(10);
    expect(steps.find((s) => s.id === "snapshots")!.with?.path).toBe("agents/sweep/");
  });

  it("resolves local action references only where the checkout is the workflow commit", () => {
    const names = readdirSync(resolve(process.cwd(), ".github/workflows")).filter((file) => file.endsWith(".yml"));
    let localJobs = 0;
    for (const name of names) {
      const workflow = readWorkflow(name) as Workflow & { on: Record<string, unknown> };
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const steps = job.steps ?? [], local = steps.findIndex((step) => step.uses?.startsWith("./"));
        if (local < 0) continue;
        localJobs++;
        expect(`${name}:${id}`).toMatch(/^pull-request-checks\.yml:/);
        expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
        const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
        expect(checkout, id).toBeGreaterThanOrEqual(0);
        expect(checkout, id).toBeLessThan(local);
        expect(steps[checkout].with?.ref, id).toBeUndefined();
      }
    }
    expect(localJobs).toBe(3);
  });

  it("caches installed dependencies only in secret-free jobs", () => {
    const pr = readWorkflow("pull-request-checks.yml") as Workflow;
    const nightly = readWorkflow("nightly-validation.yml") as Workflow;
    const weekly = readWorkflow("weekly-validation.yml") as Workflow;
    const deploy = readWorkflow("deploy-cloudflare.yml") as Workflow;
    const preparePages = readWorkflow("pages-prepare.yml") as Workflow;
    const setupRefs = new Set(["$/.github/actions/setup-workspace", "./.github/actions/setup-workspace"]);
    const setupOf = (job: WorkflowJob) => job.steps?.find((step) => setupRefs.has(step.uses ?? ""));
    expect(setupOf(pr.jobs.prepare)?.with).toMatchObject({ "node-modules-cache": "true" });
    for (const job of ["full-static", "full-tests", "v9-resource", "lighthouse", "web-vitals", "test-plan-parity"]) {
      expect(setupOf(nightly.jobs[job])?.with, job).toMatchObject({ "node-modules-cache": "true" });
    }
    for (const [job, definition] of Object.entries(weekly.jobs)) {
      if (job === "gitleaks" || job === "ci-report") continue;
      expect(setupOf(definition)?.with, job).toMatchObject({ "node-modules-cache": "true" });
    }
    expect(setupOf(weekly.jobs.gitleaks)).toBeUndefined();
    expect(setupOf(preparePages.jobs["pages-prepare"])?.with).toMatchObject({ "node-modules-cache": "false" });
    expect(setupOf(deploy.jobs["deploy-worker"])?.with).toMatchObject({ "node-modules-cache": "false", "bootstrap-generated": "false" });
    expect([setupOf(deploy.jobs["post-deploy-acceptance"]), setupOf(deploy.jobs.plan)]).toEqual([undefined, undefined]);
  });

  it("keeps validation history and wires the Pages critical-CSS scope", () => {
    const pr = readWorkflow("pull-request-checks.yml") as Workflow;
    const checkoutOf = (job: WorkflowJob) => job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(pr.jobs.validation.strategy?.["max-parallel"]).toBe(14);
    expect(checkoutOf(pr.jobs.validation)?.with?.["fetch-depth"]).toBe(0);
    expect(checkoutOf(pr.jobs["pages-artifact"])?.with?.["fetch-depth"]).toBe(1);
    expect(pr.jobs["pages-artifact"].steps?.find((step) => step.name === "Acquire release data with the trusted base helper")?.run)
      .toContain('git fetch --no-tags --depth=1 --filter=blob:none origin "${TRUSTED_PAGES_BASE_SHA}"');
    expect(pr.jobs["pages-artifact"].steps?.find((step) => step.uses === "./.github/actions/setup-workspace")?.with)
      .toMatchObject({ "setup-node": "false", "install-deps": "false", "workspace-artifact": "restore" });
    expect([pr.jobs.prepare.outputs?.pages_critical_css_full_pass, pr.jobs.prepare.outputs?.pages_og_render_check])
      .toEqual(["${{ steps.classify.outputs.pages_critical_css_full_pass }}", undefined]);
    expect(pr.jobs["pages-artifact"].steps?.find((step) => step.env?.PR_LANE_ID === "pages-artifact")?.env).toMatchObject({
      PHAROS_CRITICAL_CSS_FULL_PASS: "${{ needs.prepare.outputs.pages_critical_css_full_pass }}",
      PHAROS_OG_RENDER_CHECK: "false", PHAROS_PAGES_REUSE_PREPARED_WORKSPACE: "1",
    });
  });

  it("confines the timing-acquisition token and scopes the nightly-red issue writer", () => {
    const prepare = (readWorkflow("pull-request-checks.yml") as Workflow).jobs.prepare;
    expect(prepare.permissions).toEqual({ contents: "read", actions: "read" });
    const prepareSteps = prepare.steps ?? [];
    const tokenSteps = prepareSteps.filter((step) => step.env?.GH_TOKEN !== undefined);
    expect(tokenSteps.map((step) => step.id)).toEqual(["test-timings"]);
    expect(tokenSteps[0]?.run).not.toMatch(/\b(npm|npx|node)\b/);
    const checkout = prepareSteps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const acquire = prepareSteps.findIndex((step) => step.id === "test-timings");
    const setup = prepareSteps.findIndex((step) => step.uses === "./.github/actions/setup-workspace");
    expect(acquire).toBe(checkout + 1);
    expect(acquire).toBeLessThan(setup);
    expect([prepareSteps[acquire]["timeout-minutes"], prepareSteps[acquire]["continue-on-error"], prepareSteps[acquire].if]).toEqual([2, true, undefined]);

    const nightly = readWorkflow("nightly-validation.yml") as Workflow;
    const red = nightly.jobs["nightly-red"];
    expect(red.permissions).toEqual({ contents: "read", issues: "write" });
    expect(red.if).toContain("refs/heads/main");
    expect(red.steps?.every((step) => step.uses === undefined)).toBe(true);
    expect(nightly.jobs["test-timings"].steps?.find((step) => step.name === "Merge the shard timing reports")?.["continue-on-error"]).toBe(true);
  });

  it("wires the main-only static test-plan parity canary into the nightly red set", () => {
    const nightly = readWorkflow("nightly-validation.yml") as Workflow;
    const job = nightly.jobs["test-plan-parity"];
    expect([job.if, job.needs, job["timeout-minutes"]]).toEqual(["${{ github.ref == 'refs/heads/main' }}", undefined, 30]);
    expect(job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    expect(job.steps?.find((step) => step.uses === "$/.github/actions/setup-workspace")?.with).toMatchObject({ "node-modules-cache": "true", "bootstrap-history": "true" });
    expect(job.steps?.filter((step) => step.run).map((step) => step.run)).toEqual(["npm run check:test-plan-parity -- --commits=5"]);
    const red = nightly.jobs["nightly-red"];
    expect(red.needs).toContain("test-plan-parity");
    expect(red.env?.TEST_PLAN_PARITY_RESULT).toBe("${{ needs.test-plan-parity.result }}");
  });

  it("keeps a nightly shuffled isolated run of the classified worker-shared files", () => {
    const nightly = readWorkflow("nightly-validation.yml") as Workflow;
    const job = nightly.jobs["worker-shared-stability"];
    expect([job.needs, job["timeout-minutes"]]).toEqual([undefined, 30]);
    expect(job.steps?.filter((step) => step.run).map((step) => step.run)).toEqual([
      "npm test -- --project worker-shared --sequence.shuffle --sequence.seed=${{ github.run_id }}",
      "npm test -- --project worker-shared --isolate",
    ]);
    const red = nightly.jobs["nightly-red"];
    expect(red.needs).toContain("worker-shared-stability");
    expect(red.env?.WORKER_SHARED_STABILITY_RESULT).toBe("${{ needs.worker-shared-stability.result }}");
  });

  it("loads the weekly dependency gate from the audit library", () => {
    const weekly = readWorkflow("weekly-validation.yml") as Workflow;
    expect(weekly.jobs["dependency-coverage"].steps?.find((step) => step.name === "Evaluate published dependency structure")?.run)
      .toContain('from "./scripts/lib/dependency-coverage-audit.ts"');
  });

  it("publishes the weekly CI report from a main-only workflow-fed job", () => {
    const weekly = readWorkflow("weekly-validation.yml") as Workflow;
    const job = weekly.jobs["ci-report"];
    expect([job.if, job.permissions, job.needs]).toEqual(["${{ github.ref == 'refs/heads/main' }}", { contents: "read", actions: "read", issues: "write" }, undefined]);
    for (const [name, definition] of Object.entries(weekly.jobs)) {
      if (name !== "ci-report") expect(definition.needs ?? [], name).not.toContain("ci-report");
    }

    const steps = job.steps ?? [];
    const tokenSteps = steps.filter((step) => step.env?.GH_TOKEN !== undefined);
    expect(tokenSteps.map((step) => step.id)).toEqual(["window", "timings", "issues", "publish"]);
    for (const step of tokenSteps) expect(step.run ?? "").not.toMatch(/\b(npm|npx)\b/);
    const render = steps.find((step) => step.name === "Render the weekly report");
    expect(render?.env?.GH_TOKEN).toBeUndefined();
    expect(render?.run).toContain("scripts/maintenance/report-ci-weekly.ts");
    expect(render?.run).toContain("--issues .tmp/ci-weekly/issues.json");
    expect(steps.find((step) => step.id === "timings")?.["continue-on-error"]).toBe(true);
    const issues = steps.find((step) => step.id === "issues");
    expect(issues?.["continue-on-error"]).toBe(true);
    expect(issues?.env?.GH_TOKEN).toBe("${{ github.token }}");
    for (const frag of ["gh api --paginate", "select(.pull_request == null)", "unique_by(.number)", ".tmp/ci-weekly/issues.json", 'capture("(?m)^Due:']) expect(issues?.run).toContain(frag);
    const install = steps.find((step) => step.name === "Install route Markdown parser dependencies");
    expect(install?.run).toContain("timeout --kill-after=5s 90s npm ci --omit=dev --ignore-scripts");
    expect(install?.["continue-on-error"]).toBe(true);
    expect(render?.env?.ROUTE_PARSER_INSTALL_OUTCOME).toBe(`\${{ steps.${install?.id}.outcome }}`);
    expect(steps.some((step) => step.uses === "$/.github/actions/setup-workspace")).toBe(false);
    const publish = steps.find((step) => step.id === "publish")?.run ?? "";
    const titles = [...publish.matchAll(/(?:--title|select\(\.title ==) "([^"]+)"/g)].map((match) => match[1]);
    expect(titles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(titles)).toEqual(new Set(["Weekly CI report"]));
    expect(publish).toContain("ci:weekly-report");
    expect(publish).not.toContain("gh issue comment");
  });

  it("withholds the added-test census when either of two reachable shallow roots is in the window", () => {
    const weekly = parseYaml(readRepoFile(".github/workflows/weekly-validation.yml")) as Workflow;
    const census = weekly.jobs["ci-report"].steps?.find((step) => step.name === "Collect the test files added in the window")?.run;
    expect(census).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "pharos-weekly-census-"));
    const log = join(root, ".tmp/ci-weekly/added-tests.log");
    const env = { ...process.env, RUNNER_TEMP: root };
    const bash = (script: string, since?: string) => {
      const result = spawnSync("bash", ["-e", "-c", script], { cwd: root, env: { ...env, SINCE: since }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      bash(`
        git init -q
        git config user.name Test
        git config user.email test@example.invalid
        mkdir -p .tmp/ci-weekly
        touch existing.test.ts
        git add existing.test.ts
        tree=$(git write-tree)
        commit() {
          local day="$1"
          shift
          GIT_AUTHOR_DATE="2026-11-$day 00:00:00 +0000" GIT_COMMITTER_DATE="2026-11-$day 00:00:00 +0000" git commit-tree "$@" -m fixture
        }
        base=$(commit 06 "$tree")
        old=$(commit 07 "$tree" -p "$base")
        recent=$(commit 09 "$tree" -p "$base")
        touch added.test.ts
        git add added.test.ts
        git update-ref refs/remotes/origin/main "$(commit 10 "$(git write-tree)" -p "$old" -p "$recent")"
        printf '%s\\n' "$old" "$recent" > .git/shallow
      `);
      // The fixture already represents the fetch result. Everything after fetching uses real Git.
      const collect = `git() { if [[ "$1" != fetch ]]; then command git "$@"; fi; }\n${census}`;
      bash(collect, "2026-11-10T00:00:00Z");
      expect(readFileSync(log, "utf8")).toMatch(/\nadded\.test\.ts\n$/);
      for (const since of ["2026-11-07T00:00:00Z", "2026-11-09T00:00:00Z"]) {
        writeFileSync(log, "stale census");
        expect(bash(collect, since)).toContain("Shallow boundary inside the window");
        expect(existsSync(log)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens the nightly-red issue on the first red run and never closes it on cancellation", () => {
    const nightly = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml")) as Workflow;
    const script = nightly.jobs["nightly-red"].steps?.find((step) => step.name === "Upsert the nightly-red issue")?.run;
    expect(script).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "pharos-nightly-red-"));
    const log = join(root, "gh.log");
    const gh = join(root, "gh");
    writeFileSync(gh, [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'if [[ "$1" == "issue" && "$2" == "list" && -n "${OPEN_ISSUE:-}" ]]; then printf "%s\\n" "$OPEN_ISSUE"; fi',
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
    const base: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, GH_LOG: log, RUNNER_TEMP: root,
      RUN_URL: "https://example.test/run/1", FULL_STATIC_RESULT: "success", FULL_TESTS_RESULT: "success",
      SAFETY_MAP_RENDER_RESULT: "success", V9_RESOURCE_RESULT: "success", V9_MONOTONICITY_RESULT: "success", LIGHTHOUSE_RESULT: "success",
      WEB_VITALS_RESULT: "skipped", TEST_TIMINGS_RESULT: "success", TEST_PLAN_PARITY_RESULT: "success",
      WORKER_SHARED_STABILITY_RESULT: "success",
    };
    const run = (overrides: Partial<NodeJS.ProcessEnv>): string => {
      writeFileSync(log, "");
      const result = spawnSync("bash", ["-c", script!], { env: { ...base, ...overrides }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(log, "utf8");
    };
    try {
      const red = run({ FULL_TESTS_RESULT: "failure" });
      expect(red).toContain("issue create --title Nightly validation is red");
      expect(red).not.toContain("issue close");
      const cancelled = run({ FULL_TESTS_RESULT: "cancelled", OPEN_ISSUE: "7" });
      expect(cancelled).not.toContain("issue close");
      expect(cancelled).not.toContain("issue create");
      expect(cancelled).not.toContain("issue comment");
      expect(cancelled).not.toContain("label create");
      const green = run({ OPEN_ISSUE: "7" });
      expect(green).toContain("issue close 7");
      expect(green).not.toContain("issue create");
      // Any non-success/skipped leaf (e.g. a tool failure) keeps it open.
      const failed = run({ OPEN_ISSUE: "7", SAFETY_MAP_RENDER_RESULT: "failure" });
      expect(failed).toContain("issue comment 7");
      expect(failed).not.toContain("issue close");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans ops:followup, ops:calendar, and ops:upstream-wait in ops-followups with dedup", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/ops-followups.yml")) as Workflow;
    expect(workflow.permissions).toEqual({ issues: "write" });
    const step = workflow.jobs.remind.steps?.[0];
    expect(step?.run).toContain("ops:followup ops:calendar ops:upstream-wait");
    expect(step?.run).toContain("unique_by(.number)");
    expect(step?.run).toContain("<!-- ops-followup-overdue -->");
    const root = mkdtempSync(join(tmpdir(), "pharos-ops-followups-"));
    const log = join(root, "gh.log"), gh = join(root, "gh");
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeFileSync(join(root, "fixtures.json"), JSON.stringify({
      "ops:followup": [
        { number: 11, body: "Due: 2020-01-01\nCheck: dual", comments: [] },
        { number: 12, body: "Due: 2020-01-01", comments: [{ body: "<!-- ops-followup-overdue -->", createdAt: now }] },
      ],
      "ops:calendar": [
        { number: 11, body: "Due: 2020-01-01\nCheck: dual", comments: [] },
        { number: 13, body: "Due: 2099-01-01", comments: [] },
      ],
      "ops:upstream-wait": [{ number: 14, body: "Due: 2020-01-02", comments: [] }],
    }));
    writeFileSync(gh, [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "issue" && "$2" == "list" ]]; then jq -c --arg l "$4" \'.[$l] // []\' "$FIXTURES"; exit 0; fi',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      "",
    ].join("\n"), { mode: 0o755 });
    try {
      const result = spawnSync("bash", ["-c", step!.run!], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, GH_LOG: log, FIXTURES: join(root, "fixtures.json") },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const commented = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("issue comment "));
      expect(commented.map((l) => l.split(" ")[2])).toEqual(["11", "14"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

it("snapshots trusted base code and policy before PR checkout and scans both modes afterward", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml"));
  const steps = workflow.jobs.secrets.steps;
  const checkouts = steps.filter((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  expect(checkouts[0].with.ref).toBe("${{ github.event.pull_request.base.sha }}");
  const snapshot = steps.findIndex((step: { run?: string }) => step.run?.includes('--snapshot-trusted="$RUNNER_TEMP/trusted-gitleaks"'));
  const scanner = steps.findIndex((step: { run?: string }) => step.run?.includes('run-gitleaks.ts" --range --tree --policy-root='));
  expect(snapshot).toBeGreaterThan(steps.indexOf(checkouts[0]));
  expect(snapshot).toBeLessThan(steps.indexOf(checkouts[1]));
  expect(scanner).toBeGreaterThan(steps.indexOf(checkouts[1]));
  expect(steps[scanner].run).toContain('git fetch --no-tags origin "${GITLEAKS_HEAD_REF}"');
  // The trusted snapshot checkout is shallow; the range scan must restore full history.
  expect(steps[scanner].run).toContain("git fetch --no-tags --unshallow origin");
  expect(steps[scanner].run).toContain('git cat-file -e "${GITLEAKS_BASE_REF}^{commit}"');
  expect(steps[scanner].env.GITLEAKS_HEAD_REF).toBe("${{ github.event.pull_request.head.sha }}");
});

it("scans PR merge-resolution lines for the full PR range including historical merges", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml"));
  const steps = workflow.jobs.secrets.steps;
  const trustedScans = steps.filter((step: { run?: string }) => step.run?.includes('run-gitleaks.ts" --range --tree'));
  expect(trustedScans).toHaveLength(1);
  const tree = steps.indexOf(trustedScans[0]);
  expect(steps[tree].env.GITLEAKS_BASE_REF).toBe("${{ github.event.pull_request.base.sha }}");
  expect(steps[tree].env.GITLEAKS_HEAD_REF).toBe("${{ github.event.pull_request.head.sha }}");
  expect(steps[tree].run).toContain('--policy-root="$RUNNER_TEMP/trusted-gitleaks"');
  const candidate = steps.find((step: { run?: string }) => step.run?.includes("--candidate-policy"));
  expect(candidate.run).toContain('--trusted-root="$RUNNER_TEMP/trusted-gitleaks"');
  expect(steps.indexOf(candidate)).toBeGreaterThan(tree);
});

it("admits hosted protocol mechanism refresh only for explicit Falcon dispatches on main", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/protocol-api-mechanism-refresh.yml"));
  expect(workflow.on).toEqual({ workflow_dispatch: { inputs: { asset: {
    description: "Protocol API asset to capture", required: true, type: "choice", options: ["usdf-falcon"],
  } } } });
  expect(workflow.jobs.refresh.if).toBe("${{ github.ref == 'refs/heads/main' }}");
  expect(workflow.jobs.refresh.strategy.matrix).toEqual({ asset: ["${{ inputs.asset }}"] });
  expect(workflow.jobs.refresh.steps[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  expect(workflow.jobs.refresh.steps[0].with["persist-credentials"]).toBe(false);
  expect(workflow.jobs.refresh.steps.some(
    (step: { uses?: string }) => step.uses === "$/.github/actions/setup-workspace",
  )).toBe(true);
});

it("runs the mechanism-refresh verifier only from a trusted snapshot inside the token step", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/protocol-api-mechanism-refresh.yml"));
  const steps = workflow.jobs.refresh.steps as Array<{ name?: string; env?: Record<string, string>; run?: string }>;
  const tokenStep = steps.find((step) => step.env?.GH_TOKEN?.includes("MECHANISM_REFRESH_GITHUB_TOKEN"));
  expect(tokenStep).toBeDefined();
  const run = tokenStep!.run!;
  const snapshot = run.indexOf("node_modules/.bin/esbuild scripts/ci/verify-mechanism-refresh-diff.ts");
  const prepareBranch = run.indexOf("--stage prepare-branch");
  expect(snapshot).toBeGreaterThanOrEqual(0);
  expect(snapshot).toBeLessThan(prepareBranch);
  expect(run).toContain("--bundle --platform=node --format=esm --external:playwright");
  for (const line of run.split("\n")) {
    if (!line.includes("verify-mechanism-refresh-diff.ts") || line.includes("esbuild ")) continue;
    expect(line).toContain("$TRUSTED_VERIFIER/");
  }
  expect(run).toContain('--outfile="$TRUSTED_VERIFIER/scripts/ci/verify-mechanism-refresh-diff.ts"');
});

it("scopes protocol archive read credentials to trusted capture and strict replay only", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/protocol-api-mechanism-refresh.yml"));
  const steps = workflow.jobs.refresh.steps as Array<{ name?: string; env?: Record<string, string> }>;
  expect(workflow.jobs.refresh.env).toBeUndefined();
  const archiveSteps = steps.filter((step) => step.env?.R2_MEASUREMENTS_ACCESS_KEY_ID !== undefined);
  expect(archiveSteps.map((step) => step.name)).toEqual([
    "Capture protocol API mechanism evidence", "Replay all protocol API evidence",
  ]);
  for (const step of archiveSteps) {
    expect(step.env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    expect(step.env?.R2_MEASUREMENTS_ACCESS_KEY_ID).toBe("${{ secrets.R2_MEASUREMENTS_ACCESS_KEY_ID }}");
    expect(step.env?.R2_MEASUREMENTS_SECRET_ACCESS_KEY).toBe("${{ secrets.R2_MEASUREMENTS_SECRET_ACCESS_KEY }}");
    expect(step.env?.GH_TOKEN).toBeUndefined();
  }
});

describe("external scheduler delivery monitor", () => {
  const makeLiveness = (now: number, overrides: Record<string, unknown> = {}) => ({
    status: "healthy", observedAt: now, lastAnyStartedAt: now - 30, lastFiveMinuteStartedAt: now - 30,
    ageSeconds: 30, warningAfterSec: 600, staleAfterSec: 1200,
    lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({ scheduleKey, lastStartedAt: now - 30 })),
    heavy: { status: "healthy", scheduleKey: ["v9", "SupplyAttributionOffset"].join(""), lastStartedAt: now - 30, ageSeconds: 30, warningAfterSec: 1800, staleAfterSec: 2700, unavailableReason: null },
    expectedLanes: ["statusSelfCheckOffset", "daily0300Utc"].map((scheduleKey) => ({
      scheduleKey, lastStartedAt: now - 30, ageSeconds: 30,
      warningAfterSec: scheduleKey === "statusSelfCheckOffset" ? 1800 : 172_800,
      staleAfterSec: scheduleKey === "statusSelfCheckOffset" ? 2700 : 259_200,
      status: "healthy", unavailableReason: null,
    })),
    ...overrides,
  });
  const healthyLane = (now: number) => ({ scheduleKey: "statusSelfCheckOffset", lastStartedAt: now - 30, ageSeconds: 30, warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null });
  function runMonitor(overrides: Record<string, unknown> = {}) {
    const workflow = parseYaml(readRepoFile(".github/workflows/cron-liveness.yml"));
    const run = workflow.jobs.delivery.steps.find((step: { id?: string }) => step.id === "health").run as string;
    const script = run.split("<<'NODE'\n")[1].split("\nNODE")[0];
    const now = Math.floor(Date.now() / 1000);
    const health = {
      status: "healthy", timestamp: now, warnings: [],
      schedulerLiveness: makeLiveness(now),
      operatorAlerts: {
        status: "healthy", operatorConfigured: true, lastDeliveredAt: now - 600,
        pendingSince: null, pendingAgeSec: null, maxPendingSec: 86_400,
        pendingProducers: [], reason: null, unavailableReason: null,
      },
      ...overrides,
    };
    return spawnSync(process.execPath, ["-e",
      `require('node:fs').readFileSync = () => process.argv[1];\n${script}`, JSON.stringify(health)], { encoding: "utf8" });
  }
  it("accepts healthy delivery from both roles", () => {
    expect(runMonitor().status).toBe(0);
  });
  it.each(["heavy_scheduled_delivery_stalled", "heavy_scheduler_liveness_unavailable"])(
    "fails on %s even if both role status fields claim healthy", (warning) => {
      expect(runMonitor({ warnings: [warning] }).status).toBe(1);
    },
  );
  it.each(["degraded", "stale", "unavailable"])("fails on a non-healthy heavy status (%s)", (status) => {
    const now = Math.floor(Date.now() / 1000);
    expect(runMonitor({ schedulerLiveness: makeLiveness(now, {
      lastAnyStartedAt: undefined, lastFiveMinuteStartedAt: undefined, ageSeconds: undefined,
      heavy: { status, scheduleKey: ["v9", "SupplyAttributionOffset"].join(""), warningAfterSec: 1800, staleAfterSec: 2700 },
      expectedLanes: [healthyLane(now)],
    }) }).status).toBe(1);
  });
  it("fails on an aged registry lane or a stale operator channel", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(runMonitor({ schedulerLiveness: makeLiveness(now, { expectedLanes: [healthyLane(now), { scheduleKey: "daily0300Utc", lastStartedAt: now - 259_201, ageSeconds: 259_201, warningAfterSec: 172_800, staleAfterSec: 259_200, status: "stale", unavailableReason: null }] }) }).status).toBe(1);
    expect(runMonitor({ operatorAlerts: { status: "stale", operatorConfigured: false, lastDeliveredAt: null, pendingSince: now - 86_401, pendingAgeSec: 86_401, maxPendingSec: 86_400, pendingProducers: ["freshness"], reason: "operator-alert-delivery-pending", unavailableReason: null } }).status).toBe(1);
  });
  it("warns on a degraded lane inside its stale budget instead of opening an incident", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = runMonitor({ schedulerLiveness: makeLiveness(now, {
      expectedLanes: [
        healthyLane(now),
        { scheduleKey: "fiveMinuteTelegramAlerts", lastStartedAt: now - 601, ageSeconds: 601, warningAfterSec: 600, staleAfterSec: 900, status: "degraded", unavailableReason: null },
      ],
    }) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Scheduled lane delivery degraded");
  });
  it("treats an absent operator receipt as unknown instead of opening an incident", () => {
    const result = runMonitor({ operatorAlerts: undefined });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Operator alert receipt absent");
  });
  it("closes the delivery incident on a passing run", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/cron-liveness.yml"));
    const steps = workflow.jobs.delivery.steps as WorkflowStep[];
    const close = steps.find((step) => step.name === "Close recovered delivery incident");
    expect(close?.if).toBe("steps.health.outcome == 'success'");
    expect(close?.run).toContain("gh issue close");
  });
});

describe("Cloudflare deployment credential scope", () => {
  type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string; "continue-on-error"?: boolean; env?: Record<string, string> };
  const credentialKeys = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;
  const consumerSteps = (workflowPath: string, jobName: string) => {
    const workflow = parseYaml(readRepoFile(workflowPath));
    const job = workflow.jobs[jobName] as { env?: Record<string, string>; steps: Step[] };
    // Effective step environment = workflow env + job env + step env.
    const effective = job.steps.map((step) => ({
      step,
      env: { ...(workflow.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) } as Record<string, string>,
    }));
    return {
      job,
      holders: effective
        .filter(({ env }) => credentialKeys.some((key) => env[key] !== undefined))
        .map(({ step }) => step.name),
      effective,
    };
  };

  it.each([
    ["deploy-worker", ".github/workflows/deploy-cloudflare.yml", ["Run read-only Worker preflights before D1 mutation", "Apply production D1 migrations", "Deploy heavy Worker", "Verify active heavy Worker deployment", "Deploy public Worker", "Verify active public Worker deployment", "Record verified Worker activation markers"]],
    ["pages-release", ".github/workflows/pages-release.yml", ["Publish immutable preview objects before Pages activation", "Deploy Pages", "Resolve active Pages deployment"]],
    ["monitor", ".github/workflows/post-deploy-first-execution.yml", ["Read Cloudflare deployments and cron evidence"]],
  ])("%s exposes credentials only to named consumer steps", (jobName, path, consumers) => {
    const { job, holders, effective } = consumerSteps(path, jobName);
    for (const key of credentialKeys) expect(job.env?.[key]).toBeUndefined();
    expect(holders).toEqual(consumers);
    for (const { env, step } of effective) {
      if (!consumers.includes(step.name ?? "")) continue;
      expect([env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]).toEqual(["${{ secrets.CLOUDFLARE_API_TOKEN }}", "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"]);
    }
  });

  it("gates post-deploy first-execution monitor on main and confines its tokens", () => {
    const workflow = readWorkflow("post-deploy-first-execution.yml") as Workflow;
    const job = workflow.jobs.monitor;
    const steps = job.steps ?? [];
    expect([workflow.permissions, job.if, job.permissions]).toEqual([
      { contents: "read" }, "${{ github.ref == 'refs/heads/main' }}", { contents: "read", issues: "write" },
    ]);
    expect(steps.filter((s) => s.env?.GH_TOKEN !== undefined).map((s) => s.id)).toEqual(["open-issue", "issue"]);
    expect(steps.filter((s) => s.env?.PHAROS_API_KEY !== undefined).map((s) => s.id)).toEqual(["stablecoins"]);
    expect(steps.find((s) => s.id === "evaluate")?.env).toBeUndefined();
    expect(steps.some((s) => s.run === "npm ci --ignore-scripts")).toBe(true);
  });

  it("separates Pages build secrets and confines preview S3 credentials to the execution publisher", () => {
    const { job, effective } = consumerSteps(".github/workflows/pages-release.yml", "pages-release");
    expect(job.env?.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY).toBe("true");
    expect(job.env?.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK).toBe("${{ vars.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK }}");
    expect(job.env?.NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBe("${{ vars.NEXT_PUBLIC_TURNSTILE_SITE_KEY }}");
    const pr = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml")).jobs["pages-artifact"];
    for (const key of ["NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"]) {
      expect(pr.env?.[key]).toBe(job.env?.[key]);
    }
    const build = effective.find(({ step }) => step.name === "Build clean production export");
    expect(build?.env.SITE_API_SHARED_SECRET).toBe("${{ secrets.SITE_API_SHARED_SECRET }}");
    expect(build?.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    const guard = effective.find(({ step }) => step.name === "Reject signing key in exported site");
    expect(guard?.env.SITE_SESSION_SIGNING_KEY).toBe("${{ secrets.SITE_SESSION_SIGNING_KEY }}");
    expect(guard?.step.run).toContain('grep -rqF -- "$SITE_SESSION_SIGNING_KEY" out');
    expect(guard?.step.run).toContain('[ -n "$SITE_SESSION_SIGNING_KEY" ]');
    expect(effective.indexOf(guard!)).toBe(effective.indexOf(build!) + 1);
    const archiveGuard = effective.find(({ step }) => step.name === "Reject secrets in retained release data");
    expect(archiveGuard?.step.run).toContain('[ -n "$secret" ] && grep -aqF -- "$secret" "$release_data_tar"');
    expect(effective[effective.indexOf(archiveGuard!) + 1]?.step.name).toBe("Retain post-refresh data for Pages PR and local replay");
    const marker = effective.find(({ step }) => step.name === "Verify deployment release marker");
    expect(marker?.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    const publisherName = "Publish immutable preview objects before Pages activation";
    const publisher = effective.find(({ step }) => step.name === publisherName);
    expect(publisher?.step.run).toBe("npm run publish:social-previews -- --out-dir out --execute");
    expect(publisher?.step.if).toBeUndefined();
    expect(publisher?.step["continue-on-error"]).toBeUndefined();
    const artifactGate = effective.find(({ step }) => step.name === "Validate Pages artifact gates (size, CSS integrity, flags, phishing, SEO/continuity)");
    const deploy = effective.find(({ step }) => step.name === "Deploy Pages");
    expect(artifactGate).toBeDefined();
    expect(effective.indexOf(publisher!)).toBeGreaterThan(effective.indexOf(artifactGate!));
    expect(effective.indexOf(publisher!)).toBeLessThan(effective.indexOf(deploy!));
    const s3CredentialKeys = ["R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID", "R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY"];
    for (const key of s3CredentialKeys) {
      expect(job.env?.[key]).toBeUndefined();
      expect(publisher?.env[key]).toBe(`\${{ secrets.${key} }}`);
      expect(effective.filter(({ step, env }) => JSON.stringify({ ...step, env }).includes(key)).map(({ step }) => step.name)).toEqual([publisherName]);
    }
    for (const path of [".github/workflows/pages-prepare.yml", ".github/workflows/pull-request-checks.yml", ".github/actions/setup-workspace/action.yml"]) {
      const source = readRepoFile(path);
      for (const key of s3CredentialKeys) expect(source).not.toContain(key);
    }
  });
});
