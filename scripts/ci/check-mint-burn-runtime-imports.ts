#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { build } from "esbuild";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// Every scheduled entrypoint that runs inside the 128 MB isolate without the
// evidence-rich registry. Telegram joined on 2026-09-02 after Cloudflare
// analytics attributed the five-minute lane's platform abandonment to
// `exceededMemory` (196/7d) rather than the CPU class, and the lane only reads
// id/symbol/name/status/pegCurrency.
const ENTRYPOINTS = [
  "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts",
  "worker/src/handlers/scheduled/five-minute-telegram.ts",
] as const;
const MEMBERSHIP_ONLY_MODULES = [
  "worker/src/cron/prune-detail-cache.ts",
  "worker/src/cron/snapshot-supply.ts",
] as const;
const FORBIDDEN_MEMBERSHIP_IMPORTS = [
  "@shared/lib/psi-eligible",
  "@shared/lib/stablecoins/registry",
] as const;
const FORBIDDEN_RUNTIME_INPUTS = new Set([
  "shared/data/stablecoins/coins.generated.json",
  "shared/lib/stablecoins/registry.ts",
  "shared/lib/tracked-stablecoin-utils.ts",
]);

function normalizeInputPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("../") || normalized.startsWith("/")
    ? relative(REPO_ROOT, resolve(REPO_ROOT, normalized)).replaceAll("\\", "/")
    : normalized;
}

export function findForbiddenMintBurnRuntimeInputs(inputs: Iterable<string>): string[] {
  return [...inputs]
    .map(normalizeInputPath)
    .filter((path) => FORBIDDEN_RUNTIME_INPUTS.has(path))
    .sort();
}

export async function checkMintBurnRuntimeImports(): Promise<number> {
  const violations: string[] = [];
  for (const entryPoint of ENTRYPOINTS) {
    const result = await build({
      absWorkingDir: REPO_ROOT,
      bundle: true,
      entryPoints: [entryPoint],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      tsconfig: "worker/tsconfig.json",
      write: false,
    });
    const forbidden = findForbiddenMintBurnRuntimeInputs(Object.keys(result.metafile.inputs));
    for (const input of forbidden) {
      violations.push(`${entryPoint} reaches ${input}`);
    }
  }

  for (const modulePath of MEMBERSHIP_ONLY_MODULES) {
    const source = await readFile(resolve(REPO_ROOT, modulePath), "utf8");
    for (const forbiddenImport of FORBIDDEN_MEMBERSHIP_IMPORTS) {
      if (source.includes(`from "${forbiddenImport}"`) || source.includes(`from '${forbiddenImport}'`)) {
        violations.push(`${modulePath} directly imports ${forbiddenImport}`);
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write("Worker runtime import boundary failed:\n\n");
    for (const violation of violations) process.stderr.write(`  ${violation}\n`);
    process.stderr.write(
      "\nUse the lightweight Worker runtime registry; the full stablecoin registry exceeds the lane's isolate memory budget.\n",
    );
    return 1;
  }

  process.stdout.write(
    `Worker runtime import boundary: OK (${ENTRYPOINTS.length} entrypoints, ${MEMBERSHIP_ONLY_MODULES.length} membership modules)\n`,
  );
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  checkMintBurnRuntimeImports()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
