#!/usr/bin/env node

import { relative, resolve } from "node:path";
import { build } from "esbuild";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ENTRYPOINTS = [
  "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts",
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

  if (violations.length > 0) {
    process.stderr.write("Mint/burn runtime import boundary failed:\n\n");
    for (const violation of violations) process.stderr.write(`  ${violation}\n`);
    process.stderr.write(
      "\nUse the lightweight Worker runtime registry; the full stablecoin registry exceeds the mint/burn lane's memory budget.\n",
    );
    return 1;
  }

  const entrypointLabel = ENTRYPOINTS.length === 1 ? "entrypoint" : "entrypoints";
  process.stdout.write(`Mint/burn runtime import boundary: OK (${ENTRYPOINTS.length} ${entrypointLabel})\n`);
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
