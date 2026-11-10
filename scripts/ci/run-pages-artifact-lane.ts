#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirectCli } from "../lib/cli-args.mjs";
import { PAGES_RELEASE_DATA_ARCHIVE, PAGES_RELEASE_DATA_PATHS, preparePagesReleaseData, overlayPagesReleaseData, replayPagesDetailSnapshots, type PagesReleaseDataAcquisitionResult } from "../lib/pages-release-data.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { DEPEG_LEDGER_CAPTURE_RELATIVE_PATH, depegLedgerCaptureId } from "../lib/depeg-ledger-capture.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PAGES_PREVIOUS_SITEMAP_URL = "https://stablecoin-dashboard.pages.dev/sitemap.xml";
const PUBLIC_FLAGS = ["HERO_VERDICT", "QUIET_DEVIATIONS", "MOBILE_STICKY_SUMMARY", "DEPEG_RESOLVER", "DEPEG_RESOLVER_REVIEWER"];
// prepare's history bootstrap owns these git-derived projections; the plain
// bootstrap pass owns every bootstrap-safe artifact.
const PREPARE_HISTORY_ARTIFACT_IDS = new Set(["sitemap-dates", "docs-metadata"]);
const COMPILE_INPUT_ARTIFACTS = (GENERATED_ARTIFACT_REGISTRY as {
  id: string;
  buildLifecycle: string;
  bootstrap?: boolean;
  bootstrapCommand?: string;
  outputPaths: string[];
  sourcePaths: string[];
}[]).filter((artifact) => artifact.buildLifecycle === "compile-input");

function isReleaseDataOverlaySource(path: string): boolean {
  return PAGES_RELEASE_DATA_PATHS.some((member) => path === member || path.startsWith(`${member}/`));
}

/**
 * compile-input artifacts a reused prepare workspace cannot already have
 * produced: non-bootstrap generators, bootstrap variants that differ from the
 * full command, and generators whose sources the release-data overlay rewrites
 * (the merged `public/_redirects` aliases).
 */
export function preparedWorkspaceCompileInputArtifacts(): string[] {
  return COMPILE_INPUT_ARTIFACTS
    .filter((artifact) => artifact.bootstrap !== true
      || artifact.bootstrapCommand !== undefined
      || artifact.sourcePaths.some(isReleaseDataOverlaySource))
    .filter((artifact) => !PREPARE_HISTORY_ARTIFACT_IDS.has(artifact.id))
    .map((artifact) => artifact.id)
    .sort();
}

/**
 * The reduced stage reruns the registry-derived set plus any artifact whose
 * output the transported workspace does not contain, so an incomplete
 * workspace adds work instead of leaving a missing build input.
 */
export function compileInputStageArtifacts(repoRoot: string): string[] {
  const required = new Set(preparedWorkspaceCompileInputArtifacts());
  return COMPILE_INPUT_ARTIFACTS
    .filter((artifact) => required.has(artifact.id)
      || artifact.outputPaths.some((output) => output.includes("*") || !existsSync(join(repoRoot, output))))
    .map((artifact) => artifact.id)
    .sort();
}

export function criticalCssScopeForLane(env: Partial<NodeJS.ProcessEnv>): "gates" | "all" {
  return env.PHAROS_CRITICAL_CSS_FULL_PASS === "false" ? "gates" : "all";
}

// Post-refresh outputs (including ignored public/llms.txt) are regenerated
// from the overlaid release data, so they are restored with the inputs: the
// lane must leave no edits behind in the candidate checkout.
const RESTORED_PATHS = [...new Set<string>([
  ...PAGES_RELEASE_DATA_PATHS,
  ...(GENERATED_ARTIFACT_REGISTRY as { buildLifecycle: string; outputPaths: string[] }[])
    .filter((artifact) => artifact.buildLifecycle === "post-refresh")
    .flatMap((artifact) => artifact.outputPaths),
])];

/**
 * A committed `/depeg/<slug>/` 301 is a reviewed archive retirement: the
 * shrink-approved sync drops the slug and the next release refresh never
 * restores it. Retained release data predates the retirement, so drop those
 * replayed entries (re-sealing the capture identity) instead of building pages
 * that link redirect sources.
 */
