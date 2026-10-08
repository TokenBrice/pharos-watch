import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Workflow {
  on: { workflow_call?: { outputs?: Record<string, { value: string }> } };
  jobs: Record<string, { steps?: Step[]; outputs?: Record<string, string>; with?: Record<string, string> }>;
}
const readYaml = (path: string) => parseYaml(readFileSync(resolve(process.cwd(), path), "utf8"));

// Evaluate the data references used for artifact transport, with different
// producer and consumer attempts. No consumer may reconstruct the identity.
function interpolate(value: string, context: Record<string, unknown>): string {
  return value.replace(/\$\{\{\s*([^{}]+?)\s*\}\}/g, (_, expression: string) => {
    const result = expression.trim().split(".").reduce<unknown>((object, key) => {
      if (object === null || typeof object !== "object") throw new Error(`Unresolved reference: ${expression}`);
      return (object as Record<string, unknown>)[key];
    }, context);
    if (typeof result !== "string") throw new Error(`Unresolved reference: ${expression}`);
    return result;
  });
}

function runNameStep(step: Step, env: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pharos-artifact-contract-"));
  try {
    const output = join(root, "output");
    const result = spawnSync("bash", ["-e", "-c", step.run!], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: output }, encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return readFileSync(output, "utf8").trim().replace(/^name=/, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const sha = "a".repeat(40);
const producerGithub = { run_id: "123", run_attempt: "1", sha };
const consumerGithub = { ...producerGithub, run_attempt: "2" };
const consumerEnv = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sha };

describe("release orchestration contracts", () => {
  it("invokes compile-input generators through npm's lifecycle PATH, never bare tsx", () => {
    const prepare = readYaml(".github/workflows/pages-prepare.yml") as Workflow;
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    const steps = prepare.jobs["pages-prepare"].steps!;
    const commands = steps.flatMap((step) => step.run?.split("\n").map((command) => command.trim()) ?? []);
    const lifecycleScripts = Object.entries(scripts).filter(([, command]) =>
      /run-generated-artifacts\.[a-z]+\s+--build-lifecycle=compile-input(?:\s|$)/.test(command),
    ).map(([name]) => name);
    expect(lifecycleScripts.length).toBeGreaterThan(0);
    expect(commands.some((command) => lifecycleScripts.some((name) => command === `npm run ${name}`))).toBe(true);
    expect(commands.some((command) => /(?:^|[;&|])\s*tsx\s/.test(command))).toBe(false);
    // The historical bare-Node invocation lacks npm's node_modules/.bin PATH,
    // even though Node can import tsx successfully in the parent process.
    expect(commands.some((command) => /^node\b.*run-generated-artifacts.*--build-lifecycle=compile-input/.test(command))).toBe(false);
  });

  it("transports producer-owned PR and Pages workspace names unchanged on failed-job reruns", () => {
    const action = readYaml(".github/actions/setup-workspace/action.yml") as {
      outputs: Record<string, { value: string }>; runs: { steps: Step[] };
    };
    const nameStep = action.runs.steps.find((step) => step.env?.WORKSPACE_ARTIFACT_MODE)!;
    const produced = runNameStep(nameStep, {
      ...consumerEnv, GITHUB_RUN_ATTEMPT: "1", WORKSPACE_ARTIFACT_MODE: "publish", WORKSPACE_ARTIFACT_NAME: "",
    });
    const actionContext = { steps: { [nameStep.id!]: { outputs: { name: produced } } } };
    const actionOutput = interpolate(action.outputs["workspace-artifact-name"].value, actionContext);
    const upload = action.runs.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(interpolate(upload.with!.name, actionContext)).toBe(produced);
    const pr = readYaml(".github/workflows/pull-request-checks.yml") as Workflow;
    const publish = pr.jobs.prepare.steps!.find((step) => step.with?.["workspace-artifact"] === "publish")!;
    const prepareOutput = interpolate(pr.jobs.prepare.outputs!.workspace_artifact_name, {
      steps: { [publish.id!]: { outputs: { "workspace-artifact-name": actionOutput } } },
    });
    const restores = Object.values(pr.jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => step.with?.["workspace-artifact"] === "restore");
    expect(restores.length).toBeGreaterThan(0);
    for (const restore of restores) {
      const inputName = interpolate(restore.with!["workspace-artifact-name"], {
        github: consumerGithub, needs: { prepare: { outputs: { workspace_artifact_name: prepareOutput } } },
      });
      const resolved = runNameStep(nameStep, {
        ...consumerEnv, WORKSPACE_ARTIFACT_MODE: "restore", WORKSPACE_ARTIFACT_NAME: inputName,
      });
      const download = action.runs.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
      expect(interpolate(download.with!.name, {
        github: consumerGithub, steps: { [nameStep.id!]: { outputs: { name: resolved } } },
      })).toBe(produced);
    }

    const pagesPrepare = readYaml(".github/workflows/pages-prepare.yml") as Workflow;
    const pagesJob = pagesPrepare.jobs["pages-prepare"];
    const pagesNameStep = pagesJob.steps!.find((step) => step.env?.WORKSPACE_ARTIFACT_NAME)!;
    const pagesProduced = runNameStep(pagesNameStep, {
      ...consumerEnv, GITHUB_RUN_ATTEMPT: "1",
      WORKSPACE_ARTIFACT_NAME: interpolate(pagesNameStep.env!.WORKSPACE_ARTIFACT_NAME, { github: producerGithub }),
    });
    const pagesContext = { steps: { [pagesNameStep.id!]: { outputs: { name: pagesProduced } } } };
    const pagesUpload = pagesJob.steps!.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(interpolate(pagesUpload.with!.name, pagesContext)).toBe(pagesProduced);
    const pagesJobOutput = interpolate(pagesJob.outputs!.workspace_artifact_name, pagesContext);
    const pagesOutput = interpolate(pagesPrepare.on.workflow_call!.outputs!.workspace_artifact_name.value, {
      jobs: { "pages-prepare": { outputs: { workspace_artifact_name: pagesJobOutput } } },
    });
    const release = readYaml(".github/workflows/pages-release.yml") as Workflow;
    const download = release.jobs["pages-release"].steps!.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    for (const path of [".github/workflows/deploy-cloudflare.yml", ".github/workflows/rebuild-pages.yml"]) {
      const caller = readYaml(path) as Workflow;
      const inputName = interpolate(caller.jobs["pages-release"].with!.workspace_artifact_name, {
        github: consumerGithub, needs: { "pages-prepare": { outputs: { workspace_artifact_name: pagesOutput } } },
      });
      expect(interpolate(download.with!.name, {
        github: consumerGithub, inputs: { workspace_artifact_name: inputName },
      })).toBe(pagesProduced);
    }
  });

  it("keeps automation snapshot PR payloads outside GitHub's workflow directory", () => {
    const publications: string[] = [];
    for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
      const workflow = readYaml(`.github/workflows/${file}`) as Workflow;
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          // Guard producer destinations before their publication selections.
          publications.push(...[...(step.run ?? "").matchAll(
            /(?:--output(?:=|\s+)|>{1,2}\s*)["']?(\.github\/[^\s"'\\]+)/g,
          )].map((match) => match[1]));
          if (!step.run?.includes("scripts/ci/open-automated-refresh-pr.ts")) continue;
          const paths = [...step.run.matchAll(/--path(?:=|\s+)["']?([^\s"'\\]+)/g)].map((match) => match[1]);
          expect(paths.length, `${file}: publication must declare its payload paths`).toBeGreaterThan(0);
          publications.push(...paths);
        }
      }
    }
    expect(publications.length).toBeGreaterThan(0);
    for (const path of publications) {
      const normalized = path.replace(/^\.\//, "");
      expect(normalized.startsWith(".github/workflows/"), path).toBe(false);
    }
  });
});
