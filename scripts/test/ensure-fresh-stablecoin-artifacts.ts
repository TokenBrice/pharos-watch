/**
 * Vitest global setup: keep the gitignored stablecoin catalog artifacts fresh.
 *
 * `coins.generated.json` and the client projections built from it are
 * locally-built (gitignored) inputs that many suites import statically. A copy
 * left stale by a pull or schema change makes those suites fail with
 * misleading validation errors on unrelated coins (observed 2026-08-20: a
 * pre-tightening artifact produced mint-authority schema failures that looked
 * like data regressions). Regenerating here means no test run can observe a
 * stale artifact.
 *
 * A cheap mtime sweep guards the fast path so per-suite dev loops stay fast;
 * `npm run check:generated-artifacts` (CI) remains the authoritative
 * content-level guard.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const GENERATED_ASSET = join(REPO_ROOT, "shared/data/stablecoins/coins.generated.json");
const CANONICAL_ORDER_ASSET = join(REPO_ROOT, "shared/data/stablecoins/canonical-order.json");
const CLIENT_ARTIFACTS = [
  "shared/data/stablecoins/coins.client.list.generated.json",
  "shared/data/stablecoins/coins.client.detail",
  "shared/data/stablecoins/coins.compliance.generated.json",
  "shared/data/stablecoins/coins.telegram-mini-app.generated.json",
  "shared/data/stablecoins/coins.worker-runtime.generated.json",
].map((rel) => join(REPO_ROOT, rel));
const CLIENT_BUILDER = join(REPO_ROOT, "scripts/build-data/build-client-registry.mjs");

// Inputs whose change must invalidate coins.generated.json: the per-coin and
// sidecar data, and the schema/generator code that shapes the projection.
const GENERATED_INPUT_ROOTS = [
  "shared/data/stablecoins/coins",
  "shared/data/stablecoins/domains",
  "shared/data/stablecoins/canonical-order.json",
  "shared/lib/stablecoins",
  "shared/types",
  "scripts/lib/stablecoin-catalog-sources.ts",
].map((rel) => join(REPO_ROOT, rel));

function newestMtimeMs(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    newest = Math.max(newest, newestMtimeMs(join(path, entry.name)));
  }
  return newest;
}

function isStale(artifactPaths: string[], inputPaths: string[]): boolean {
  const artifactMtimes = artifactPaths.map((path) => (existsSync(path) ? statSync(path).mtimeMs : 0));
  const oldestArtifact = Math.min(...artifactMtimes);
  if (oldestArtifact === 0) return true;
  return inputPaths.some((path) => existsSync(path) && newestMtimeMs(path) > oldestArtifact);
}

export default async function ensureFreshStablecoinArtifacts(): Promise<void> {
  if (isStale([GENERATED_ASSET], GENERATED_INPUT_ROOTS)) {
    const { syncGeneratedPerCoinAsset } = await import("../lib/stablecoin-catalog-sources");
    const result = syncGeneratedPerCoinAsset({ rootDir: REPO_ROOT });
    if (result.changed) {
      console.log("[vitest-setup] regenerated stale shared/data/stablecoins/coins.generated.json");
    }
  }

  if (isStale(CLIENT_ARTIFACTS, [GENERATED_ASSET, CANONICAL_ORDER_ASSET, CLIENT_BUILDER])) {
    execFileSync(process.execPath, [CLIENT_BUILDER], { cwd: REPO_ROOT, stdio: "pipe" });
    console.log("[vitest-setup] rebuilt stale stablecoin client registry artifacts");
  }
}
