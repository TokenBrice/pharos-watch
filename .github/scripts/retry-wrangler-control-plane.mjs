#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import { isDirectRun } from "../../scripts/lib/smoke-runtime.mjs";

const OPERATIONS = new Set(["deployment-status", "version-upload"]);
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_NETWORK_FAILURE =
  /Received a malformed response from the API|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i;
const CLOUDFLARE_REQUEST_FAILURE_PATTERN =
  "\\b(GET|HEAD|POST|PUT|PATCH|DELETE)\\s+((?:https:\\/\\/api\\.cloudflare\\.com\\/client\\/v4)?\\/\\S+)\\s+->\\s+(\\d{3})\\b";
const USAGE = `Usage: node .github/scripts/retry-wrangler-control-plane.mjs --operation <name> [options]

Options:
  --operation <name>        deployment-status or version-upload (required)
  --attempts <count>        Maximum attempts (default: 4)
  --base-delay-sec <secs>   Initial exponential-backoff delay (default: 5)
  --cwd <path>              Wrangler working directory (default: worker)
  --log-file <path>         Replace this file with the latest attempt's combined output
  --stdout-file <path>      Write successful deployment-status JSON to this file
  --message <text>          Candidate annotation for version-upload
  -h, --help                Show this help`;

export function parseWranglerRetryArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      attempts: { type: "string" },
      "base-delay-sec": { type: "string" },
      cwd: { type: "string" },
      "log-file": { type: "string" },
      message: { type: "string" },
      operation: { type: "string" },
      "stdout-file": { type: "string" },
    },
  });
  const help = values.help === true;
  const operation = typeof values.operation === "string" ? values.operation : "";
  const message = typeof values.message === "string" ? values.message : null;
  const stdoutFile = typeof values["stdout-file"] === "string" ? values["stdout-file"] : null;
  if (!help) {
    assertCliUsage(OPERATIONS.has(operation), "--operation must be deployment-status or version-upload");
    assertCliUsage(operation === "version-upload" || message === null, "--message requires --operation version-upload");
    assertCliUsage(
      operation === "deployment-status" || stdoutFile === null,
      "--stdout-file requires --operation deployment-status",
    );
  }
  return {
    attempts:
      typeof values.attempts === "string"
        ? parseCliInteger(values.attempts, { name: "--attempts", min: 1, max: 6 })
        : 4,
    baseDelaySec:
      typeof values["base-delay-sec"] === "string"
        ? parseCliInteger(values["base-delay-sec"], { name: "--base-delay-sec", min: 0, max: 60 })
        : 5,
    cwd: typeof values.cwd === "string" ? values.cwd : "worker",
    help,
    logFile: typeof values["log-file"] === "string" ? values["log-file"] : null,
    message,
    operation,
    stdoutFile,
  };
}

function requestFailures(output) {
  return [...output.matchAll(new RegExp(CLOUDFLARE_REQUEST_FAILURE_PATTERN, "gi"))].map((match) => ({
    method: match[1].toUpperCase(),
    status: Number(match[3]),
    target: match[2].replace(/^https:\/\/api\.cloudflare\.com\/client\/v4/i, ""),
  }));
}

function isVersionUploadPreflightRead(failure) {
  if (failure.method !== "GET") return false;
  const segments = failure.target.split("?", 1)[0].split("/").filter(Boolean);
  return (
    segments.length === 5 &&
    segments[0] === "accounts" &&
    Boolean(segments[1]) &&
    segments[2] === "workers" &&
    segments[3] === "services" &&
    Boolean(segments[4])
  );
}

export function isRetryableCloudflareFailure(output, { mutationRecorded = false, readOnlyCommand = false } = {}) {
  if (mutationRecorded) return false;
  const failures = requestFailures(output);
  const lastFailure = failures.at(-1);
  if (lastFailure && TRANSIENT_HTTP_STATUSES.has(lastFailure.status)) {
    return readOnlyCommand || isVersionUploadPreflightRead(lastFailure);
  }
  return readOnlyCommand && TRANSIENT_NETWORK_FAILURE.test(output);
}

