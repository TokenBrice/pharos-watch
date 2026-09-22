#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import {
  type PostDeployAcceptanceOutcome,
  type PostDeployProbe,
  selectPostDeployProbes,
  summarizePostDeployAcceptance,
} from "../lib/post-deploy-acceptance.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { collectWorkerHttpProbes, fetchJsonProbe } from "../lib/worker-http-probes.mts";

export const PAGES_SHELL_URL = "https://stablecoin-dashboard.pages.dev";
export const WORKER_API_URL = "https://api.pharos.watch";
const WORKER_HEALTH_URL = `${WORKER_API_URL}/api/health`;

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
  expectedPagesCommit,
  expectedWorkerVersion,
  observedWorkerVersion,
}: PostDeployAcceptanceDependencies & {
  pagesDeployed?: boolean;
  workerDeployed?: boolean;
  expectedPagesCommit?: string;
  expectedWorkerVersion?: string;
  observedWorkerVersion?: string;
} = {}): Promise<PostDeployAcceptanceRun> {
  const probes = selectPostDeployProbes({ pagesDeployed, workerDeployed });
  const results: PostDeployProbeReport[] = [];

  for (const probe of probes) {
    if (probe.id === "pages-shell") {
      const response = await fetchJson({ apiUrl: PAGES_SHELL_URL }, "/__pharos_release.json");
      let releaseCommit: unknown;
      if (
        response.payload
        && typeof response.payload === "object"
        && !Array.isArray(response.payload)
        && "commit" in response.payload
      ) {
        releaseCommit = response.payload.commit;
      }
      const identityMatches = typeof expectedPagesCommit === "string"
        && expectedPagesCommit.length > 0
        && releaseCommit === expectedPagesCommit;
      results.push({
        ...probe,
        detail: `GET ${response.url} returned ${response.status}; release commit ${String(releaseCommit ?? "<missing>")}.`,
        outcome: response.ok && identityMatches ? "passed" : "failed",
      });
      continue;
    }

    if (probe.id === "worker-health") {
      const { health } = await collectWorkerProbes({ apiUrl: WORKER_API_URL }, { includeHealth: true });
      const healthPayload = health?.payload;
      const healthState = healthPayload
        && typeof healthPayload === "object"
        && !Array.isArray(healthPayload)
        && "status" in healthPayload
        ? healthPayload.status
        : undefined;
      const identityMatches = typeof expectedWorkerVersion === "string"
        && expectedWorkerVersion.length > 0
        && observedWorkerVersion === expectedWorkerVersion;
      // `degraded` means the surface is served with named data-quality findings
      // (a long-unpriced asset, a producer's degraded streak); only `stale` says
      // the public surface itself is not being served within its budgets.
      const served = healthState === "healthy" || healthState === "degraded";
      const warningList = healthPayload && typeof healthPayload === "object" && "warnings" in healthPayload
        && Array.isArray(healthPayload.warnings)
        ? healthPayload.warnings.map(String)
        : [];
      results.push({
        ...probe,
        detail: `GET ${health?.url ?? WORKER_HEALTH_URL} returned ${health?.status ?? 0}`
          + (healthState ? ` (${String(healthState)});` : ";")
          + ` active version ${observedWorkerVersion ?? "<missing>"}.`
          + (warningList.length > 0 ? ` Warnings: ${warningList.join(" | ")}` : ""),
        outcome: Boolean(health?.ok) && served && identityMatches ? "passed" : "failed",
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
    expectedPagesCommit: env.EXPECTED_PAGES_COMMIT,
    expectedWorkerVersion: env.EXPECTED_WORKER_VERSION,
    observedWorkerVersion: env.OBSERVED_WORKER_VERSION,
  });

  console.log(JSON.stringify({ probes: run.probes, acceptance: run.acceptance }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, run.summary);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `outcome=${run.acceptance.outcome}\n`);
  return run.exitCode;
}

runDirectCli(import.meta.url, () => {
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
