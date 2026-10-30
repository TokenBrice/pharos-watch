import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("CI workflow scope", () => {
  it("transports ignored compile/serve inputs without an unused Next cache branch", () => {
    const action = parseYaml(readRepoFile(".github/actions/setup-workspace/action.yml"));
    expect(action.inputs["next-cache"]).toBeUndefined();
    expect(action.inputs["next-cache-save"]).toBeUndefined();
    expect(action.runs.steps.some((step: { with?: { path?: string } }) => step.with?.path === ".next/cache"))
      .toBe(false);
    const packageStep = action.runs.steps.find((step: { name?: string }) => step.name === "Package required workspace");
    const paths = packageStep.env.WORKSPACE_PATHS.trim().split("\n");
    expect(paths).toEqual(expect.arrayContaining([
      "public/llms.txt", "src/lib/case-study-client-index.ts", "src/data/changelogs/index.ts",
    ]));
  });

  it("gates new stablecoin admissions once on the prepared workspace against the frozen base", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pull-request-checks.yml")) as {
      jobs: Record<string, { steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs.prepare.steps;
    const gate = steps.findIndex((step) => step.name === "Check new-asset evidence packet");
    // The receipt is bound to the post-addition registry fingerprint, so the
    // gate must run after npm ci + bootstrap:generated inside setup-workspace.
    expect(gate).toBeGreaterThan(steps.findIndex((step) => step.uses === "$/.github/actions/setup-workspace"));
    // One invocation per PR: restored validation shards never re-run the gate.
    expect(steps.filter((step) => step.run?.includes("check:new-asset-evidence-packet"))).toHaveLength(1);
    expect(steps[gate].env).toEqual({
      PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      NEW_ASSET_GATE_OVERRIDE: "${{ contains(github.event.pull_request.labels.*.name, 'new-asset-gate-override') }}",
    });
    // The owner label is the only path to `--override`; it never bypasses a
    // missing receipt or a counted mint-authority gap.
    expect(steps[gate].run?.match(/--override/g)).toHaveLength(1);
    expect(steps[gate].run)
      .toContain('if [[ "${NEW_ASSET_GATE_OVERRIDE}" == "true" ]]; then args+=(--override); fi');
  });

  it("feeds nightly Lighthouse trusted retained release data with a token confined to acquisition", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml")) as {
      jobs: Record<string, {
        if?: string;
        permissions?: Record<string, string>;
        env?: Record<string, string>;
        steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };
    const job = workflow.jobs.lighthouse;
    expect(job.if).toContain("refs/heads/main");
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(job.env?.GH_TOKEN).toBeUndefined();
    const acquire = job.steps.findIndex((step) => step.run?.includes("preparePagesReleaseData"));
    const build = job.steps.findIndex((step) => step.run === "npm run check:pages-artifact");
    expect(acquire).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(acquire);
    expect(job.steps[acquire].env?.GH_TOKEN).toBe("${{ github.token }}");
    const directory = job.steps[acquire].env?.PAGES_RELEASE_DATA_DIR;
    expect(directory).toContain("runner.temp");
    expect(job.steps[build].env?.PAGES_RELEASE_DATA_DIR).toBe(directory);
    for (const [index, step] of job.steps.entries()) {
      if (index !== acquire) expect(step.env?.GH_TOKEN).toBeUndefined();
      expect(step.run ?? "").not.toContain("acquireReleaseData:false");
    }
  });

  it("bootstraps full history before the blocking weekly critical coverage", () => {
    const weekly = parseYaml(readRepoFile(".github/workflows/weekly-validation.yml")) as {
      jobs: Record<string, {
        env?: Record<string, string>;
        steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const coverage = Object.values(weekly.jobs).find((job) =>
      job.steps.some((step) => step.run === "npm run coverage:critical"))!;
    expect(coverage.env?.CRITICAL_COVERAGE_RATCHET_ALL).toBe("1");
    const checkout = coverage.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const setup = coverage.steps.findIndex((step) => step.uses === "$/.github/actions/setup-workspace");
    const run = coverage.steps.findIndex((step) => step.run === "npm run coverage:critical");
    expect(setup).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(setup);
    expect(coverage.steps[setup].with?.["bootstrap-history"]).toBe("true");
  });

  it("installs each nightly Node 24 lane independently", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml")) as {
      jobs: Record<string, {
        needs?: string | string[];
        "continue-on-error"?: boolean;
        steps?: Array<{ uses?: string; run?: string; if?: string; id?: string; name?: string; env?: Record<string, string>; "continue-on-error"?: boolean; with?: Record<string, unknown> }>;
      }>;
    };
    // The workspace-artifact fan-out was measured across three paired
    // nightlies and lengthened the critical path (+104s median) while the npm
    // cache was already hot in every job, so each lane installs on its own.
    expect(workflow.jobs.prepare).toBeUndefined();
    for (const job of ["full-static", "full-tests"]) {
      const setup = workflow.jobs[job].steps?.find(
        (step) => step.uses === "$/.github/actions/setup-workspace");
      expect(workflow.jobs[job].needs).toBeUndefined();
      expect(setup?.with?.["workspace-artifact"]).toBeUndefined();
      expect(setup?.with?.["install-deps"]).toBeUndefined();
      expect(setup?.with?.["bootstrap-history"]).toBe("true");
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
    ]);
    // Every mandatory command runs independently once the workspace is ready,
    // so one red step cannot mask the remaining mandatory outcomes.
    for (const step of staticSteps) {
      if (!step.run?.startsWith("npm run ")) continue;
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.if).toContain("!cancelled()");
      expect(step.if).toContain("steps.workspace.outcome == 'success'");
    }
    for (const command of ["lint", "typecheck", "typecheck:worker"]) {
      expect(staticSteps.findIndex((step) => step.run === `npm run ${command}`)).toBeLessThan(save);
    }
    for (const command of ["lint:typed", "typecheck:tests", "check:structural", "check:unused-code", "check:sensitive-page-copy"]) {
      expect(staticSteps.findIndex((step) => step.run === `npm run ${command}`)).toBeGreaterThan(save);
    }
    // The cache publishes only fully validated lint and compiler state.
    expect(staticSteps[save]["continue-on-error"]).toBeUndefined();
    expect(staticSteps[save].if).toContain("!cancelled()");
    for (const command of ["lint", "typecheck", "typecheck:worker"]) {
      const id = staticSteps.find((step) => step.run === `npm run ${command}`)?.id;
      expect(id, `Missing step id for npm run ${command}`).toBeDefined();
      expect(staticSteps[save].if).toContain(`steps.${id}.outcome == 'success'`);
    }
    // The aggregate step reports every mandatory outcome and fails the job
    // naming each failed command, whatever their count.
    const aggregate = staticSteps.find((step) => step.name === "Report mandatory static outcomes");
    expect(aggregate).toBeDefined();
    expect(aggregate!.if).toContain("steps.workspace.outcome == 'success'");
    expect(staticSteps.indexOf(aggregate!)).toBeGreaterThan(
      staticSteps.findIndex((step) => step.run === "npm run check:structural"));
    const outcomeEnv = Object.entries(aggregate!.env ?? {});
    expect(outcomeEnv).toHaveLength(8);
    for (const failedExpression of [undefined, ...outcomeEnv.map(([, expression]) => expression)]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "" };
      for (const [key, expression] of outcomeEnv) {
        env[key] = expression === failedExpression ? "failure" : "success";
      }
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
    const nightly = parseYaml(readRepoFile(".github/workflows/nightly-validation.yml"));
    const weekly = parseYaml(readRepoFile(".github/workflows/weekly-validation.yml"));
    expect(nightly.jobs["node26-proof"]).toBeUndefined();
    const probe = weekly.jobs["node26-proof"];
    expect(probe["continue-on-error"]).toBe(true);
    expect(probe.needs).toBeUndefined();
    expect(probe.steps.find((step: { uses?: string }) =>
      step.uses === "$/.github/actions/setup-workspace").with).toMatchObject({
      "node-version": "26", "bootstrap-history": "true", "static-cache": "true",
    });
    expect(probe.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run))
      .toEqual(["npm run typecheck", "npm run typecheck:worker"]);
    expect(nightly.jobs["v9-resource"].if).toBeUndefined();
    expect(nightly.jobs["v9-resource"].steps.filter((step: { run?: string }) =>
      step.run === "npm run test:v9-resource")).toHaveLength(1);
    expect(weekly.jobs["v9-resource"]).toBeUndefined();
    expect(readRepoFile(".github/workflows/weekly-validation.yml")).not.toContain("npm run test:v9-resource");
    expect(nightly.jobs["full-tests"].steps.some((step: { run?: string }) =>
      step.run === "npm test -- --shard=${{ matrix.shard }}/2")).toBe(true);
  });

  it("runs CodeQL weekly on Monday and manual dispatch, not pushes", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/codeql.yml"));
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
  });

  it("restricts auxiliary production publishers to main for manual and scheduled runs", () => {
    const scenarios = parseYaml(readRepoFile(".github/workflows/dependency-scenarios-refresh.yml"));
    const map = parseYaml(readRepoFile(".github/workflows/safety-map-refresh.yml"));
    for (const workflow of [scenarios, map]) {
      expect(workflow.on).toHaveProperty("workflow_dispatch");
      expect(workflow.on.schedule.length).toBeGreaterThan(0);
    }
    // Main-only, without an event restriction: main dispatches and schedules
    // remain admitted, while feature-branch dispatches cannot get credentials.
    for (const job of [scenarios.jobs.scenarios, map.jobs.plan]) {
      expect(job.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    }
    expect(scenarios.on.schedule).toEqual([{ cron: "17 2 * * *" }]);
    expect(Object.keys(map.jobs)).toEqual(["plan"]);
    const steps = map.jobs.plan.steps as Array<{
      name?: string; id?: string; if?: string; uses?: string; run?: string;
      with?: Record<string, string>; env?: Record<string, string>;
    }>;
    expect(steps.filter((step) => step.uses?.startsWith("actions/checkout@"))).toHaveLength(1);
    expect(steps.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(false);
    const setups = steps.filter((step) => step.uses === "$/.github/actions/setup-workspace");
    expect(setups).toHaveLength(2);
    expect(setups[0].if).toBeUndefined();
    expect(setups[0].with).toMatchObject({
      "browser-cache": "false", "bootstrap-generated": "false", "install-playwright-firefox": "false",
    });
    expect(setups[1].if).toBe("${{ steps.plan.outputs.should_render == 'true' }}");
    expect(setups[1].with).toMatchObject({
      "install-deps": "false", "browser-cache": "true", "install-playwright-firefox": "true",
    });
    const planIndex = steps.findIndex((step) => step.id === "plan");
    expect(steps.indexOf(setups[1])).toBeGreaterThan(planIndex);
    for (const name of [
      "Bootstrap render inputs", "Verify render credentials", "Render and validate publication files",
      "Upload the rendered map", "Publish in commit-marker order and verify readback",
    ]) {
      expect(steps.find((step) => step.name === name)?.if)
        .toBe("${{ steps.plan.outputs.should_render == 'true' }}");
    }
    for (const phase of ["render", "publish"]) {
      const step = steps.find((step) => step.run?.includes(`publish-safety-score-map.ts ${phase}`));
      expect(step?.env?.PLAN_TOKEN).toBe("${{ steps.plan.outputs.plan_token }}");
      expect(step?.run).toContain('--plan-token="${PLAN_TOKEN}"');
    }
    const summaries = steps.filter((step) => step.run?.includes("publish-safety-score-map.ts summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].if).toBe("${{ always() && steps.plan.outcome == 'success' }}");
    expect(steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))).toHaveLength(1);
    expect(steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.path)
      .toContain("${{ env.MAP_OUT_DIR }}/latest.webp");
  });

  it("replays scenarios under the resolved compatible evaluator checkout without credentials", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/dependency-scenarios-refresh.yml"));
    const steps = workflow.jobs.scenarios.steps as Array<{
      name?: string; id?: string; uses?: string; run?: string; "working-directory"?: string;
      with?: Record<string, string>; env?: Record<string, string>;
    }>;
    const index = (predicate: (step: (typeof steps)[number]) => boolean) => {
      const found = steps.findIndex(predicate);
      expect(found).toBeGreaterThan(-1);
      return found;
    };
    // Full first-parent ancestry; the resolver refuses a shallow history.
    expect(steps[0].with).toMatchObject({ "persist-credentials": false, "fetch-depth": 0 });
    const plan = index((step) => step.run?.includes("--mode plan") === true);
    const resolveSource = index((step) => step.id === "source");
    expect(steps[resolveSource].run).toContain("--mode resolve-source");
    expect(steps[resolveSource].env).toEqual({ TRUSTED_REF: "${{ github.sha }}" });
    const checkout = index((step) => step.run?.includes("git worktree add --detach") === true);
    expect(steps[checkout].env).toEqual({ COMMIT_SHA: "${{ steps.source.outputs.commit_sha }}" });
    const setups = steps.filter((step) => step.uses?.startsWith("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"));
    expect(setups.map((step) => step.with?.["node-version-file"])).toEqual(["${{ env.EVALUATOR_DIR }}/.nvmrc", ".nvmrc"]);
    const historicalNode = steps.indexOf(setups[0]!), currentNode = steps.indexOf(setups[1]!);
    const install = index((step) => step.run?.includes("npm ci") === true && step["working-directory"] === "${{ env.EVALUATOR_DIR }}");
    expect(steps[install].run).toContain("npm run generate:safety-score-v9-evaluation-build -- --check");
    expect(steps[install].run).toContain("git diff --exit-code");
    const historical = index((step) => step.run?.includes("--accepted-cache-export") === true);
    expect(steps[historical]["working-directory"]).toBe("${{ env.EVALUATOR_DIR }}");
    expect(steps[historical].run).toContain("--mode compute");
    const publish = index((step) => step.run?.includes("--mode publish") === true);
    expect([plan, resolveSource, checkout, historicalNode, install, historical, currentNode, publish])
      .toEqual([...[plan, resolveSource, checkout, historicalNode, install, historical, currentNode, publish]].sort((a, b) => a - b));
    // Secrets reach only the current-code plan and publish steps.
    for (const [position, step] of steps.entries()) {
      const secretBearing = JSON.stringify(step).includes("secrets.");
      expect(secretBearing, step.name ?? step.uses).toBe(position === plan || position === publish);
    }
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with?.path.trim().split("\n")).toEqual([
      "${{ env.SCENARIO_OUT_DIR }}/artifact.json",
      "${{ env.SCENARIO_OUT_DIR }}/artifact.verified.sha256",
      "${{ env.SCENARIO_OUT_DIR }}/source.json",
    ]);
  });

  it("checks public live cache policy independently of secret-bearing account evidence", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/production-canaries.yml"));
    const step = workflow.jobs.transport.steps.find((entry: { run?: string }) =>
      entry.run === "node scripts/ci/check-live-api-cache-policy.mjs");
    expect(step).toBeDefined();
    expect(step.if).toBe("${{ !cancelled() }}");
    expect(step.env).toBeUndefined();
    expect(workflow.jobs.transport.env).toBeUndefined();
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
  });

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
    const build = steps.findIndex((step) => step.run?.split("\n").includes("npm run generated:post-refresh"));
    const check = steps.findIndex((step) => step.run === "npm run check:pages-release");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(restore);
    expect(build).toBeGreaterThan(refresh);
    expect(check).toBeGreaterThan(build);
    expect(steps[build].env?.PHAROS_RELEASE_PR_TYPECHECKED).toBe("1");
    expect(steps[build].env?.PHAROS_DETAIL_SNAPSHOT_SOURCE).toBe("bulk");
    expect(steps[build].env?.SITE_API_SHARED_SECRET).toBe("${{ secrets.SITE_API_SHARED_SECRET }}");
    expect(steps[build].run).toContain('if [ -z "${SITE_API_SHARED_SECRET//[[:space:]]/}" ]; then');
    expect(steps[build].run?.indexOf("exit 1")).toBeLessThan(steps[build].run!.indexOf("npm run generated:post-refresh"));
    expect(steps.filter((step) => step.env?.SITE_API_SHARED_SECRET != null)).toHaveLength(1);
  });

  it.each(["deploy-cloudflare.yml", "pages-release.yml", "rebuild-pages.yml", "pages-prepare.yml"])(
    "never enables the PR snapshot replay age waiver in %s", (workflow) => {
      expect(readRepoFile(`.github/workflows/${workflow}`)).not.toContain("PHAROS_PAGES_REPLAY");
    },
  );

  it("rejects absent bulk credentials before running release generators", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pages-release.yml"));
    const build = workflow.jobs["pages-release"].steps.find(
      (step: { name?: string }) => step.name === "Build clean production export",
    );
    const credentialGate = build.run.slice(0, build.run.indexOf("npm run generated:post-refresh"));
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
    const deploy = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml"));
    const rebuild = parseYaml(readRepoFile(".github/workflows/rebuild-pages.yml"));
    const prepare = parseYaml(readRepoFile(".github/workflows/pages-prepare.yml"));
    const release = parseYaml(readRepoFile(".github/workflows/pages-release.yml"));
    const artifactName = "pages-workspace-production-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}";
    const steps = prepare.jobs["pages-prepare"].steps as Array<{
      id?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>;
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
    expect(rebuild.jobs["pages-release"].with.refresh_data).toBeUndefined();
    expect(deploy.jobs["pages-release"].with.refresh_data).toBeUndefined();
    expect(release.on.workflow_call.inputs.refresh_data).toBeUndefined();
    const releaseSteps = release.jobs["pages-release"].steps as Array<{
      name?: string; if?: string; run?: string;
    }>;
    const refresh = releaseSteps.find((step) => step.name === "Refresh API-backed release data")!;
    expect(refresh.if).toBeUndefined();
    expect(refresh.run).toBe("node --import tsx scripts/maintenance/refresh-pages-release-data.ts");
    expect(releaseSteps.some((step) => step.name === "Validate release-data refresh result")).toBe(false);
    expect(releaseSteps.some((step) => step.run?.includes("PAGES_REFRESH_RESULT_PATH"))).toBe(false);

    expect(prepare.jobs["pages-prepare"].environment).toBeUndefined();
    expect(prepare.on.workflow_call?.secrets).toBeUndefined();
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    expect(steps.some((step) => step.run === "npm run generated:compile-input")).toBe(true);
    expect(steps.some((step) => /refresh-pages-release-data|post-refresh|next build|pages deploy/.test(step.run ?? ""))).toBe(false);
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const name = steps.find((step) => step.id === "workspace-artifact-name")!;
    expect(name.env?.WORKSPACE_ARTIFACT_NAME).toBe(artifactName);
    expect(name.run).not.toContain("${{");
    expect(prepare.jobs["pages-prepare"].outputs.workspace_artifact_name).toBe("${{ steps.workspace-artifact-name.outputs.name }}");
    expect(prepare.on.workflow_call.outputs.workspace_artifact_name.value).toBe("${{ jobs.pages-prepare.outputs.workspace_artifact_name }}");
    for (const caller of [deploy, rebuild]) {
      expect(caller.jobs["pages-release"].with.workspace_artifact_name).toBe("${{ needs.pages-prepare.outputs.workspace_artifact_name }}");
    }
    expect(release.on.workflow_call.inputs.workspace_artifact_name).toMatchObject({ required: true, type: "string" });
    expect(release.on.workflow_call.secrets.SITE_API_SHARED_SECRET).toEqual({ required: true });
    for (const caller of [deploy, rebuild]) {
      expect(caller.jobs["pages-release"].secrets.SITE_API_SHARED_SECRET).toBe("${{ secrets.SITE_API_SHARED_SECRET }}");
    }
    expect(release.jobs["pages-release"].env.SITE_API_SHARED_SECRET).toBeUndefined();
    expect(upload?.with).toMatchObject({
      name: "${{ steps.workspace-artifact-name.outputs.name }}", "compression-level": 0, "if-no-files-found": "error",
    });
    expect(steps.find((step) => step.run?.includes("tar -I"))?.run).toContain("zstd -T0 -3");
    const download = release.jobs["pages-release"].steps.find(
      (step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toBe("${{ inputs.workspace_artifact_name }}");
    expect(download.with.name).not.toContain("run_attempt");
    expect(release.jobs["pages-release"].environment.name).toBe("production");
  });

  it("accepts the earlier Pages producer attempt while rejecting unsafe or unrelated names", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pages-release.yml"));
    const steps = workflow.jobs["pages-release"].steps as Array<{
      name?: string; run?: string; uses?: string; env?: Record<string, string>;
    }>;
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
      [`pages-workspace-production-123-0-${sha}`, 1], [`${producerName}\ninjected=value`, 1],
      ["$(exit 0)", 1],
    ] as const) {
      const result = spawnSync("bash", ["-e", "-c", validation.run!], {
        env: { ...process.env, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sha, WORKSPACE_ARTIFACT_NAME: name },
        encoding: "utf8",
      });
      expect(result.status).toBe(status);
    }
  });

  it("packages both Workers before one migration and deploys heavy then public with individual proofs", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml"));
    const steps = workflow.jobs["deploy-worker"].steps as Array<{ id?: string; run?: string }>;
    const packageStep = steps.findIndex((step) => step.run === "npm run check:worker-package");
    const migrations = steps.map((step, index) => /d1 migrations apply/.test(step.run ?? "") ? index : -1).filter((index) => index >= 0);
    const heavyDeploy = steps.findIndex((step) => /wrangler deploy.*--config wrangler.heavy.toml/.test(step.run ?? ""));
    const publicDeploy = steps.findIndex((step) => /wrangler deploy.*--config wrangler.toml/.test(step.run ?? ""));
    const heavyVerify = steps.findIndex((step) => step.id === "verify-heavy-deployment");
    const publicVerify = steps.findIndex((step) => step.id === "verify-worker-deployment");
    expect(packageStep).toBeGreaterThanOrEqual(0);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBeGreaterThan(packageStep);
    expect(heavyDeploy).toBeGreaterThan(migrations[0]);
    expect(heavyVerify).toBeGreaterThan(heavyDeploy);
    expect(publicDeploy).toBeGreaterThan(heavyVerify);
    expect(publicVerify).toBeGreaterThan(publicDeploy);
    for (const index of [heavyDeploy, publicDeploy]) {
      expect(steps[index].run).toContain('--message "GitHub Actions deploy ${GITHUB_SHA}"');
    }
    expect(steps[heavyVerify].run).toContain("--script-name stablecoin-heavy");
    expect(steps[publicVerify].run).toContain("--script-name stablecoin-api");
    expect(steps.slice(0, heavyDeploy).some((step) => /deployments list|versions list/.test(step.run ?? ""))).toBe(false);
  });

  it("records both verified role markers monotonically only after paired proof", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml"));
    const steps = workflow.jobs["deploy-worker"].steps as Array<{ id?: string; name?: string; env?: Record<string, string>; run?: string }>;
    const markerIndex = steps.findIndex((step) => step.name === "Record verified Worker activation markers");
    const marker = steps[markerIndex];
    expect(markerIndex).toBeGreaterThan(steps.findIndex((step) => step.id === "verify-worker-deployment"));
    expect(marker.env).toMatchObject({
      PUBLIC_ACTIVATED_AT: "${{ steps.verify-worker-deployment.outputs.worker_activation_at }}",
      PUBLIC_VERSION: "${{ steps.verify-worker-deployment.outputs.worker_version }}",
      HEAVY_ACTIVATED_AT: "${{ steps.verify-heavy-deployment.outputs.worker_activation_at }}",
      HEAVY_VERSION: "${{ steps.verify-heavy-deployment.outputs.worker_version }}",
    });
    expect(marker.run).toContain("for role in heavy public");
    expect(marker.run).toContain("worker-active-version:${role}");
    expect(marker.run).toContain("worker-version-activated:${version}");
    expect(marker.run).toContain("ON CONFLICT(key) DO NOTHING");
    expect(marker.run).toContain("WHERE excluded.updated_at >= cache.updated_at");
    expect(marker.run).toContain("exit 1");
    expect(marker.run).not.toContain("exit 0");
    expect(marker.run).not.toContain("date +");
  });

  it("records read-only post-deploy acceptance for successfully deployed surfaces", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml")) as {
      jobs: Record<string, {
        environment?: unknown;
        needs?: string[];
        outputs?: Record<string, string>;
        permissions?: Record<string, string>;
        steps?: Array<{
          env?: Record<string, string>; id?: string; name?: string; run?: string; if?: string;
          uses?: string; with?: Record<string, string>;
        }>;
      }>;
    };
    const job = workflow.jobs["post-deploy-acceptance"];
    const acceptance = job.steps?.find((step) => step.name === "Record deployment identity and operational acceptance");

    expect(job.needs).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs).toBeUndefined();
    expect(acceptance?.if).toBe("${{ always() }}");
    expect(acceptance?.run).toContain("scripts/ci/run-post-deploy-acceptance.ts");
    expect(workflow.jobs["deploy-worker"].outputs).toEqual({
      worker_version: "${{ steps.verify-worker-deployment.outputs.worker_version }}",
      heavy_worker_version: "${{ steps.verify-heavy-deployment.outputs.worker_version }}",
    });
    const identity = job.steps?.find((step) => step.id === "verify-worker-identity");
    const deployIdentity = workflow.jobs["deploy-worker"].steps?.find(
      (step) => step.id === "verify-worker-deployment",
    );
    expect(identity?.run).toBe(deployIdentity?.run);
    expect(identity?.run).toContain("scripts/ci/verify-worker-deployment.ts");
    expect(job.steps?.find((step) => step.id === "verify-heavy-identity")?.run).toBe(
      workflow.jobs["deploy-worker"].steps?.find((step) => step.id === "verify-heavy-deployment")?.run,
    );
    const heavyIdentity = job.steps?.find((step) => step.id === "verify-heavy-identity");
    expect(heavyIdentity?.if).toBe("${{ always() && needs.deploy-worker.result == 'success' }}");
    expect(job.steps?.some((step) => step.name === "Require unchanged heavy activation identity")).toBe(false);
    const setup = job.steps?.find((step) => step.uses === "$/.github/actions/setup-workspace");
    expect(setup?.with).toMatchObject({
      "install-deps": "false", "cache-npm": "false", "bootstrap-generated": "false",
    });
    expect(job.steps?.some((step) => /npm|npx|wrangler/.test(step.run ?? ""))).toBe(false);
    expect(acceptance?.env).toMatchObject({
      EXPECTED_PAGES_COMMIT: "${{ github.sha }}",
      EXPECTED_WORKER_VERSION: "${{ needs.deploy-worker.outputs.worker_version }}",
      OBSERVED_WORKER_VERSION: "${{ steps.verify-worker-identity.outputs.worker_version }}",
      EXPECTED_HEAVY_WORKER_VERSION: "${{ needs.deploy-worker.outputs.heavy_worker_version }}",
      OBSERVED_HEAVY_WORKER_VERSION: "${{ steps.verify-heavy-identity.outputs.worker_version }}",
    });
  });

  it("keeps the curation expiry sweep process-only with sentinel verdicts and by-week renewal views", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/curation-expiry-sweep.yml")) as {
      permissions?: Record<string, string>;
      jobs: Record<string, {
        permissions?: Record<string, string>;
        steps: Array<{
          id?: string; name?: string; run?: string; uses?: string;
          with?: Record<string, unknown>; env?: Record<string, string>; "timeout-minutes"?: number;
        }>;
      }>;
    };
    const job = workflow.jobs.sweep;
    const steps = job.steps;
    const sentinels = steps.find((step) => step.id === "sentinels")!;
    const renewals = steps.find((step) => step.id === "renewals")!;
    const calendar = steps.find((step) => step.id === "calendar")!;
    const issue = steps.find((step) => step.run?.includes("gh issue edit"))!;
    const commands = steps.map((step) => step.run ?? "").join("\n");

    // Process-only: the sweep may maintain its own issue, never the repository or the ledger.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    expect(commands).not.toMatch(/\bgit push\b/);
    expect(commands).not.toMatch(/\bgh pr (create|merge|edit|close)\b/);
    expect(commands).not.toContain("ledger-append");
    expect(issue.run).toContain("gh issue edit");

    // The sentinel verdicts read the same ledger the applier writes and the registry this sweep regenerates.
    expect(sentinels.run).toContain("worker/scripts/check-safety-score-v9-ledger-sentinels.ts");
    expect(sentinels.run).toContain("--registry agents/sweep/missing-data-registry.json");
    expect(sentinels.run).toContain("--ledger .github/artifacts/safety-score-missing-data-reviewed-ledger.json");
    expect(sentinels.run).toContain("--replay agents/sweep/replay.json");
    expect(sentinels.run).toContain("--markdown agents/sweep/sentinel-resolutions.md");
    expect(steps.indexOf(steps.find((step) => step.id === "registry")!)).toBeLessThan(steps.indexOf(sentinels));

    // By-week views: the 14-day renewal section and the program-horizon calendar artifact.
    expect(renewals.run).toContain("--days 14 --by-week");
    expect(calendar.run).toContain('--horizon "$RENEWAL_HORIZON" --by-week');
    expect(calendar.env?.RENEWAL_HORIZON).toBe("2027-01-19");
    expect(steps.indexOf(sentinels)).toBeLessThan(steps.indexOf(renewals));
    expect(steps.indexOf(renewals)).toBeLessThan(steps.indexOf(calendar));

    // Each new read is deadline-bounded inside the 40-minute job and rides the 30-day artifact.
    for (const step of [sentinels, renewals, calendar]) expect(step["timeout-minutes"]).toBe(10);
    const upload = steps.find((step) => step.id === "snapshots")!;
    expect(upload.with?.path).toBe("agents/sweep/");
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

