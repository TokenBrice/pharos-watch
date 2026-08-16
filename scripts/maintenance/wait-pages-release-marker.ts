#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun, parsePositiveInt, sleep } from "../lib/smoke-runtime.mjs";

const DEFAULT_ATTEMPTS = 24;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const USAGE = `Usage: node --import tsx scripts/maintenance/wait-pages-release-marker.ts [options]

Options:
  --url <url>         Release marker URL (required)
  --marker <path>     Expected local marker (default: out/__pharos_release.json)
  --attempts <count>  Poll attempts (default: 24)
  --delay-ms <ms>     Delay between attempts (default: 5000)
  --timeout-ms <ms>   Per-request timeout (default: 8000)
  -h, --help          Show this help`;

interface ReleaseMarkerArgs {
  attempts: number;
  delayMs: number;
  help: boolean;
  markerPath: string;
  timeoutMs: number;
  url: string;
}

export function parseReleaseMarkerArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ReleaseMarkerArgs {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      attempts: { type: "string" },
      "delay-ms": { type: "string" },
      marker: { type: "string" },
      "timeout-ms": { type: "string" },
      url: { type: "string" },
    },
  });
  const args = {
    attempts: parsePositiveInt(env.PHAROS_RELEASE_MARKER_ATTEMPTS, DEFAULT_ATTEMPTS),
    delayMs: parsePositiveInt(env.PHAROS_RELEASE_MARKER_DELAY_MS, DEFAULT_DELAY_MS),
    help: values.help === true,
    markerPath:
      typeof values.marker === "string"
        ? values.marker
        : (env.PHAROS_RELEASE_MARKER_PATH ?? "out/__pharos_release.json"),
    timeoutMs: parsePositiveInt(env.PHAROS_RELEASE_MARKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    url: typeof values.url === "string" ? values.url.trim() : "",
  };
  if (typeof values.attempts === "string") {
    args.attempts = parseCliInteger(values.attempts, { name: "--attempts", min: 1 });
  }
  if (typeof values["delay-ms"] === "string") {
    args.delayMs = parseCliInteger(values["delay-ms"], { name: "--delay-ms", min: 0 });
  }
  if (typeof values["timeout-ms"] === "string") {
    args.timeoutMs = parseCliInteger(values["timeout-ms"], { name: "--timeout-ms", min: 1 });
  }
  return args;
}

async function loadExpectedCommit(markerPath: string): Promise<string> {
  const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
  const record: Record<string, unknown> =
    marker !== null && typeof marker === "object" && !Array.isArray(marker)
      ? (marker as Record<string, unknown>)
      : {};
  const commit = typeof record.commit === "string" ? record.commit.trim() : "";
  if (!commit) {
    throw new Error(`Release marker ${markerPath} is missing a commit field`);
  }
  return commit;
}

async function fetchMarker(
  rawUrl: string,
  commit: string,
  attempt: number,
  timeoutMs: number,
): Promise<{ body: Record<string, unknown> | null; response: Response; text: string }> {
  const url = new URL(rawUrl);
  url.searchParams.set("expected", commit);
  url.searchParams.set("attempt", String(attempt));
  url.searchParams.set("cache", String(Date.now()));
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // The status and body prefix below are enough to diagnose a non-JSON edge response.
  }
  return { body, response, text };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseReleaseMarkerArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE)) return;
  assertCliUsage(args.url !== "", "--url is required");

  const expectedCommit = await loadExpectedCommit(args.markerPath);
  let lastDetail = "not attempted";
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    try {
      const result = await fetchMarker(args.url, expectedCommit, attempt, args.timeoutMs);
      const liveCommit = typeof result.body?.commit === "string" ? result.body.commit.trim() : "";
      if (result.response.ok && liveCommit === expectedCommit) {
        console.log(`[release-marker] OK ${args.url} commit=${liveCommit}`);
        return;
      }
      lastDetail = `HTTP ${result.response.status}, commit=${liveCommit || "(missing)"}, body=${result.text.slice(0, 120)}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }

    console.log(`[release-marker] waiting (${attempt}/${args.attempts}): ${lastDetail}`);
    if (attempt < args.attempts) await sleep(args.delayMs);
  }

  throw new Error(`Timed out waiting for ${args.url} to serve commit ${expectedCommit}: ${lastDetail}`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => run(), { label: "release-marker", usage: USAGE });
}
