#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export async function rollbackPagesDeployment({
  accountId,
  apiToken,
  projectName,
  deploymentId,
  fetchImpl = fetch,
} = {}) {
  if (!accountId) throw new Error("rollbackPagesDeployment: accountId is required");
  if (!apiToken) throw new Error("rollbackPagesDeployment: apiToken is required");
  if (!projectName) throw new Error("rollbackPagesDeployment: projectName is required");
  if (!deploymentId) throw new Error("rollbackPagesDeployment: deploymentId is required");

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}/rollback`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.errors?.map((err) => err?.message).filter(Boolean).join("; ")
      ?? text
      ?? "(no body)";
    throw new Error(`Cloudflare Pages rollback failed (HTTP ${response.status}): ${detail}`);
  }

  if (parsed && parsed.success === false) {
    const detail = parsed.errors?.map((err) => err?.message).filter(Boolean).join("; ") ?? "(no error message)";
    throw new Error(`Cloudflare Pages rollback returned success=false: ${detail}`);
  }

  return parsed?.result ?? null;
}

async function runCli() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const projectName = (process.env.CF_PAGES_PROJECT_NAME ?? "").trim();
  const deploymentId = (process.env.CF_PAGES_DEPLOYMENT_ID ?? "").trim();

  try {
    const result = await rollbackPagesDeployment({ accountId, apiToken, projectName, deploymentId });
    console.log(`[rollback-pages] success; rolled back to deployment ${result?.id ?? deploymentId}`);
  } catch (err) {
    console.error(`[rollback-pages] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli();
}
