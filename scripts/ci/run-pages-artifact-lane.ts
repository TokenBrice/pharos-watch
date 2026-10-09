#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirectCli } from "../lib/cli-args.mjs";
import { PAGES_RELEASE_DATA_ARCHIVE, PAGES_RELEASE_DATA_PATHS, preparePagesReleaseData, overlayPagesReleaseData, replayPagesDetailSnapshots, type PagesReleaseDataAcquisitionResult } from "../lib/pages-release-data.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PAGES_PREVIOUS_SITEMAP_URL = "https://stablecoin-dashboard.pages.dev/sitemap.xml";
const PUBLIC_FLAGS = ["HERO_VERDICT", "QUIET_DEVIATIONS", "MOBILE_STICKY_SUMMARY", "DEPEG_RESOLVER", "DEPEG_RESOLVER_REVIEWER"];
// Post-refresh outputs (tracked public/llms.txt among them) are regenerated
// from the overlaid release data, so they are restored with the inputs: the
// lane must leave no edits behind in the candidate checkout.
const RESTORED_PATHS = [...new Set<string>([
  ...PAGES_RELEASE_DATA_PATHS,
  ...(GENERATED_ARTIFACT_REGISTRY as { buildLifecycle: string; outputPaths: string[] }[])
    .filter((artifact) => artifact.buildLifecycle === "post-refresh")
    .flatMap((artifact) => artifact.outputPaths),
])];

export function scrubPagesBuildEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) =>
      !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i.test(name)
      && !name.startsWith("GH_") && !name.startsWith("CLOUDFLARE_") && !name.startsWith("WRANGLER_"),
    )),
    NODE_ENV: env.NODE_ENV ?? "production",
  };
}

export function pagesArtifactEnvironment(env: Partial<NodeJS.ProcessEnv>, previousSitemapUrl?: string): NodeJS.ProcessEnv {
  return {
    ...scrubPagesBuildEnvironment(env),
    NODE_ENV: "production",
    NEXT_PUBLIC_GA_ID: env.NEXT_PUBLIC_GA_ID ?? "",
    NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
    ...Object.fromEntries(PUBLIC_FLAGS.map((flag) => [`NEXT_PUBLIC_PHAROS_${flag}`, env[`NEXT_PUBLIC_PHAROS_${flag}`] ?? ""])),
    PHAROS_RELEASE_PR_TYPECHECKED: "1",
    PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "",
    PHAROS_DETAIL_SNAPSHOT_CHECK: "1",
    PUBLIC_DATASETS_API_URL: "",
    PUBLIC_DATASETS_API_KEY: "",
    PUBLIC_DATASETS_REQUIRE_API: "",
    SMOKE_API_BASE: "",
    API_BASE_URL: "",
    SEO_PREVIOUS_SITEMAP_URL: previousSitemapUrl ?? "",
  };
}

export interface PagesArtifactResult {
  dataStatus: "release-snapshot" | "degraded-data";
  artifactName?: string;
}

