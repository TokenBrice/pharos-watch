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
