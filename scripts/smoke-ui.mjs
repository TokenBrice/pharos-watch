#!/usr/bin/env node

import { execFile } from "child_process";
import { rmSync } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI_PREFIX = ["--yes", "--package", "@playwright/cli", "playwright-cli"];
const DEFAULT_URL = process.env.SMOKE_UI_URL ?? "https://pharos.watch";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SESSION_PREFIX = "prod-ui-smoke";

function parseArgs(argv) {
  const args = { url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      args.url = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing URL. Pass --url https://... or set SMOKE_UI_URL.");
  }
  const parsed = new URL(trimmed);
  return parsed.toString();
}

async function runPlaywrightCli(sessionId, args) {
  const { stdout, stderr } = await execFileAsync(
    "npx",
    [...PLAYWRIGHT_CLI_PREFIX, `-s=${sessionId}`, ...args],
    { maxBuffer: MAX_BUFFER_BYTES },
  );
  return `${stdout ?? ""}${stderr ?? ""}`;
}

function ensureNoCliError(step, output) {
  if (output.includes("### Error")) {
    throw new Error(`[smoke-ui] ${step} failed.\n${output}`);
  }
}

function parseResultJson(output) {
  const match =
    output.match(/### Result\s*([\s\S]*?)\n### Ran Playwright code/m) ??
    output.match(/### Result\s*([\s\S]*)$/m);
  if (!match) {
    throw new Error(`[smoke-ui] Could not parse Playwright result output.\n${output}`);
  }
  return JSON.parse(match[1].trim());
}

function removePlaywrightArtifacts() {
  rmSync(".playwright-cli", { recursive: true, force: true });
}

const UI_EVAL = `async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timeoutAt = Date.now() + 15000;
  while (Date.now() < timeoutAt) {
    const text = document.body?.innerText ?? "";
    const rows = document.querySelectorAll("table tbody tr").length;
    const hasFailedToLoad = text.includes("Failed to load data");
    const hasStablecoins404 = text.includes("stablecoins:404");
    if (rows > 0 || hasFailedToLoad || hasStablecoins404) {
      return {
        rows,
        hasFailedToLoad,
        hasStablecoins404,
        hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
        title: document.title,
        timedOut: false
      };
    }
    await delay(500);
  }
  const text = document.body?.innerText ?? "";
  return {
    rows: document.querySelectorAll("table tbody tr").length,
    hasFailedToLoad: text.includes("Failed to load data"),
    hasStablecoins404: text.includes("stablecoins:404"),
    hasKnownTicker: /\\bUSDT\\b|\\bUSDC\\b/.test(text),
    title: document.title,
    timedOut: true
  };
}`;

async function run() {
  const { url: rawUrl } = parseArgs(process.argv.slice(2));
  const url = ensureUrl(rawUrl);
  const sessionId = `${SESSION_PREFIX}-${Date.now()}`;

  console.log(`[smoke-ui] Running browser smoke checks against ${url}`);

  try {
    const openOutput = await runPlaywrightCli(sessionId, ["open", url]);
    ensureNoCliError("open", openOutput);

    const evalOutput = await runPlaywrightCli(sessionId, ["eval", UI_EVAL]);
    ensureNoCliError("eval", evalOutput);
    const summary = parseResultJson(evalOutput);

    assert(!summary.timedOut, "Timed out waiting for homepage table data");
    assert(!summary.hasFailedToLoad, "Found 'Failed to load data' UI banner");
    assert(!summary.hasStablecoins404, "Found '/api/stablecoins:404' style UI error");
    assert(summary.rows > 0, "Expected at least one stablecoin row in the homepage table");
    assert(summary.hasKnownTicker, "Could not find a known ticker (USDT/USDC) in homepage text");

    console.log(`[smoke-ui] OK ${summary.title}`);
    console.log(`[smoke-ui] OK table rows=${summary.rows}, knownTicker=${summary.hasKnownTicker}`);
    console.log("[smoke-ui] All checks passed.");
  } finally {
    try {
      await runPlaywrightCli(sessionId, ["close"]);
    } catch {
      // Best-effort cleanup; stale sessions can be killed by playwright-cli kill-all if needed.
    }
    removePlaywrightArtifacts();
  }
}

run().catch((error) => {
  console.error(`[smoke-ui] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  removePlaywrightArtifacts();
  process.exit(1);
});
