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

function warn(msg) {
  console.warn(`[check:node-modules-fresh] ${msg}`);
}

// node_modules/ missing — always fatal, environment is broken
let nmStat;
try {
  nmStat = statSync(nmDir);
} catch {
  warn("node_modules/ not found. Run `npm ci` before invoking the merge gate.");
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
  warn(
    "package-lock.json is newer than node_modules. Run `npm ci` to refresh installed dependencies.",
  );
  process.exit(strict ? 1 : 0);
}

warn("node_modules matches package-lock.json.");
