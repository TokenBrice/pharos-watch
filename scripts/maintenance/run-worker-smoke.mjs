#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_FILE = join(tmpdir(), `worker-smoke-${process.pid}.log`);
const WORKER_URL = "http://127.0.0.1:8787/api/stablecoins";
const READINESS_ATTEMPTS = 60;

let wrangler = null;

async function cleanup(dumpLog = false) {
  if (dumpLog) {
    try {
      const { readFile } = await import("node:fs/promises");
      const log = await readFile(LOG_FILE, "utf8");
      if (log) process.stderr.write(`\n--- wrangler dev log ---\n${log}\n`);
    } catch {
      // log may not exist
    }
  }
  if (wrangler) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    await unlink(LOG_FILE);
  } catch {
    // ignore
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await cleanup(false);
    process.exit(1);
  });
}

async function waitForWorker() {
  for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(WORKER_URL);
      void res; // any HTTP response means the listener is up
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

let smokeExitCode = 1;

try {
  // 1. Start wrangler dev
  const logFd = await (async () => {
    const { open } = await import("node:fs/promises");
    return (await open(LOG_FILE, "a")).fd;
  })();

  wrangler = spawn("npx", ["--no-install", "wrangler", "dev", "--port", "8787", "--local"], {
    cwd: "worker",
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  wrangler.on("error", (err) => {
    process.stderr.write(`[worker-smoke] Failed to start wrangler: ${err.message}\n`);
  });

  // 2. Wait for readiness
  process.stdout.write("[worker-smoke] Waiting for wrangler dev to be ready...\n");
  const ready = await waitForWorker();

  if (!ready) {
    process.stderr.write("[worker-smoke] Wrangler dev did not become ready after 60s.\n");
    await cleanup(true);
    process.exit(1);
  }

  process.stdout.write("[worker-smoke] Worker is up. Running smoke tests...\n");

  // 3. Run smoke-api
  const smokeEnv = {
    ...process.env,
    SMOKE_API_BASE: "http://127.0.0.1:8787",
    SMOKE_API_REQUIRE_KEY: "false",
    SMOKE_API_RETRY_COUNT: "2",
  };
  if (process.env.SMOKE_API_KEY) {
    smokeEnv.SMOKE_API_KEY = process.env.SMOKE_API_KEY;
  }

  const smoke = spawnSync("npm", ["run", "test:smoke-api"], {
    stdio: "inherit",
    env: smokeEnv,
  });

  if (smoke.error) throw smoke.error;
  smokeExitCode = smoke.status ?? 1;
} finally {
  // 4. Cleanup — dump log only on failure
  await cleanup(smokeExitCode !== 0);
}

// 5. Propagate smoke exit code
process.exit(smokeExitCode);
