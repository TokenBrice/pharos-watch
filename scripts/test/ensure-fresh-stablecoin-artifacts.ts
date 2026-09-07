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
 * Cached input/output metadata guards the fast path so per-suite dev loops stay fast;
 * `npm run check:generated-artifacts` (CI) remains the authoritative
 * content-level guard.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectGeneratedArtifacts } from "../lib/automation-registry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function metadataFingerprint(paths: string[]): string {
  const hash = createHash("sha256");
  function visit(path: string) {
    const stats = existsSync(path) ? statSync(path) : undefined;
    hash.update(JSON.stringify([path, stats?.size, stats?.mtimeMs, stats?.ctimeMs]));
    if (stats?.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  }
  for (const path of [...paths].sort()) visit(path);
  return hash.digest("hex");
}

export async function refreshArtifactsIfChanged({ artifactPaths, inputPaths, cachePath, build }: {
  artifactPaths: string[];
  inputPaths: string[];
  cachePath: string;
  build: () => void | Promise<void>;
}): Promise<void> {
  const inputs = metadataFingerprint(inputPaths);
  const current = `${inputs}\n${metadataFingerprint(artifactPaths)}\n`;
  if (existsSync(cachePath) && readFileSync(cachePath, "utf8") === current) return;
  await build();
  mkdirSync(dirname(cachePath), { recursive: true });
  // ponytail: metadata catches normal edits/deletions; CI checks content when metadata is preserved.
  writeFileSync(cachePath, `${inputs}\n${metadataFingerprint(artifactPaths)}\n`);
}

export default async function ensureFreshStablecoinArtifacts(): Promise<void> {
  for (const artifact of selectGeneratedArtifacts({ only: ["stablecoin-client-registry"] })) {
    await refreshArtifactsIfChanged({
      artifactPaths: artifact.outputPaths.map((path: string) => join(REPO_ROOT, path)),
      inputPaths: [
        fileURLToPath(import.meta.url),
        ...globSync(artifact.sourcePaths, { cwd: REPO_ROOT })
          .map((path) => join(REPO_ROOT, path))
          .filter((path) => statSync(path).isFile()),
      ],
      cachePath: join(REPO_ROOT, ".cache/vitest-stablecoin-artifacts", `${artifact.id}.stamp`),
      build: async () => {
        if (artifact.id === "stablecoin-catalog") {
          const { syncGeneratedPerCoinAsset } = await import("../lib/stablecoin-catalog-sources");
          if (syncGeneratedPerCoinAsset({ rootDir: REPO_ROOT }).changed) {
            console.log("[vitest-setup] regenerated stale shared/data/stablecoins/coins.generated.json");
          }
        } else {
          execFileSync(process.execPath, [join(REPO_ROOT, artifact.script)], { cwd: REPO_ROOT, stdio: "pipe" });
          console.log("[vitest-setup] rebuilt stale stablecoin client registry artifacts");
        }
      },
    });
  }
}
