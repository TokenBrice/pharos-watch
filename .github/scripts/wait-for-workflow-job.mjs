#!/usr/bin/env node

import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

const TERMINAL_FAILURE_STATUSES = new Set(["failure", "cancelled", "timed_out", "action_required", "skipped"]);
const USAGE = `Usage: node .github/scripts/wait-for-workflow-job.mjs --job <name> [options]

Options:
  --job <name>             Exact workflow job name (required)
  --attempts <count>       Poll attempts (default: 120)
  --sleep-sec <seconds>    Delay between attempts (default: 5)
  --stop-message <text>    Terminal-failure message
  --timeout-message <text> Exhaustion message
  -h, --help               Show this help`;

export function parseWorkflowWaitArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      attempts: { type: "string" },
      job: { type: "string" },
      "sleep-sec": { type: "string" },
      "stop-message": { type: "string" },
      "timeout-message": { type: "string" },
    },
  });
  const help = values.help === true;
  const jobName = typeof values.job === "string" ? values.job.trim() : "";
  if (!help) assertCliUsage(Boolean(jobName), "--job is required");
  return {
    attempts: typeof values.attempts === "string"
      ? parseCliInteger(values.attempts, { name: "--attempts", min: 1 })
      : 120,
    help,
    jobName,
    sleepSec: typeof values["sleep-sec"] === "string"
      ? parseCliInteger(values["sleep-sec"], { name: "--sleep-sec", min: 0 })
      : 5,
    stopMessage: typeof values["stop-message"] === "string" ? values["stop-message"] : null,
    timeoutMessage: typeof values["timeout-message"] === "string" ? values["timeout-message"] : null,
  };
}

function normalizeApiUrl(apiUrl) {
  return apiUrl.replace(/\/+$/g, "");
}

/**
 * @param {{
 *   apiUrl?: string,
 *   fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
 *   repository?: string,
 *   runId?: string,
 *   token?: string,
 * }} [options]
 */
export async function fetchWorkflowJobs({
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  repository,
  runId,
  token,
} = {}) {
  if (!repository || !runId || !token) {
    throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_TOKEN/GH_TOKEN are required");
  }

  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${normalizeApiUrl(apiUrl)}/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub jobs API returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload.jobs)) {
      throw new Error("GitHub jobs API response did not include a jobs array");
    }

    jobs.push(...payload.jobs);
    if (jobs.length >= (payload.total_count ?? jobs.length) || payload.jobs.length === 0) {
      break;
    }
  }
  return jobs;
}

export async function readJobStatus({ env = process.env, fetchImpl = fetch, jobName }) {
  try {
    const jobs = await fetchWorkflowJobs({
      apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      token: env.GITHUB_TOKEN ?? env.GH_TOKEN,
    });
    const job = jobs.find((candidate) => candidate.name === jobName);
    return { status: job ? (job.conclusion ?? job.status ?? null) : null, error: "" };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitForWorkflowJob({
  attempts = 120,
  env = process.env,
  fetchImpl = fetch,
  jobName,
  sleepImpl = sleep,
  sleepSec = 5,
  stopMessage = `${jobName} did not succeed; stopping.`,
  timeoutMessage = `Timed out waiting for ${jobName} to finish.`,
} = {}) {
  if (!jobName || !Number.isInteger(attempts) || attempts <= 0 || !Number.isFinite(sleepSec) || sleepSec < 0) {
    throw new Error("Usage: wait-for-workflow-job.mjs --job <name> [--attempts N] [--sleep-sec N]");
  }

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { status, error } = await readJobStatus({ env, fetchImpl, jobName });
    lastError = error || lastError;

    if (status === "success") {
      return;
    }

    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new Error(`${jobName} result was ${status}; ${stopMessage}`);
    }

    if (attempt < attempts && sleepSec > 0) {
      await sleepImpl(sleepSec * 1000);
    }
  }

  throw new Error(lastError ? `${timeoutMessage}\n${lastError}` : timeoutMessage);
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseWorkflowWaitArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE)) return;
  await waitForWorkflowJob({
    attempts: args.attempts,
    env,
    jobName: args.jobName,
    sleepSec: args.sleepSec,
    stopMessage: args.stopMessage ?? `${args.jobName} did not succeed; stopping.`,
    timeoutMessage: args.timeoutMessage ?? `Timed out waiting for ${args.jobName} to finish.`,
  });
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  void runCliEntrypoint(() => runCli(), {
    label: "wait-for-workflow-job",
    usage: USAGE,
  });
}
