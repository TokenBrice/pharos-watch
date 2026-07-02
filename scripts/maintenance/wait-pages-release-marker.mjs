#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { isDirectRun, parsePositiveInt, sleep } from "../lib/smoke-runtime.mjs";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function parseArgs(argv) {
  const args = {
    attempts: parsePositiveInt(process.env.PHAROS_RELEASE_MARKER_ATTEMPTS, DEFAULT_ATTEMPTS),
    delayMs: parsePositiveInt(process.env.PHAROS_RELEASE_MARKER_DELAY_MS, DEFAULT_DELAY_MS),
    markerPath: process.env.PHAROS_RELEASE_MARKER_PATH ?? "out/__pharos_release.json",
    timeoutMs: parsePositiveInt(process.env.PHAROS_RELEASE_MARKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    urls: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--marker") {
      args.markerPath = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--url") {
      args.urls.push(argv[index + 1] ?? "");
      index += 1;
    } else if (arg === "--attempts") {
      args.attempts = parsePositiveInt(argv[index + 1], args.attempts);
      index += 1;
    } else if (arg === "--delay-ms") {
      args.delayMs = parsePositiveInt(argv[index + 1], args.delayMs);
      index += 1;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parsePositiveInt(argv[index + 1], args.timeoutMs);
      index += 1;
    }
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
  const args = parseArgs(argv);
  const urls = args.urls.map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) {
    throw new Error("Pass at least one --url for the release marker to check");
  }

  const expected = await loadExpectedMarker(args.markerPath);
  const headers = buildAccessHeaders();
  for (const url of urls) {
    await waitForUrl(url, expected.commit, { ...args, headers });
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[release-marker] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
