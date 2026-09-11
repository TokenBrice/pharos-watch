#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import {
  type PostDeployAcceptanceOutcome,
  type PostDeployProbe,
  selectPostDeployProbes,
  summarizePostDeployAcceptance,
} from "../lib/post-deploy-acceptance.mts";
import { runAsCli } from "../lib/source-files.mts";
import { collectWorkerHttpProbes, fetchJsonProbe } from "../lib/worker-http-probes.mts";

export const PAGES_SHELL_URL = "https://stablecoin-dashboard.pages.dev";
export const WORKER_API_URL = "https://api.pharos.watch";
const WORKER_HEALTH_URL = `${WORKER_API_URL}/api/health`;
const HTML_DOCUMENT = /<html[\s>]/i;

export interface PostDeployProbeReport extends PostDeployProbe {
  detail: string;
  outcome: PostDeployAcceptanceOutcome;
}

export interface PostDeployAcceptanceRun {
  acceptance: { outcome: PostDeployAcceptanceOutcome; reason: string };
  exitCode: number;
  probes: PostDeployProbeReport[];
  summary: string;
}

export interface PostDeployAcceptanceDependencies {
  collectWorkerProbes?: typeof collectWorkerHttpProbes;
  fetchJson?: typeof fetchJsonProbe;
}

/**
 * Read-only acceptance evidence for the surfaces that finished deploying. Every
 * probe is a GET: this job never mutates production and never rolls back, so a
 * failed probe only marks the release for operator assessment.
 */
export async function runPostDeployAcceptance({
  collectWorkerProbes = collectWorkerHttpProbes,
  fetchJson = fetchJsonProbe,
  pagesDeployed = false,
  workerDeployed = false,
}: PostDeployAcceptanceDependencies & {
  pagesDeployed?: boolean;
  workerDeployed?: boolean;
} = {}): Promise<PostDeployAcceptanceRun> {
  const probes = selectPostDeployProbes({ pagesDeployed, workerDeployed });
  const results: PostDeployProbeReport[] = [];

  for (const probe of probes) {
    if (probe.id === "pages-shell") {
      const response = await fetchJson({ apiUrl: PAGES_SHELL_URL }, "/");
      const shell = typeof response.payload === "string" ? response.payload : "";
      results.push({
        ...probe,
        detail: `GET ${response.url} returned ${response.status}.`,
        outcome: response.ok && HTML_DOCUMENT.test(shell) ? "passed" : "failed",
      });
      continue;
    }

    if (probe.id === "worker-health") {
      const { health } = await collectWorkerProbes({ apiUrl: WORKER_API_URL }, { includeHealth: true });
      const healthState = (health?.payload as { status?: unknown } | null | undefined)?.status;
      results.push({
        ...probe,
        detail: `GET ${health?.url ?? WORKER_HEALTH_URL} returned ${health?.status ?? 0}`
          + (healthState ? ` (${String(healthState)}).` : "."),
        outcome: Boolean(health?.ok) && healthState === "healthy" ? "passed" : "failed",
      });
    }
  }

  const acceptance = summarizePostDeployAcceptance(results);
  const summary = [
    "## Post-deploy operational acceptance",
    "",
    `- Outcome: ${acceptance.outcome}`,
    `- ${acceptance.reason}`,
    "- Scope: read-only GET probes only; no production mutation or automatic rollback.",
    "",
    "| Probe | Surface | Outcome | Evidence |",
    "| --- | --- | --- | --- |",
    ...results.map((result) => `| ${result.id} | ${result.surface} | ${result.outcome} | ${result.detail} |`),
    "",
  ].join("\n") + "\n";

  return {
    acceptance,
    exitCode: acceptance.outcome === "failed" ? 1 : 0,
    probes: results,
    summary,
  };
}

export async function runPostDeployAcceptanceCli(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PostDeployAcceptanceDependencies = {},
): Promise<number> {
  const run = await runPostDeployAcceptance({
    ...dependencies,
    pagesDeployed: env.PAGES_DEPLOYED === "true",
    workerDeployed: env.WORKER_DEPLOYED === "true",
  });

  console.log(JSON.stringify({ probes: run.probes, acceptance: run.acceptance }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, run.summary);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `outcome=${run.acceptance.outcome}\n`);
  return run.exitCode;
}

runAsCli(import.meta.url, () => {
  void runPostDeployAcceptanceCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
});
