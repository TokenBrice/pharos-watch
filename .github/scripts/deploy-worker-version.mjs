#!/usr/bin/env node

import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import { isDirectRun } from "../../scripts/lib/smoke-runtime.mjs";

const USAGE = `Usage: node .github/scripts/deploy-worker-version.mjs [options]

Options:
  --version-id <id>  Worker version (overrides WORKER_VERSION_ID)
  --name <name>      Worker name (overrides WORKER_NAME)
  --message <text>   Deployment annotation
  --dry-run          Print the target and payload without calling Cloudflare
  -h, --help         Show this help`;

export function parseWorkerDeploymentArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "dry-run": { type: "boolean" },
      message: { type: "string" },
      name: { type: "string" },
      "version-id": { type: "string" },
    },
  });
  return {
    dryRun: values["dry-run"] === true,
    help: values.help === true,
    message: typeof values.message === "string" ? values.message : null,
    name: typeof values.name === "string" ? values.name : null,
    versionId: typeof values["version-id"] === "string" ? values["version-id"] : null,
  };
}

function required(name, value) {
  assertCliUsage(Boolean(value), `${name} is required`);
  return value;
}

function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "unknown Cloudflare API error";
  return errors
    .map((error) => {
      if (error && typeof error === "object") {
        const code = "code" in error ? ` [code: ${error.code}]` : "";
        const message = "message" in error ? String(error.message) : JSON.stringify(error);
        return `${message}${code}`;
      }
      return String(error);
    })
    .join("; ");
}

export async function deployWorkerVersion({
  accountId,
  apiToken,
  fetchImpl = fetch,
  payload,
  versionId,
  workerName,
}) {
  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    throw new Error(
      `Worker deployment API request failed with HTTP ${res.status}: ${formatErrors(body?.errors)}`,
    );
  }
  return { deploymentId: body?.result?.id ?? "", versionId, workerName };
}

export async function runWorkerDeploymentCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseWorkerDeploymentArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE)) return;

  const accountId = required("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID);
  const versionId = required("WORKER_VERSION_ID", args.versionId ?? env.WORKER_VERSION_ID);
  const workerName = required("WORKER_NAME", args.name ?? env.WORKER_NAME);
  const message = args.message ?? env.DEPLOYMENT_MESSAGE ?? `GitHub Actions deploy ${env.GITHUB_SHA ?? versionId}`;
  const payload = {
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: { "workers/message": message },
  };
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`;
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ url, payload }, null, 2)}\n`);
    return;
  }

  const apiToken = required("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN);
  const result = await deployWorkerVersion({ accountId, apiToken, payload, versionId, workerName });
  process.stdout.write(`Deployed ${workerName} version ${versionId} at 100%`);
  if (result.deploymentId) process.stdout.write(` (deployment ${result.deploymentId})`);
  process.stdout.write("\n");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runWorkerDeploymentCli(), {
    label: "deploy-worker-version",
    usage: USAGE,
  });
}
