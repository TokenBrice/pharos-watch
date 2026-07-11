#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_FILE = join(tmpdir(), `worker-smoke-${process.pid}.log`);
const WORKER_PORT = Number.parseInt(process.env.WORKER_SMOKE_PORT ?? "8787", 10);
if (!Number.isInteger(WORKER_PORT) || WORKER_PORT <= 0 || WORKER_PORT > 65535) {
  throw new Error("WORKER_SMOKE_PORT must be an integer between 1 and 65535");
}
const WORKER_COMPATIBILITY_DATE = (process.env.WORKER_SMOKE_COMPATIBILITY_DATE ?? "").trim();
if (WORKER_COMPATIBILITY_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(WORKER_COMPATIBILITY_DATE)) {
  throw new Error("WORKER_SMOKE_COMPATIBILITY_DATE must use YYYY-MM-DD");
}
const WORKER_SMOKE_MODE = (process.env.WORKER_SMOKE_MODE ?? "full").trim();
if (WORKER_SMOKE_MODE !== "full" && WORKER_SMOKE_MODE !== "runtime") {
  throw new Error("WORKER_SMOKE_MODE must be full or runtime");
}
const WORKER_SMOKE_ISOLATED = process.env.WORKER_SMOKE_ISOLATED === "true";
const WORKER_ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;
const WORKER_URL = `${WORKER_ORIGIN}/api/health`;
const READINESS_ATTEMPTS = 60;

let wrangler = null;
let persistenceDirectory = null;

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
  if (persistenceDirectory) {
    await rm(persistenceDirectory, { recursive: true, force: true });
    persistenceDirectory = null;
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

async function runRuntimeSmoke() {
  const response = await fetch(`${WORKER_ORIGIN}/api/health`, {
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(`/api/health returned ${response.status}`);
  }
  if (!body || !["healthy", "degraded", "stale"].includes(body.status)) {
    throw new Error("/api/health returned an invalid status contract");
  }
  if (!Array.isArray(body.warnings) || !body.caches || typeof body.caches !== "object") {
    throw new Error("/api/health returned an invalid health payload");
  }
  process.stdout.write(`[worker-smoke] Runtime health contract passed (${body.status}).\n`);
}

try {
  if (WORKER_SMOKE_ISOLATED) {
    persistenceDirectory = await mkdtemp(join(tmpdir(), "pharos-worker-smoke-state-"));
    const migrations = spawnSync(
      "npx",
      [
        "--no-install",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "stablecoin-db",
        "--local",
        "--persist-to",
        persistenceDirectory,
      ],
      {
        cwd: "worker",
        encoding: "utf8",
        env: { ...process.env, CI: "true" },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (migrations.error) throw migrations.error;
    if (migrations.status !== 0) {
      throw new Error(
        `Failed to initialize isolated Worker D1 (${migrations.status}):\n${migrations.stdout}\n${migrations.stderr}`,
      );
    }
  }

  // 1. Start wrangler dev
  const logFd = await (async () => {
    const { open } = await import("node:fs/promises");
    return (await open(LOG_FILE, "a")).fd;
  })();

  const wranglerArgs = ["--no-install", "wrangler", "dev", "--port", String(WORKER_PORT), "--local"];
  if (persistenceDirectory) {
    wranglerArgs.push("--persist-to", persistenceDirectory);
  }
  if (WORKER_COMPATIBILITY_DATE) {
    wranglerArgs.push("--compatibility-date", WORKER_COMPATIBILITY_DATE);
  }
  wrangler = spawn("npx", wranglerArgs, {
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

  // 3. Run the requested smoke scope.
  if (WORKER_SMOKE_MODE === "runtime") {
    await runRuntimeSmoke();
    smokeExitCode = 0;
  } else {
    const smokeEnv = {
      ...process.env,
      SMOKE_API_BASE: WORKER_ORIGIN,
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
  }
} finally {
  // 4. Cleanup — dump log only on failure
  await cleanup(smokeExitCode !== 0);
}

// 5. Propagate smoke exit code
process.exit(smokeExitCode);
