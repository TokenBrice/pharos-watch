#!/usr/bin/env node

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const entry = argv[i];
    if (!entry.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${entry}`);
    }
    const key = entry.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function required(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
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

const args = parseArgs(process.argv.slice(2));
const accountId = required("CLOUDFLARE_ACCOUNT_ID", process.env.CLOUDFLARE_ACCOUNT_ID);
const apiToken = required("CLOUDFLARE_API_TOKEN", process.env.CLOUDFLARE_API_TOKEN);
const versionId = required("WORKER_VERSION_ID", args["version-id"] ?? process.env.WORKER_VERSION_ID);
const workerName = required("WORKER_NAME", args.name ?? process.env.WORKER_NAME);
const message = args.message ?? process.env.DEPLOYMENT_MESSAGE ?? `GitHub Actions deploy ${process.env.GITHUB_SHA ?? versionId}`;
const payload = {
  strategy: "percentage",
  versions: [{ version_id: versionId, percentage: 100 }],
  annotations: { "workers/message": message },
};

if (args["dry-run"] === "true") {
  process.stdout.write(
    JSON.stringify(
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`,
        payload,
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
  process.exit(0);
}

const res = await fetch(
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

const deploymentId = body?.result?.id ?? "";
process.stdout.write(`Deployed ${workerName} version ${versionId} at 100%`);
if (deploymentId) {
  process.stdout.write(` (deployment ${deploymentId})`);
}
process.stdout.write("\n");
