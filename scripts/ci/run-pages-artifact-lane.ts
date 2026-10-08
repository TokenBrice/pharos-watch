#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirectCli } from "../lib/cli-args.mjs";
import { PAGES_RELEASE_DATA_ARCHIVE, PAGES_RELEASE_DATA_PATHS, overlayPagesReleaseData, replayPagesDetailSnapshots } from "../lib/pages-release-data.mts";

const REPOSITORY = "TokenBrice/pharos-watch";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PAGES_PREVIOUS_SITEMAP_URL = "https://stablecoin-dashboard.pages.dev/sitemap.xml";
const PUBLIC_FLAGS = ["HERO_VERDICT", "QUIET_DEVIATIONS", "MOBILE_STICKY_SUMMARY", "DEPEG_RESOLVER", "DEPEG_RESOLVER_REVIEWER"];

export function pagesArtifactEnvironment(env: Partial<NodeJS.ProcessEnv>, previousSitemapUrl?: string): NodeJS.ProcessEnv {
  return {
    ...env,
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

interface ReleaseArtifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; head_branch: string; head_sha: string };
}
interface ReleaseRun { conclusion: string; head_branch: string; head_sha: string; path: string }

export function selectPagesReleaseArtifacts(artifacts: readonly ReleaseArtifact[]): ReleaseArtifact[] {
  return artifacts.filter((artifact) => !artifact.expired && artifact.workflow_run?.head_branch === "main"
    && artifact.name === `pages-release-data-${artifact.workflow_run.head_sha}`
    && /^[a-f0-9]{40}$/.test(artifact.workflow_run.head_sha))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

interface AcquiredReleaseData { archive: string; name: string }

function acquireReleaseData(directory: string, repoRoot: string): AcquiredReleaseData | undefined {
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
  // No ambient repo inference: forks still replay only successful trusted-main
  // release data. Every GitHub operation below is GET-only.
  const pages = JSON.parse(gh(["api", "--method", "GET", "--paginate", "--slurp", `repos/${REPOSITORY}/actions/artifacts?per_page=100`]).toString()) as { artifacts: ReleaseArtifact[] }[];
  for (const artifact of selectPagesReleaseArtifacts(pages.flatMap((page) => page.artifacts))) {
    const run = JSON.parse(gh(["api", "--method", "GET", `repos/${REPOSITORY}/actions/runs/${artifact.workflow_run!.id}`]).toString()) as ReleaseRun;
    if (run.conclusion !== "success" || run.head_branch !== "main" || run.head_sha !== artifact.workflow_run!.head_sha
      || ![".github/workflows/deploy-cloudflare.yml", ".github/workflows/rebuild-pages.yml"].includes(run.path)) continue;
    const zip = join(directory, "release-data.zip");
    writeFileSync(zip, gh(["api", "--method", "GET", `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`]));
    const members = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
    if (members.length !== 1 || members[0] !== PAGES_RELEASE_DATA_ARCHIVE) throw new Error("pages-artifact-data-invalid: unexpected artifact contents");
    const archive = join(directory, PAGES_RELEASE_DATA_ARCHIVE);
    writeFileSync(archive, execFileSync("unzip", ["-p", zip, PAGES_RELEASE_DATA_ARCHIVE], { maxBuffer: 128 * 1024 * 1024 }));
    return { archive, name: artifact.name };
  }
  return undefined;
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
    const result = spawnSync(program, args, { cwd: repoRoot, env: { ...env, ...overrides }, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`pages-artifact-stage-failed: ${stage} (${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`})`);
  };
  const originals = PAGES_RELEASE_DATA_PATHS.filter((path) => existsSync(join(repoRoot, path)));
  let inputsBackedUp = false;
  try {
    for (const path of originals) {
      mkdirSync(dirname(join(temporary, "original", path)), { recursive: true });
      cpSync(join(repoRoot, path), join(temporary, "original", path), { recursive: true });
    }
    inputsBackedUp = true;
    let retained: AcquiredReleaseData | undefined;
    if (download) {
      try { retained = acquireReleaseData(temporary, repoRoot); }
      catch (error) {
        // Setup/auth/API availability has a defined weaker-input fallback; an
        // invalid downloaded artifact is not an unavailable-data condition.
        if (error instanceof Error && error.message.startsWith("pages-artifact-data-invalid:")) throw error;
        report("- Data acquisition: `pages-artifact-data-unavailable` (GitHub CLI/auth/API/download unavailable)");
      }
    }
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
    // A standalone local rehearsal must not leave release snapshots staged over
    // the candidate's authored inputs, even when a build/gate fails.
    if (inputsBackedUp) {
      for (const path of PAGES_RELEASE_DATA_PATHS) {
        rmSync(join(repoRoot, path), { recursive: true, force: true });
        if (originals.includes(path)) cpSync(join(temporary, "original", path), join(repoRoot, path), { recursive: true });
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

runDirectCli(import.meta.url, () => runPagesArtifactLane().then(() => undefined), { label: "pages-artifact" });
