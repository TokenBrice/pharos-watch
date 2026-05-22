#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const jobName = readArg("--job");
const attempts = Number(readArg("--attempts", "120"));
const sleepSec = Number(readArg("--sleep-sec", "5"));
const stopMessage = readArg("--stop-message", `${jobName} did not succeed; stopping.`);
const timeoutMessage = readArg("--timeout-message", `Timed out waiting for ${jobName} to finish.`);

if (!jobName || !Number.isInteger(attempts) || attempts <= 0 || !Number.isFinite(sleepSec) || sleepSec < 0) {
  console.error("Usage: wait-for-workflow-job.mjs --job <name> [--attempts N] [--sleep-sec N]");
  process.exit(2);
}

function readJobStatus() {
  const result = spawnSync(
    "gh",
    ["run", "view", process.env.GITHUB_RUN_ID ?? "", "--repo", process.env.GITHUB_REPOSITORY ?? "", "--json", "jobs"],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return { status: null, stderr: result.stderr };
  }

  const parsed = JSON.parse(result.stdout);
  const job = parsed.jobs?.find((candidate) => candidate.name === jobName);
  return { status: job ? (job.conclusion ?? job.status ?? null) : null, stderr: result.stderr };
}

let lastStderr = "";
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const { status, stderr } = readJobStatus();
  lastStderr = stderr || lastStderr;

  if (status === "success") {
    process.exit(0);
  }

  if (["failure", "cancelled", "timed_out", "action_required", "skipped"].includes(status)) {
    console.error(`${jobName} result was ${status}; ${stopMessage}`);
    process.exit(1);
  }

  if (attempt < attempts && sleepSec > 0) {
    await sleep(sleepSec * 1000);
  }
}

if (lastStderr) {
  console.error(lastStderr);
}
console.error(timeoutMessage);
process.exit(1);
