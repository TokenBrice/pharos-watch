#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

import { runDirectCli } from "../lib/cli-args.mjs";

export interface WorkerDeploymentVersion {
  percentage?: number;
  version_id?: string;
}

/** Cloudflare Workers deployments API entry (the first entry is active). */
export interface ActiveWorkerDeployment {
  annotations?: Record<string, string | undefined>;
  id?: string;
  versions?: readonly WorkerDeploymentVersion[];
}

/** Deployment history entries from the same Cloudflare API response. */
export interface ListedWorkerDeployment {
  created_on?: string;
  id?: string;
  versions?: readonly WorkerDeploymentVersion[];
}

export interface VerifiedWorkerDeployment {
  deploymentId: string | null;
  workerVersion: string;
}

export interface WorkerActivationSelection {
  activationAtSec: number | null;
  createdOn: string | null;
}

export function workerDeployMessage(sha: string | undefined): string {
  return `GitHub Actions deploy ${sha}`;
}

/**
 * The SHA-tagged deployment must be the sole active version at 100% traffic.
 * Anything else fails the release instead of recording activation evidence.
 */
export function verifyActiveWorkerDeployment(
  deployment: ActiveWorkerDeployment,
  expectedMessage: string,
): VerifiedWorkerDeployment {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  const message = deployment?.annotations?.["workers/message"] ?? "";
  const version = versions[0];

  if (
    versions.length !== 1
    || version?.percentage !== 100
    || typeof version?.version_id !== "string"
    || message !== expectedMessage
  ) {
    throw new Error(
      `Active Worker deployment did not match this release: ${JSON.stringify({
        deploymentId: deployment?.id ?? null,
        message,
        versions,
      })}`,
    );
  }

  return { deploymentId: deployment.id ?? null, workerVersion: version.version_id };
}

/**
 * Activation time is the `created_on` of the Cloudflare deployment that carries
 * the verified version — never CI wall time and never the newest history entry.
 * The history is unordered, may repeat a timestamp across deployments, and may
 * omit the deployment entirely, so selection is by deployment identity plus
 * version match. An unmatched, unlisted, or unparseable entry yields `null`, and
 * the caller then skips the write-once marker so version reconciliation stays
 * fail-closed instead of recording a wrong activation instant.
 */
export function selectWorkerActivationAt({
  deploymentId,
  deployments,
  workerVersion,
}: {
  deploymentId: string | null;
  deployments: readonly ListedWorkerDeployment[];
  workerVersion: string;
}): WorkerActivationSelection {
  const listed = deploymentId === null
    ? undefined
    : (Array.isArray(deployments) ? deployments : []).find((candidate) => candidate?.id === deploymentId);
  const listedVersions: readonly WorkerDeploymentVersion[] = Array.isArray(listed?.versions) ? listed.versions : [];
  const listedVersionMatches = listedVersions.some((candidate) => candidate?.version_id === workerVersion);
  const createdOn = typeof listed?.created_on === "string" ? listed.created_on : null;
  const activationAtMs = createdOn === null ? Number.NaN : Date.parse(createdOn);
  const activationAtSec = listedVersionMatches && Number.isFinite(activationAtMs)
    ? Math.floor(activationAtMs / 1000)
    : Number.NaN;

  return {
    activationAtSec: Number.isSafeInteger(activationAtSec) && activationAtSec > 0 ? activationAtSec : null,
    createdOn,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required for Worker deployment verification.`);
  return value;
}

export function readWorkerScriptName(): string {
  const config = readFileSync(new URL("../../worker/wrangler.toml", import.meta.url), "utf8");
  const topLevel = config.split(/^\s*\[/m, 1)[0];
  const name = topLevel.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!name) throw new Error("worker/wrangler.toml must declare a top-level Worker name.");
  return name;
}

/**
 * GET /accounts/{account_id}/workers/scripts/{script_name}/deployments returns
 * { success, result: { deployments } }. Cloudflare documents the first entry
 * as the deployment actively serving traffic; do not sort by created_on.
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
 */
export async function fetchWorkerDeployments(
  env: NodeJS.ProcessEnv,
  fetchApi: typeof fetch = fetch,
): Promise<(ActiveWorkerDeployment & ListedWorkerDeployment)[]> {
  const accountId = requireEnv(env, "CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv(env, "CLOUDFLARE_API_TOKEN");
  const scriptName = readWorkerScriptName();
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
    + `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`;
  const response = await fetchApi(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Worker deployments API returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as {
    success?: boolean;
    result?: { deployments?: (ActiveWorkerDeployment & ListedWorkerDeployment)[] };
  } | null;
  if (payload?.success !== true || !Array.isArray(payload.result?.deployments)) {
    throw new Error("Cloudflare Worker deployments API returned an unsuccessful or malformed response.");
  }
  return payload.result.deployments;
}

function appendGithubOutput(env: NodeJS.ProcessEnv, line: string): void {
  // Local read-only smoke runs need no output file.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
}

export async function runWorkerDeploymentVerification(
  env: NodeJS.ProcessEnv = process.env,
  fetchApi: typeof fetch = fetch,
): Promise<void> {
  const expectedMessage = workerDeployMessage(requireEnv(env, "GITHUB_SHA"));
  const deployments = await fetchWorkerDeployments(env, fetchApi);
  const deployment = deployments[0];
  if (!deployment) throw new Error("Cloudflare Worker deployment history is empty; active identity is unavailable.");
  const verified = verifyActiveWorkerDeployment(deployment, expectedMessage);
  const activation = selectWorkerActivationAt({
    deploymentId: verified.deploymentId,
    deployments,
    workerVersion: verified.workerVersion,
  });

  console.log(
    `[worker-deployment] OK deployment=${verified.deploymentId} version=${verified.workerVersion} traffic=100%`,
  );
  appendGithubOutput(env, `worker_version=${verified.workerVersion}\n`);
  if (activation.activationAtSec === null) {
    console.log(
      `::warning::Cloudflare deployment ${verified.deploymentId} had no valid matching created_on;`
      + " the activation marker will be skipped.",
    );
    return;
  }
  appendGithubOutput(env, `worker_activation_at=${activation.activationAtSec}\n`);
  console.log(
    `[worker-deployment] Cloudflare activation created_on=${activation.createdOn}`
    + ` epoch=${activation.activationAtSec}`,
  );
}

runDirectCli(import.meta.url, () => runWorkerDeploymentVerification());
