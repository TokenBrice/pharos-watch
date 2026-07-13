#!/usr/bin/env node

import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun, sleep } from "../lib/smoke-runtime.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const USAGE = `Usage: node scripts/maintenance/rollback-pages-deployment.mjs [options]

Options:
  --dry-run     Validate environment and print the rollback target without calling Cloudflare
  -h, --help    Show this help

Required environment:
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CF_PAGES_PROJECT_NAME,
  CF_PAGES_DEPLOYMENT_ID`;

export function parsePagesRollbackArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "dry-run": { type: "boolean" },
    },
  });
  return { dryRun: values["dry-run"] === true, help: values.help === true };
}

async function singleAttempt({ url, apiToken, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
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

  if (parsed === null) {
    throw new Error(
      `Cloudflare Pages rollback returned HTTP ${response.status} with unparseable body: ${text.slice(0, 200) || "(empty)"}`,
    );
  }

  if (parsed.success === false) {
    const detail = parsed.errors?.map((err) => err?.message).filter(Boolean).join("; ") ?? "(no error message)";
    throw new Error(`Cloudflare Pages rollback returned success=false: ${detail}`);
  }

  return parsed.result ?? null;
}

/**
 * @param {{
 *   accountId?: string,
 *   apiToken?: string,
 *   projectName?: string,
 *   deploymentId?: string,
 *   fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   timeoutMs?: number,
 *   onAttemptError?: (attempt: number, error: unknown) => void,
 * }} [options]
 */
export async function rollbackPagesDeployment({
  accountId,
  apiToken,
  projectName,
  deploymentId,
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onAttemptError,
} = {}) {
  if (!accountId) throw new Error("rollbackPagesDeployment: accountId is required");
  if (!apiToken) throw new Error("rollbackPagesDeployment: apiToken is required");
  if (!projectName) throw new Error("rollbackPagesDeployment: projectName is required");
  if (!deploymentId) throw new Error("rollbackPagesDeployment: deploymentId is required");

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}/rollback`;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await singleAttempt({ url, apiToken, fetchImpl, timeoutMs });
    } catch (err) {
      lastError = err;
      onAttemptError?.(attempt, err);
      if (attempt < maxAttempts) {
        const delayMs = retryDelayMs * attempt;
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

export async function runPagesRollbackCli(argv = process.argv.slice(2), env = process.env) {
  const options = parsePagesRollbackArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;

  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const projectName = (env.CF_PAGES_PROJECT_NAME ?? "").trim();
  const deploymentId = (env.CF_PAGES_DEPLOYMENT_ID ?? "").trim();
  const brokenSha = (env.GITHUB_SHA ?? "").trim();
  assertCliUsage(Boolean(accountId), "CLOUDFLARE_ACCOUNT_ID is required");
  assertCliUsage(Boolean(projectName), "CF_PAGES_PROJECT_NAME is required");
  assertCliUsage(Boolean(deploymentId), "CF_PAGES_DEPLOYMENT_ID is required");
  if (options.dryRun) {
    console.log(`[rollback-pages] dry run: would roll back ${projectName} to ${deploymentId}`);
    return;
  }
  assertCliUsage(Boolean(apiToken), "CLOUDFLARE_API_TOKEN is required");

  try {
    const result = await rollbackPagesDeployment({
      accountId,
      apiToken,
      projectName,
      deploymentId,
      onAttemptError: (attempt, err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[rollback-pages] attempt ${attempt} failed: ${message}`);
      },
    });
    const restoredId = result?.id ?? deploymentId;
    console.log(`[rollback-pages] success`);
    console.log(`[rollback-pages]   project:         ${projectName}`);
    console.log(`[rollback-pages]   restored to:     ${restoredId}`);
    if (brokenSha) console.log(`[rollback-pages]   broken commit:   ${brokenSha}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rollback-pages] failed after retries: ${message}`);
    console.error(`[rollback-pages]   project:         ${projectName}`);
    console.error(`[rollback-pages]   target to restore: ${deploymentId}`);
    if (brokenSha) console.error(`[rollback-pages]   broken commit:   ${brokenSha}`);
    throw err;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runPagesRollbackCli(), {
    label: "rollback-pages",
    usage: USAGE,
  });
}
