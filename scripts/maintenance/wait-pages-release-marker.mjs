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

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const USAGE = `Usage: node scripts/maintenance/wait-pages-release-marker.mjs [options]

Options:
  --url <url>         Release marker URL (repeatable; at least one required)
  --marker <path>     Expected local marker (default: out/__pharos_release.json)
  --attempts <count>  Poll attempts (default: 60)
  --delay-ms <ms>     Delay between attempts (default: 5000)
  --timeout-ms <ms>   Per-request timeout (default: 8000)
  -h, --help          Show this help`;

/** @param {readonly string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseReleaseMarkerArgs(argv, env = process.env) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      attempts: { type: "string" },
      "delay-ms": { type: "string" },
      marker: { type: "string" },
      "timeout-ms": { type: "string" },
      url: { type: "string", multiple: true },
    },
  });
  const args = {
    attempts: parsePositiveInt(env.PHAROS_RELEASE_MARKER_ATTEMPTS, DEFAULT_ATTEMPTS),
    delayMs: parsePositiveInt(env.PHAROS_RELEASE_MARKER_DELAY_MS, DEFAULT_DELAY_MS),
    help: values.help === true,
    markerPath: typeof values.marker === "string"
      ? values.marker
      : env.PHAROS_RELEASE_MARKER_PATH ?? "out/__pharos_release.json",
    timeoutMs: parsePositiveInt(env.PHAROS_RELEASE_MARKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    urls: Array.isArray(values.url) ? values.url : [],
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

function buildAccessHeaders() {
  const clientId = (process.env.OPS_SMOKE_CF_ACCESS_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.OPS_SMOKE_CF_ACCESS_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    return {};
  }
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

async function loadExpectedMarker(markerPath) {
  const text = await readFile(markerPath, "utf8");
  const marker = JSON.parse(text);
  const commit = typeof marker.commit === "string" ? marker.commit.trim() : "";
  if (!commit) {
    throw new Error(`Release marker ${markerPath} is missing a commit field`);
  }
  return { commit, text };
}

async function fetchMarker(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { body, response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForUrl(url, expectedCommit, options) {
  let lastDetail = "not attempted";
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const result = await fetchMarker(url, options);
      const liveCommit = typeof result.body?.commit === "string" ? result.body.commit.trim() : "";
      if (result.response.ok && liveCommit === expectedCommit) {
        console.log(`[release-marker] OK ${url} commit=${liveCommit}`);
        return;
      }
      lastDetail = `HTTP ${result.response.status}, commit=${liveCommit || "(missing)"}, body=${result.text.slice(0, 120)}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }

    console.log(
      `[release-marker] waiting for ${url} (${attempt}/${options.attempts}): ${lastDetail}`,
    );
    if (attempt < options.attempts) {
      await sleep(options.delayMs);
    }
  }

  throw new Error(`Timed out waiting for ${url} to serve commit ${expectedCommit}: ${lastDetail}`);
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseReleaseMarkerArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE)) return;
  const urls = args.urls.map((url) => url.trim()).filter(Boolean);
  assertCliUsage(urls.length > 0, "at least one --url is required");

  const expected = await loadExpectedMarker(args.markerPath);
  const headers = buildAccessHeaders();
  for (const url of urls) {
    await waitForUrl(url, expected.commit, { ...args, headers });
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => run(), {
    label: "release-marker",
    usage: USAGE,
  });
}
