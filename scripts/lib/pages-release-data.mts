import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PAGES_RELEASE_DATA_PATHS = [
  "data/digests.json",
  "data/depeg-events",
  "public/datasets",
  "public/_redirects",
  "src/lib/datasets/public-dataset-current.ts",
  "src/generated/stablecoin-detail-snapshots",
] as const;

/** Server-only outputs rebuilt from candidate code after public input replay. */
export const PAGES_RELEASE_DERIVED_DATA_PATHS = [
  "src/generated/social-preview-images.json",
] as const;
export const PAGES_RELEASE_BUILD_ID_EXCLUSIONS = [
  ...PAGES_RELEASE_DATA_PATHS,
  ...PAGES_RELEASE_DERIVED_DATA_PATHS,
] as const;
export const PAGES_RELEASE_DATA_ARCHIVE = "pages-release-data.tar.zst";
const REPOSITORY = "TokenBrice/pharos-watch";
const DATASET_ALIAS_START = "# BEGIN GENERATED PUBLIC DATASET ALIASES";
const DATASET_ALIAS_END = "# END GENERATED PUBLIC DATASET ALIASES";

/** Explicit public inputs only: never archive a workspace, .env, or credentials. */
export function createPagesReleaseDataArchive(repoRoot: string, archivePath: string): void {
  const validate = (path: string) => {
    const stat = lstatSync(join(repoRoot, path));
    if (!isPagesReleaseDataMember(path) || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`pages-artifact-data-invalid: refusing to archive ${path}`);
    }
    if (stat.isDirectory()) for (const file of readdirSync(join(repoRoot, path))) validate(`${path}/${file}`);
  };
  for (const path of PAGES_RELEASE_DATA_PATHS) validate(path);
  mkdirSync(dirname(archivePath), { recursive: true });
  execFileSync("tar", ["--use-compress-program=zstd -T0 -3", "-cf", archivePath, ...PAGES_RELEASE_DATA_PATHS], { cwd: repoRoot, stdio: "inherit" });
}

export function isPagesReleaseDataMember(member: string): boolean {
  const path = member.replace(/\/$/, "");
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  if (PAGES_RELEASE_DATA_PATHS.includes(path as typeof PAGES_RELEASE_DATA_PATHS[number])) return true;
  if (path.startsWith("public/datasets/")) {
    const parts = path.split("/");
    if (parts.length === 3) return /^[a-z0-9-]+$/.test(parts[2]) || /^[a-z0-9-]+\.(?:json|csv|ndjson)$/.test(parts[2]);
    return parts.length === 4 && /^[a-z0-9-]+$/.test(parts[2])
      && /^\d{4}-\d{2}-\d{2}\.(?:json|csv|ndjson)$/.test(parts[3]);
  }
  return /^data\/depeg-events\/(?:index|\d{4})\.json$/.test(path)
    || path === "data/depeg-events/metadata"
    || path === "data/depeg-events/metadata/capture.json"
    || /^src\/generated\/stablecoin-detail-snapshots\/[a-z0-9-]+\.json$/.test(path);
}

export function mergeDatasetAliases(candidate: string, snapshot: string): string {
  const block = (text: string): [number, number] => {
    const start = text.indexOf(DATASET_ALIAS_START);
    const end = text.indexOf(DATASET_ALIAS_END, start);
    if (start < 0 || end < start) throw new Error("pages-artifact-data-invalid: missing public dataset alias block");
    return [start, end + DATASET_ALIAS_END.length];
  };
  const [start, end] = block(candidate);
  const [snapshotStart, snapshotEnd] = block(snapshot);
  return candidate.slice(0, start) + snapshot.slice(snapshotStart, snapshotEnd) + candidate.slice(end);
}

export function replayPagesDetailSnapshots(repoRoot: string, staging: string): void {
  const path = "src/generated/stablecoin-detail-snapshots";
  // Bootstrap enumerates the candidate catalog first. New coins keep explicit
  // empty envelopes; removed coins must not re-enter from the old release.
  for (const file of readdirSync(join(repoRoot, path))) {
    const source = join(staging, path, file);
    if (existsSync(source)) cpSync(source, join(repoRoot, path, file));
  }
}

export function validatePagesReleaseDataArchive(archivePath: string): void {
  const members = execFileSync("tar", ["--zstd", "-tf", archivePath], { encoding: "utf8" }).trim().split("\n");
  if (members.some((member) => !isPagesReleaseDataMember(member))) throw new Error("pages-artifact-data-invalid: unexpected archive path");
  const types = execFileSync("tar", ["--zstd", "-tvf", archivePath], { encoding: "utf8" }).trim().split("\n");
  if (types.some((entry) => !["-", "d"].includes(entry[0]))) throw new Error("pages-artifact-data-invalid: archive links are forbidden");
  for (const path of PAGES_RELEASE_DATA_PATHS) {
    if (!members.some((member) => member.replace(/\/$/, "") === path)) throw new Error(`pages-artifact-data-invalid: missing ${path}`);
  }
}

export function overlayPagesReleaseData(repoRoot: string, archivePath: string, staging: string, replayDetails = true): void {
  validatePagesReleaseDataArchive(archivePath);
  mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["--zstd", "-xf", archivePath, "--no-same-owner", "-C", staging]);
  for (const path of PAGES_RELEASE_DATA_PATHS) {
    if (!existsSync(join(staging, path))) throw new Error(`pages-artifact-data-invalid: missing ${path}`);
    if (path === "public/_redirects") {
      writeFileSync(join(repoRoot, path), mergeDatasetAliases(readFileSync(join(repoRoot, path), "utf8"), readFileSync(join(staging, path), "utf8")));
    } else if (path === "src/generated/stablecoin-detail-snapshots") {
      if (replayDetails) replayPagesDetailSnapshots(repoRoot, staging);
    } else {
      cpSync(join(staging, path), join(repoRoot, path), { recursive: true });
    }
  }
}

