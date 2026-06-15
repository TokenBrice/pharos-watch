#!/usr/bin/env node
/**
 * CI guard: warns when local node_modules is out of sync with package-lock.json.
 *
 * Compares the mtime of package-lock.json against node_modules/.package-lock.json
 * (the snapshot written by `npm ci` / `npm install`). A newer lockfile means the
 * dev pulled dependency changes without reinstalling.
 *
 * Usage:
 *   node scripts/ci/check-node-modules-fresh.mjs           # warn-only (exit 0)
 *   node scripts/ci/check-node-modules-fresh.mjs --strict  # exit 1 on drift
 */
import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const strict = process.argv.includes("--strict");

const lockfile = resolve(root, "package-lock.json");
const snapshot = resolve(root, "node_modules/.package-lock.json");
const nmDir = resolve(root, "node_modules");

const MESSAGE_PREFIX = "[check:node-modules-fresh]";

function info(msg) {
  console.log(`${MESSAGE_PREFIX} ${msg}`);
}

function warn(msg) {
  console.warn(`${MESSAGE_PREFIX} ${msg}`);
}

function error(msg) {
  console.error(`${MESSAGE_PREFIX} ${msg}`);
}

// node_modules/ missing — always fatal, environment is broken
try {
  statSync(nmDir);
} catch {
  error("node_modules/ not found. Run `npm ci` before invoking the merge gate.");
  process.exit(1);
}

// node_modules/.package-lock.json missing — ambiguous install state
let snapshotMtime;
try {
  snapshotMtime = statSync(snapshot).mtimeMs;
} catch {
  warn(
    "node_modules/.package-lock.json not found — install state is ambiguous. Run `npm ci` to ensure a clean install.",
  );
  process.exit(strict ? 1 : 0);
}

// Compare mtimes
const lockfileMtime = statSync(lockfile).mtimeMs;

if (lockfileMtime > snapshotMtime) {
  const message = "package-lock.json is newer than node_modules. Run `npm ci` to refresh installed dependencies.";
  if (strict) {
    error(message);
  } else {
    info(message);
  }
  process.exit(strict ? 1 : 0);
}

info("node_modules matches package-lock.json.");