/** Production-profile export/gates without refresh, credentials, or publishing. */
export async function runPagesArtifactLane({ repoRoot = REPO_ROOT, acquireReleaseData: download = true, previousSitemapUrl, preserveTypecheck = false }: {
  repoRoot?: string;
  acquireReleaseData?: boolean;
  previousSitemapUrl?: string;
  preserveTypecheck?: boolean;
} = {}): Promise<PagesArtifactResult> {
  const temporary = mkdtempSync(join(tmpdir(), "pharos-pages-artifact-"));
  const env = pagesArtifactEnvironment(process.env, previousSitemapUrl);
  if (preserveTypecheck) env.PHAROS_RELEASE_PR_TYPECHECKED = "";
  const report = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const command = (stage: string, program: string, args: string[], overrides: Partial<NodeJS.ProcessEnv> = {}) => {
    console.log(`[pages-artifact] ${stage}: ${program} ${args.join(" ")}`);
    const result = spawnSync(program, args, { cwd: repoRoot, env: scrubPagesBuildEnvironment({ ...env, ...overrides }), stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`pages-artifact-stage-failed: ${stage} (${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`})`);
  };
  const originals = RESTORED_PATHS.filter((path) => existsSync(join(repoRoot, path)));
  let inputsBackedUp = false;
  try {
    for (const path of originals) {
      mkdirSync(dirname(join(temporary, "original", path)), { recursive: true });
      cpSync(join(repoRoot, path), join(temporary, "original", path), { recursive: true });
    }
    inputsBackedUp = true;
    let acquisition: PagesReleaseDataAcquisitionResult = { schemaVersion: 1, dataStatus: "degraded-data", reason: "pages-artifact-data-unavailable" };
    const acquisitionDirectory = process.env.PAGES_RELEASE_DATA_DIR ?? temporary;
    if (download) {
      if (process.env.PAGES_RELEASE_DATA_DIR) {
        acquisition = JSON.parse(readFileSync(join(acquisitionDirectory, "release-data-result.json"), "utf8")) as PagesReleaseDataAcquisitionResult;
        if (acquisition.schemaVersion !== 1 || !["release-snapshot", "degraded-data"].includes(acquisition.dataStatus)) {
          throw new Error("pages-artifact-data-invalid: invalid trusted acquisition result");
        }
      } else {
        acquisition = preparePagesReleaseData(acquisitionDirectory, repoRoot);
      }
    }
    const retained = acquisition.dataStatus === "release-snapshot"
      ? { archive: join(acquisitionDirectory, PAGES_RELEASE_DATA_ARCHIVE), name: acquisition.artifactName! }
      : undefined;
    const result: PagesArtifactResult = retained
      ? { dataStatus: "release-snapshot", artifactName: retained.name }
      : { dataStatus: "degraded-data" };
    if (retained) overlayPagesReleaseData(repoRoot, retained.archive, join(temporary, "overlay"), false);
    report("## Pages artifact input provenance");
    report(`- Data status: \`${result.dataStatus}\``);
    if (retained) report(`- Release artifact: \`${retained.name}\``);
    else report("- Reason: `pages-artifact-data-unavailable`; committed snapshots + offline detail bootstrap. All artifact gates remain required; empty detail lanes are weaker size evidence, not realistic release-data proof.");
    command("compile-input", "npm", ["run", "generated:compile-input"]);
    // This generator-owned bootstrap is always offline, before replay. It also
    // removes obsolete catalog envelopes and seeds newly added coins.
    command("detail-bootstrap", process.execPath, ["--import", "tsx", "scripts/build-data/build-stablecoin-detail-snapshots.ts"], {
      PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "1", PHAROS_DETAIL_SNAPSHOT_CHECK: "",
    });
    if (retained) replayPagesDetailSnapshots(repoRoot, join(temporary, "overlay"));
    command("post-refresh-replay", "npm", ["run", "generated:post-refresh"]);
    rmSync(join(repoRoot, ".next"), { recursive: true, force: true });
    rmSync(join(repoRoot, "out"), { recursive: true, force: true });
    command("webpack-export", "npx", ["--no-install", "next", "build", "--webpack"]);
    command("postbuild", "npm", ["run", "postbuild"]);
    command("pages-release-artifact-gates", "npm", ["run", "check:pages-release"]);
    return result;
  } finally {
    // A standalone local rehearsal must not leave release snapshots or their
    // derived outputs over the candidate's authored files, even on failure.
    if (inputsBackedUp) {
      for (const path of RESTORED_PATHS) {
        rmSync(join(repoRoot, path), { recursive: true, force: true });
        if (originals.includes(path)) cpSync(join(temporary, "original", path), join(repoRoot, path), { recursive: true });
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

runDirectCli(import.meta.url, () => runPagesArtifactLane().then(() => undefined), { label: "pages-artifact" });
