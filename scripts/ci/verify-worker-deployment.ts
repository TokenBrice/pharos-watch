#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

import { runAsCli } from "../lib/source-files.mts";

export interface WorkerDeploymentVersion {
  percentage?: number;
  version_id?: string;
}

/** `wrangler deployments status --json` shape. */
export interface ActiveWorkerDeployment {
  annotations?: Record<string, string | undefined>;
  id?: string;
  versions?: readonly WorkerDeploymentVersion[];
}

/** One entry of `wrangler deployments list --json`. */
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

function requireEnvPath(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} must name the JSON file captured by the deploy step.`);
  return value;
}

function readDeploymentHistory(env: NodeJS.ProcessEnv): ListedWorkerDeployment[] {
  if (env.DEPLOYMENT_HISTORY_AVAILABLE !== "true") return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(requireEnvPath(env, "DEPLOYMENTS_FILE"), "utf8"));
    return Array.isArray(parsed) ? (parsed as ListedWorkerDeployment[]) : [];
  } catch {
    console.log(
      "::warning::Cloudflare deployment history JSON was unavailable; the activation marker will be skipped.",
    );
    return [];
  }
}

function appendGithubOutput(env: NodeJS.ProcessEnv, line: string): void {
  appendFileSync(requireEnvPath(env, "GITHUB_OUTPUT"), line);
}

export function runWorkerDeploymentVerification(env: NodeJS.ProcessEnv = process.env): void {
  const deployment: ActiveWorkerDeployment = JSON.parse(
    readFileSync(requireEnvPath(env, "DEPLOYMENT_STATUS_FILE"), "utf8"),
  );
  const verified = verifyActiveWorkerDeployment(deployment, workerDeployMessage(env.GITHUB_SHA));
  const activation = selectWorkerActivationAt({
    deploymentId: verified.deploymentId,
    deployments: readDeploymentHistory(env),
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

runAsCli(import.meta.url, () => runWorkerDeploymentVerification());