it("admits hosted protocol mechanism refresh only for Falcon on main dispatches and schedules", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/protocol-api-mechanism-refresh.yml"));
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  expect(workflow.on.schedule.length).toBeGreaterThan(0);
  expect(workflow.jobs.refresh.if).toBe("${{ github.ref == 'refs/heads/main' }}");
  expect(workflow.jobs.refresh.strategy.matrix).toEqual({ asset: ["usdf-falcon"] });
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
  // After prepare-branch switches the worktree to the automation branch, every
  // verifier invocation must resolve outside the mutable worktree.
  for (const line of run.split("\n")) {
    if (!line.includes("verify-mechanism-refresh-diff.ts") || line.includes("esbuild ")) continue;
    expect(line).toContain("$TRUSTED_VERIFIER/");
  }
  // Bundling includes the protocol replay/comparison dependency closure too,
  // without resolving any imports from the unreviewed checkout afterwards.
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
  function runMonitor(overrides: Record<string, unknown> = {}) {
    const workflow = parseYaml(readRepoFile(".github/workflows/cron-liveness.yml"));
    const run = workflow.jobs.delivery.steps.find((step: { id?: string }) => step.id === "health").run as string;
    const script = run.split("<<'NODE'\n")[1].split("\nNODE")[0];
    const now = Math.floor(Date.now() / 1000);
    const health = {
      status: "healthy", timestamp: now, warnings: [],
      schedulerLiveness: {
        status: "healthy", observedAt: now, lastAnyStartedAt: now - 30, lastFiveMinuteStartedAt: now - 30,
        ageSeconds: 30, warningAfterSec: 600, staleAfterSec: 1200,
        lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
          scheduleKey, lastStartedAt: now - 30,
        })),
        heavy: { status: "healthy", scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: now - 30,
          ageSeconds: 30, warningAfterSec: 1800, staleAfterSec: 2700, unavailableReason: null },
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
    expect(runMonitor({ schedulerLiveness: {
      status: "healthy", observedAt: now, warningAfterSec: 600, staleAfterSec: 1200,
      lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
        scheduleKey, lastStartedAt: now - 30,
      })),
      heavy: { status, scheduleKey: "v9SupplyAttributionOffset", warningAfterSec: 1800, staleAfterSec: 2700 },
    } }).status).toBe(1);
  });
});

