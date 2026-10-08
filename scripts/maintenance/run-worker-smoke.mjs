#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertHeavyNeutralProof, assertHeavySmokeWindow, isolatedEntrySource, isolatedSmokeConfig, nextHeavySmokeWindow, selectSmokeConfig } from "../lib/worker-compatibility-smoke.mjs";

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
if (!["full", "runtime", "scheduled-heavy"].includes(WORKER_SMOKE_MODE)) {
  throw new Error("WORKER_SMOKE_MODE must be full, runtime or scheduled-heavy");
}
const WORKER_SMOKE_ISOLATED = process.env.WORKER_SMOKE_ISOLATED === "true";
const SOURCE_CONFIG = selectSmokeConfig(process.env.WORKER_SMOKE_CONFIG ?? "worker/wrangler.toml", WORKER_SMOKE_MODE);
const HEAVY = WORKER_SMOKE_MODE === "scheduled-heavy";
if (HEAVY && !WORKER_SMOKE_ISOLATED) throw new Error("Heavy runtime smoke requires fresh isolated local D1");
let runtimeConfig = SOURCE_CONFIG;
const isolatedEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const childEnv = WORKER_SMOKE_ISOLATED ? { ...isolatedEnv, CI: "true", WRANGLER_SEND_METRICS: "false" } : process.env;
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
      const res = await fetch(HEAVY ? WORKER_ORIGIN : WORKER_URL);
      await res.body?.cancel(); // any HTTP response means the listener is up
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

function localD1(sql) {
  const result = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", "stablecoin-db", "--config", runtimeConfig,
    "--local", "--persist-to", persistenceDirectory, "--command", sql, "--json"], {
    cwd: "worker", encoding: "utf8", env: childEnv, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local D1 smoke query failed: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  if (!Array.isArray(payload) || payload.some((entry) => entry.success !== true)) throw new Error("Local D1 smoke query returned incomplete evidence");
  return payload.flatMap((entry) => entry.results ?? []);
}

async function runHeavyRuntimeSmoke() {
  const window = nextHeavySmokeWindow(Date.now());
  const delay = window.scheduledTimeMs - Date.now();
  if (delay > 0) {
    process.stdout.write(`[worker-smoke] Waiting for actual Heavy UTC :08 event ${new Date(window.scheduledTimeMs).toISOString()}.\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
  }
  assertHeavySmokeWindow(window, Date.now());
  const url = new URL("/__scheduled", WORKER_ORIGIN);
  url.searchParams.set("cron", "8 * * * *");
  url.searchParams.set("time", String(window.scheduledTimeMs));
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  await response.text();
  if (!response.ok) throw new Error(`Heavy scheduled endpoint returned ${response.status}`);
  const slotStartedAt = Math.floor(window.scheduledTimeMs / 1000);
  let parent;
  let child;
  for (let attempt = 0; attempt < 60; attempt++) {
    [parent] = localD1(`SELECT state, result_status, worker_version FROM cron_slot_executions WHERE slot_key = 'v9SupplyAttributionOffset' AND slot_started_at = ${slotStartedAt}`);
    [child] = localD1(`SELECT status, productive, item_count, degraded_reason, metadata FROM cron_runs WHERE job = 'sync-v9-supply-attribution' AND slot_started_at = ${slotStartedAt} ORDER BY started_at DESC LIMIT 1`);
    if (parent?.state === "finished" && child) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  const [counts] = localD1(`SELECT
    (SELECT COUNT(*) FROM cron_slot_executions WHERE slot_key = 'quarterHourly') AS core,
    (SELECT COUNT(*) FROM surface_publication_generations) AS publications,
    (SELECT COUNT(*) FROM cron_slot_executions WHERE state IN ('running', 'reconciling')) AS active,
    (SELECT COUNT(*) FROM cron_leases WHERE job = 'worker-memory-lane:safety-score-v9') AS memory,
    (SELECT COUNT(*) FROM cache WHERE key = 'stablecoins') AS business`);
  const proof = assertHeavyNeutralProof(parent, child, counts);
  const log = await readFile(LOG_FILE, "utf8");
  if (/WORKER_SMOKE_BLOCKED_(EGRESS|BUSINESS_WRITE)/.test(log)) throw new Error("Heavy smoke attempted forbidden egress or business writes");
  process.stdout.write(`[worker-smoke] Heavy neutral-core proof ${JSON.stringify(proof)}\n`);
}

try {
  if (WORKER_SMOKE_ISOLATED) {
    persistenceDirectory = await mkdtemp(join(tmpdir(), "pharos-worker-smoke-state-"));
    const source = await readFile(SOURCE_CONFIG, "utf8");
    const main = source.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
    if (!main) throw new Error("Smoke source config has no entrypoint");
    const entryPath = join(persistenceDirectory, "isolated-entry.mjs");
    await writeFile(entryPath, isolatedEntrySource(resolve(dirname(SOURCE_CONFIG), main), HEAVY));
    runtimeConfig = join(persistenceDirectory, "wrangler.json");
    await writeFile(runtimeConfig, JSON.stringify(isolatedSmokeConfig(source, SOURCE_CONFIG, entryPath, WORKER_COMPATIBILITY_DATE)));
    const migrations = spawnSync(
      "npx",
      [
        "--no-install",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "stablecoin-db",
        "--config",
        runtimeConfig,
        "--local",
        "--persist-to",
        persistenceDirectory,
      ],
      {
        cwd: "worker",
        encoding: "utf8",
        env: { ...childEnv, CI: "true" },
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

  const wranglerArgs = ["--no-install", "wrangler", "dev", "--config", runtimeConfig, "--port", String(WORKER_PORT), "--local"];
  if (HEAVY) wranglerArgs.push("--test-scheduled");
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
    env: childEnv,
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
  if (HEAVY) {
    await runHeavyRuntimeSmoke();
    smokeExitCode = 0;
  } else if (WORKER_SMOKE_MODE === "runtime") {
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
  if (WORKER_SMOKE_ISOLATED && /WORKER_SMOKE_BLOCKED_(EGRESS|BUSINESS_WRITE)/.test(await readFile(LOG_FILE, "utf8"))) {
    smokeExitCode = 1;
    throw new Error("Isolated smoke attempted forbidden egress or business writes");
  }
} finally {
  // 4. Cleanup — dump log only on failure
  await cleanup(smokeExitCode !== 0);
}

// 5. Propagate smoke exit code
process.exit(smokeExitCode);