export function dropRetiredDepegEventEntries(repoRoot: string): string[] {
  const retired = new Set(readFileSync(join(repoRoot, "public/_redirects"), "utf8").split("\n")
    .map((line) => /^\/depeg\/([^/\s]+)\/?\s+\S+\s+301$/.exec(line.trim())?.[1])
    .filter((slug): slug is string => slug != null));
  if (retired.size === 0) return [];
  const dataDir = join(repoRoot, "data/depeg-events");
  const dropped = new Set<string>();
  let eventCount = 0;
  for (const name of readdirSync(dataDir).filter((file) => /^(\d{4}|index)\.json$/.test(file))) {
    const entries = JSON.parse(readFileSync(join(dataDir, name), "utf8")) as unknown;
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry: { slug?: string }) => !retired.has(entry.slug ?? ""));
    if (name !== "index.json") eventCount += kept.length;
    if (kept.length === entries.length) continue;
    for (const entry of entries as { slug?: string }[]) if (entry.slug && retired.has(entry.slug)) dropped.add(entry.slug);
    writeFileSync(join(dataDir, name), `${JSON.stringify(kept, null, 2)}\n`);
  }
  if (dropped.size > 0) {
    const capturePath = join(dataDir, DEPEG_LEDGER_CAPTURE_RELATIVE_PATH);
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
    writeFileSync(capturePath, `${JSON.stringify({ ...capture, captureId: depegLedgerCaptureId(dataDir), eventCount }, null, 2)}\n`);
  }
  return [...dropped].sort();
}

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
    // Never inherit a replay waiver for degraded data or offline rehearsal.
    PHAROS_PAGES_REPLAY: "",
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
    let retiredDepegSlugs: string[] = [];
    if (retained) {
      overlayPagesReleaseData(repoRoot, retained.archive, join(temporary, "overlay"), false);
      retiredDepegSlugs = dropRetiredDepegEventEntries(repoRoot);
      // Only validated trusted-main release data may waive wall-clock age.
      env.PHAROS_PAGES_REPLAY = "1";
    }
    report("## Pages artifact input provenance");
    report(`- Data status: \`${result.dataStatus}\``);
    if (retained) report(`- Release artifact: \`${retained.name}\``);
    if (retiredDepegSlugs.length > 0) report(`- Retired depeg slugs dropped from the replay: ${retiredDepegSlugs.length}`);
    if (!retained) report("- Reason: `pages-artifact-data-unavailable`; committed snapshots + offline detail bootstrap. All artifact gates remain required; empty detail lanes are weaker size evidence, not realistic release-data proof.");
    const criticalCssScope = criticalCssScopeForLane(process.env);
    report(`- Critical CSS: ${criticalCssScope === "gates" ? "gate-measured routes only" : "full public pass"}`);
    const reusePreparedWorkspace = process.env.PHAROS_PAGES_REUSE_PREPARED_WORKSPACE === "1";
    const reducedCompileInput = reusePreparedWorkspace ? compileInputStageArtifacts(repoRoot) : [];
    if (reducedCompileInput.length > 0) {
      report(`- Compile input: reused prepared workspace; reran ${reducedCompileInput.join(", ")}`);
      command("compile-input", process.execPath, [
        "--import", "tsx", "scripts/maintenance/run-generated-artifacts.ts", `--only=${reducedCompileInput.join(",")}`,
      ]);
    } else {
      command("compile-input", "npm", ["run", "generated:compile-input"]);
    }
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
    command("postbuild", "npm", ["run", "postbuild"], { PHAROS_CRITICAL_CSS_SCOPE: criticalCssScope });
    command("pages-release-artifact-gates", "npm", ["run", "check:pages-release"]);
    // Lighthouse is an explicit opt-in so the PR lane stays off the critical
    // path; nightly sets PHAROS_LIGHTHOUSE_ENFORCE (0 = advisory, 1 = blocking).
    const lighthouseEnforcement = process.env.PHAROS_LIGHTHOUSE_ENFORCE;
    if (lighthouseEnforcement === undefined) {
      report("- Lighthouse: skipped; this lane did not opt in (nightly sets PHAROS_LIGHTHOUSE_ENFORCE).");
    } else {
      // Ratcheted routes carry their own blocking threshold (measured nightly
      // p50 minus 10%, docs/testing.md#performance-guardrails); the others stay
      // advisory at the lane threshold until their variance allows a ratchet.
      const ratcheted: Record<string, string> = { "/depeg/": "65", "/safety-scores/": "67", "/stablecoins/": "81" };
      const lighthouseFailures: string[] = [];
      const blockingFailures: string[] = [];
      for (const route of ["/", "/stablecoin/usdc-circle/", "/depeg/", "/safety-scores/", "/stablecoins/"]) {
        try {
          command(`lighthouse ${route}`, "npm", ["run", "lighthouse:static", "--", "--route", route,
            "--threshold", ratcheted[route] ?? process.env.PHAROS_LIGHTHOUSE_THRESHOLD ?? "70", "--output-dir", ".tmp/lighthouse"]);
        } catch (error) {
          lighthouseFailures.push(String(error));
          if (route in ratcheted) blockingFailures.push(String(error));
        }
      }
      report(`- Lighthouse (${lighthouseEnforcement === "1" ? "blocking on ratcheted routes" : "advisory"}): ${
        lighthouseFailures.length ? lighthouseFailures.join("; ") : "all routes met the score threshold"
      }. Static-export scores do not measure production CSP/proxy or live-data readiness.`);
      if (lighthouseEnforcement === "1" && blockingFailures.length) {
        throw new Error(blockingFailures.join("; "));
      }
    }
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
