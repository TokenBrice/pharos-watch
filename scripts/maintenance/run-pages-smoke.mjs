#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT_DIR = new URL("../../out", import.meta.url).pathname;
const SERVER_LOG = join(tmpdir(), `pages-smoke-server-${process.pid}.log`);
const ENV_FILE = resolve(".env.local");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

// ------------------------------------------------------------------
// Precondition: out/ must exist
// ------------------------------------------------------------------
try {
  await access(OUT_DIR);
} catch {
  console.error("[pages-smoke] out/ not found. Run `npm run build` before invoking the pages smoke.");
  process.exit(1);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function pickEnv(prefix) {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith(prefix)),
  );
}

function firstNonEmpty(...values) {
  return values.map((value) => value?.trim()).find(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------
// Server lifecycle
// ------------------------------------------------------------------
const apiKey = firstNonEmpty(process.env.STATIC_EXPORT_API_KEY, process.env.SMOKE_API_KEY, process.env.PHAROS_API_KEY);
const siteProxySecret = firstNonEmpty(
  process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET,
  process.env.SITE_API_SHARED_SECRET,
);
const serverEnv = {
  ...process.env,
  ...(apiKey ? { STATIC_EXPORT_API_KEY: apiKey } : {}),
  ...(siteProxySecret ? { STATIC_EXPORT_SITE_API_SHARED_SECRET: siteProxySecret } : {}),
  STATIC_EXPORT_HOST: process.env.STATIC_EXPORT_HOST ?? "127.0.0.1",
  STATIC_EXPORT_PORT: process.env.STATIC_EXPORT_PORT ?? "4173",
  ...pickEnv("STATIC_EXPORT_"),
};

let logFd;
try {
  await writeFile(SERVER_LOG, "");
  logFd = await (await import("node:fs")).promises.open(SERVER_LOG, "a");
} catch {
  logFd = null;
}

const server = spawn("npm", ["run", "serve:static-export"], {
  env: serverEnv,
  stdio: ["ignore", logFd?.fd ?? "ignore", logFd?.fd ?? "ignore"],
  detached: process.platform !== "win32",
});

async function dumpLog() {
  try {
    const log = await readFile(SERVER_LOG, "utf8");
    if (log.trim()) process.stderr.write(log);
  } catch { /* ignore */ }
}

async function cleanup() {
  try {
    if (process.platform !== "win32") {
      process.kill(-server.pid, "SIGTERM");
      await sleep(2000);
      try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
    } else {
      server.kill("SIGTERM");
    }
  } catch { /* process already gone */ }
  try { if (logFd) await logFd.close(); } catch { /* ignore */ }
  try { await rm(SERVER_LOG, { force: true }); } catch { /* ignore */ }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(1);
  });
}

// ------------------------------------------------------------------
// Wait for server readiness (30 × 1 s)
// ------------------------------------------------------------------
console.log("[pages-smoke] Waiting for static export server on http://127.0.0.1:4173 ...");
let ready = false;
for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    const res = await fetch("http://127.0.0.1:4173/");
    if (res.status < 400) { ready = true; break; }
  } catch { /* not up yet */ }
  await sleep(1000);
}

if (!ready) {
  console.error("[pages-smoke] Server did not become ready after 30 s. Server log:");
  await dumpLog();
  await cleanup();
  process.exit(1);
}
console.log("[pages-smoke] Server ready. Running smoke ...");

// ------------------------------------------------------------------
// Smoke run
// ------------------------------------------------------------------
const smokeEnv = { ...process.env, ...pickEnv("SMOKE_UI_"), ...pickEnv("SMOKE_MOBILE_UI_") };
let smokeExit = 1;

function runNpmScript(args) {
  return new Promise((resolve) => {
    const smoke = spawn("npm", args, { env: smokeEnv, stdio: "inherit" });
    smoke.on("close", resolve);
  });
}

try {
  smokeExit = await runNpmScript(["run", "test:smoke-ui", "--", "--url", "http://127.0.0.1:4173", "--mode", "local"]);
  if (smokeExit === 0) {
    smokeExit = await runNpmScript(["run", "test:smoke-ui:mobile", "--", "--url", "http://127.0.0.1:4173"]);
  }
} finally {
  if (smokeExit !== 0) {
    console.error("[pages-smoke] Smoke failed. Server log:");
    await dumpLog();
  }
  await cleanup();
}

process.exit(smokeExit);
