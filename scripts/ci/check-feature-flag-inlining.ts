#!/usr/bin/env node
/**
 * Verifies that `NEXT_PUBLIC_PHAROS_*` feature flags are read in a way that
 * Next.js can statically replace at build time.
 *
 * Background: Next.js's compiler only inlines `process.env.NEXT_PUBLIC_X`
 * (direct dot access) when the env var is defined at build time. Dynamic
 * bracket access — `process.env[name]` — is never inlined regardless of
 * whether the variable is set, so the runtime lookup resolves against the
 * browser polyfill's empty `process.env` and the flag is silently `false`.
 *
 * Two-tier check:
 *
 *   1. Source-level (always run): scan `src/lib/feature-flags.ts` for any
 *      dynamic bracket access of `process.env[...]`. This catches the
 *      regression in the source even if no production build is around.
 *
 *   2. Bundle-level (when env vars are set): for any `NEXT_PUBLIC_PHAROS_*`
 *      env var that IS defined in this script's environment, the bundle must
 *      NOT contain the literal flag-name string — proof that Next.js inlined
 *      the comparison to a boolean. Skipped when no env vars are set, since
 *      Next.js legitimately leaves the lookup intact for an undefined value
 *      (resolves to `undefined` at runtime → `false`, which is the intended
 *      off-state).
 *
 * Wired into PAGES_VALIDATE_COMMANDS so it runs after `npm run build`.
 */

import { readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { collectSourceFiles } from "../lib/source-files.mts";
import { parseSourceFile } from "../lib/ts-ast.mts";

const FLAGS_SOURCE = "src/lib/feature-flags.ts";
const CHUNKS_DIR = ".next/static/chunks";
const FLAG_NAME_RE = /NEXT_PUBLIC_PHAROS_[A-Z_]+/g;

let errored = false;

// ---------- Tier 1: source-level scan ------------------------------------
let sourceFile: ts.SourceFile;
try {
  ({ sourceFile } = parseSourceFile(FLAGS_SOURCE));
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `check-feature-flag-inlining: could not read ${FLAGS_SOURCE}: ${message}\n`,
  );
  process.exit(1);
}

function hasDynamicEnvAccess(node: ts.Node): boolean {
  return (
    ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "process"
    && node.expression.name.text === "env"
  ) || ts.forEachChild(node, hasDynamicEnvAccess) === true;
}

if (hasDynamicEnvAccess(sourceFile)) {
  process.stderr.write(
    `check-feature-flag-inlining: ${FLAGS_SOURCE} uses dynamic \`process.env[...]\` access.\n` +
      "Next.js only inlines `process.env.NEXT_PUBLIC_X` (direct dot syntax). Switch to per-flag\n" +
      "literal reads so the value is replaced at build time.\n",
  );
  errored = true;
}

// ---------- Tier 2: bundle-level scan (only flags set at script-run) -----
function listChunkFiles(dir: string): string[] | null {
  try {
    statSync(dir);
  } catch {
    return null;
  }
  return collectSourceFiles(dir, { extensions: new Set([".js"]), excludedDirs: new Set() });
}

const setFlags = Object.keys(process.env).filter(
  (key) => key.startsWith("NEXT_PUBLIC_PHAROS_") && process.env[key] !== undefined,
);

if (setFlags.length > 0) {
  const files = listChunkFiles(CHUNKS_DIR);
  if (!files) {
    process.stderr.write(
      `check-feature-flag-inlining: ${setFlags.length} flag(s) set in env but ${CHUNKS_DIR} not found — run \`npm run build\` first.\n`,
    );
    process.exit(1);
  }
  const offenders = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const matches = content.match(FLAG_NAME_RE);
    if (!matches) continue;
    for (const name of new Set(matches)) {
      if (!setFlags.includes(name)) continue;
      const hits = offenders.get(name) ?? [];
      hits.push(file);
      offenders.set(name, hits);
    }
  }
  if (offenders.size > 0) {
    process.stderr.write(
      `check-feature-flag-inlining: ${offenders.size} flag(s) set in env but not inlined into the build.\n` +
        "These flags will silently be false in the browser despite being set at build time.\n",
    );
    for (const [name, hits] of offenders) {
      process.stderr.write(`  ${name}\n`);
      for (const f of hits.slice(0, 3)) {
        process.stderr.write(`    - ${f}\n`);
      }
      if (hits.length > 3) {
        process.stderr.write(`    ... ${hits.length - 3} more chunk(s)\n`);
      }
    }
    errored = true;
  } else {
    process.stdout.write(
      `check-feature-flag-inlining: ${setFlags.length} env-set flag(s) inlined across ${files.length} chunks.\n`,
    );
  }
} else {
  process.stdout.write(
    `check-feature-flag-inlining: source-level OK; no NEXT_PUBLIC_PHAROS_* env vars set, bundle inlining check skipped.\n`,
  );
}

if (errored) process.exit(1);
process.exit(0);