function wranglerCommand(operation, message) {
  if (operation === "deployment-status") {
    return ["--no-install", "wrangler", "deployments", "status", "--json"];
  }
  if (operation === "version-upload") {
    return [
      "--no-install",
      "wrangler",
      "versions",
      "upload",
      "--message",
      message ?? "GitHub Actions candidate upload",
    ];
  }
  throw new Error(`Unsupported Wrangler operation: ${operation}`);
}

function spawnCommand(command, commandArgs, options) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stderr: `${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}`,
    stdout: result.stdout ?? "",
  };
}

function removeOutputFile(path) {
  if (!path) return;
  rmSync(path, { force: true });
}

function replaceOutputFile(path, content) {
  if (!path) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CI-trusted workflow path
  writeFileSync(path, content);
}

export function hasVersionUploadEvent(path) {
  if (!path) return false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- CI-trusted Wrangler output path
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          const event = JSON.parse(line);
          return event?.type === "version-upload" && typeof event.version_id === "string";
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   attempts?: number,
 *   baseDelaySec?: number,
 *   cwd?: string,
 *   env?: Readonly<Record<string, string | undefined>>,
 *   logFile?: string | null,
 *   message?: string | null,
 *   operation?: string,
 *   runImpl?: (
 *     command: string,
 *     commandArgs: readonly string[],
 *     options: { cwd: string, env: Readonly<Record<string, string | undefined>> },
 *   ) => Promise<{ status: number, stderr: string, stdout: string }> | { status: number, stderr: string, stdout: string },
 *   sleepImpl?: (delay?: number) => Promise<unknown>,
 *   stderr?: { write: (text: string) => unknown },
 *   stdout?: { write: (text: string) => unknown },
 *   stdoutFile?: string | null,
 * }} [options]
 */
export async function runWranglerWithRetry({
  attempts = 4,
  baseDelaySec = 5,
  cwd = "worker",
  env = process.env,
  logFile = null,
  message = null,
  operation,
  runImpl = spawnCommand,
  sleepImpl = sleep,
  stderr = process.stderr,
  stdout = process.stdout,
  stdoutFile = null,
} = {}) {
  if (!OPERATIONS.has(operation) || !Number.isInteger(attempts) || attempts <= 0 || !Number.isInteger(baseDelaySec)) {
    throw new Error("Invalid Wrangler retry configuration");
  }

  const commandArgs = wranglerCommand(operation, message);
  const readOnlyCommand = operation === "deployment-status";
  const wranglerOutputPath = operation === "version-upload" ? env.WRANGLER_OUTPUT_FILE_PATH : null;
  if (operation === "version-upload" && !wranglerOutputPath) {
    throw new Error("WRANGLER_OUTPUT_FILE_PATH is required for version-upload retry safety");
  }
  removeOutputFile(stdoutFile);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    removeOutputFile(wranglerOutputPath);
    const result = await runImpl("npx", commandArgs, { cwd, env });
    const combinedOutput = `${result.stdout}${result.stderr}`;
    const mutationRecorded = operation === "version-upload" && hasVersionUploadEvent(wranglerOutputPath);
    replaceOutputFile(logFile, combinedOutput);

    if (!stdoutFile || result.status !== 0) stdout.write(result.stdout);
    stderr.write(result.stderr);

    if (result.status === 0) {
      replaceOutputFile(stdoutFile, result.stdout);
      return;
    }

    const retryable = isRetryableCloudflareFailure(combinedOutput, { mutationRecorded, readOnlyCommand });
    if (!retryable || attempt === attempts) {
      throw new Error(`Wrangler ${operation} exited with status ${result.status} after ${attempt} attempt(s)`);
    }

    const delaySec = Math.min(baseDelaySec * 2 ** (attempt - 1), 60);
    stderr.write(
      `[retry-wrangler-control-plane] Transient read failure on attempt ${attempt}/${attempts}; retrying in ${delaySec}s.\n`,
    );
    if (delaySec > 0) await sleepImpl(delaySec * 1000);
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseWranglerRetryArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE)) return;
  await runWranglerWithRetry({ ...args, env });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runCli(), {
    label: "retry-wrangler-control-plane",
    usage: USAGE,
  });
}