describe("Cloudflare deployment credential scope", () => {
  type Step = { name?: string; id?: string; run?: string; uses?: string; env?: Record<string, string> };
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
    ["deploy-worker", ".github/workflows/deploy-cloudflare.yml", [
      "Verify pre-provisioned reserve Queue and dead-letter Queue",
      "Preflight remote D1 baseline adoption",
      "Apply production D1 migrations",
      "Deploy heavy Worker",
      "Verify active heavy Worker deployment",
      "Deploy public Worker",
      "Verify active public Worker deployment",
      "Record verified Worker activation markers",
    ]],
    ["pages-release", ".github/workflows/pages-release.yml", [
      "Deploy Pages",
      "Resolve active Pages deployment",
    ]],
  ])("%s exposes credentials only to named consumer steps", (jobName, path, consumers) => {
    const { job, holders, effective } = consumerSteps(path, jobName);
    for (const key of credentialKeys) expect(job.env?.[key]).toBeUndefined();
    expect(holders).toEqual(consumers);
    for (const { env, step } of effective) {
      if (!consumers.includes(step.name ?? "")) continue;
      expect(env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    }
  });

  it("keeps Pages build-only secret and public flags out of the deploy credential scope", () => {
    const { job, effective } = consumerSteps(".github/workflows/pages-release.yml", "pages-release");
    expect(job.env?.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY).toBe("true");
    const build = effective.find(({ step }) => step.name === "Build clean production export");
    expect(build?.env.SITE_API_SHARED_SECRET).toBe("${{ secrets.SITE_API_SHARED_SECRET }}");
    expect(build?.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    const marker = effective.find(({ step }) => step.name === "Verify deployment release marker");
    expect(marker?.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });
});