const TRUSTED_WORKFLOW_FILES = ["deploy-cloudflare.yml", "rebuild-pages.yml"] as const;
const TRUSTED_WORKFLOW_PATHS: readonly string[] = TRUSTED_WORKFLOW_FILES.map((file) => `.github/workflows/${file}`);
const TRUSTED_EVENTS: readonly string[] = ["push", "schedule", "workflow_dispatch"];

interface ReleaseArtifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; head_branch: string; head_sha: string; head_repository_id: number; repository_id: number };
}
interface ReleaseRun {
  id: number;
  status: string;
  conclusion: string;
  head_branch: string;
  head_sha: string;
  path: string;
  event: string;
  created_at: string;
  updated_at?: string;
  head_repository?: { full_name: string };
}

export function selectPagesReleaseArtifacts(artifacts: readonly ReleaseArtifact[]): ReleaseArtifact[] {
  return artifacts.filter((artifact) => Number.isSafeInteger(artifact.id) && artifact.id > 0
    && !artifact.expired && artifact.workflow_run?.head_branch === "main"
    && artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id
    && artifact.name === `pages-release-data-${artifact.workflow_run.head_sha}`
    && /^[a-f0-9]{40}$/.test(artifact.workflow_run.head_sha))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function selectPagesReleaseRuns(runs: readonly ReleaseRun[]): ReleaseRun[] {
  const seen = new Set<number>();
  return runs.filter((run) => {
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || seen.has(run.id)) return false;
    if (run.status !== "completed" || run.conclusion !== "success" || run.head_branch !== "main"
      || !/^[a-f0-9]{40}$/.test(run.head_sha) || !TRUSTED_EVENTS.includes(run.event)
      || run.head_repository?.full_name !== REPOSITORY || !TRUSTED_WORKFLOW_PATHS.includes(run.path)) return false;
    seen.add(run.id);
    return true;
  }).sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
    || b.id - a.id,
  );
}

interface AcquiredReleaseData { archive: string; name: string }

function acquireReleaseData(directory: string, repoRoot: string): AcquiredReleaseData | undefined {
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
  // No ambient repo inference: forks still replay only successful trusted-main
  // release data. Every GitHub operation below is GET-only.
  const runs: ReleaseRun[] = [];
  let succeededWorkflows = 0;
  let lastWorkflowError: unknown;
  for (const workflow of TRUSTED_WORKFLOW_FILES) {
    try {
      const response = JSON.parse(
        gh(["api", "--method", "GET", `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=30`]).toString(),
      ) as { workflow_runs?: ReleaseRun[] };
      succeededWorkflows += 1;
      if (Array.isArray(response.workflow_runs)) runs.push(...response.workflow_runs);
    } catch (error) {
      lastWorkflowError = error;
    }
  }
  if (succeededWorkflows === 0 && lastWorkflowError) throw lastWorkflowError;
  for (const run of selectPagesReleaseRuns(runs)) {
    const expectedName = `pages-release-data-${run.head_sha}`;
    const response = JSON.parse(
      gh(["api", "--method", "GET", `repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?name=${expectedName}&per_page=100`]).toString(),
    ) as { artifacts?: ReleaseArtifact[] };
    const artifact = selectPagesReleaseArtifacts(Array.isArray(response.artifacts) ? response.artifacts : [])
      .find((candidate) => candidate.workflow_run?.id === run.id && candidate.workflow_run?.head_sha === run.head_sha);
    if (!artifact) continue;
    const zip = join(directory, "release-data.zip");
    writeFileSync(zip, gh(["api", "--method", "GET", `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`]));
    const members = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
    if (members.length !== 1 || members[0] !== PAGES_RELEASE_DATA_ARCHIVE) throw new Error("pages-artifact-data-invalid: unexpected artifact contents");
    const archive = join(directory, PAGES_RELEASE_DATA_ARCHIVE);
    writeFileSync(archive, execFileSync("unzip", ["-p", zip, PAGES_RELEASE_DATA_ARCHIVE], { maxBuffer: 128 * 1024 * 1024 }));
    validatePagesReleaseDataArchive(archive);
    return { archive, name: artifact.name };
  }
  return undefined;
}

export interface PagesReleaseDataAcquisitionResult {
  schemaVersion: 1;
  dataStatus: "release-snapshot" | "degraded-data";
  artifactName?: string;
  reason?: "pages-artifact-data-unavailable";
}

/** Dependency-free acquisition owner, snapshotted from the trusted PR base. */
export function preparePagesReleaseData(directory: string, repoRoot: string): PagesReleaseDataAcquisitionResult {
  mkdirSync(directory, { recursive: true });
  let result: PagesReleaseDataAcquisitionResult = { schemaVersion: 1, dataStatus: "degraded-data", reason: "pages-artifact-data-unavailable" };
  try {
    const retained = acquireReleaseData(directory, repoRoot);
    if (retained) result = { schemaVersion: 1, dataStatus: "release-snapshot", artifactName: retained.name };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pages-artifact-data-invalid:")) throw error;
    // Unavailable gh/auth/API has the same explicit fallback locally and in CI.
    // Never print the underlying command error: it can include credentials.
  }
  writeFileSync(join(directory, "release-data-result.json"), `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify(result));
  return result;
}
