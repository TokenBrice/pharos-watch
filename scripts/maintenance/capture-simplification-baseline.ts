import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { VALIDATION_LANES } from "../lib/validation-lanes.mjs";
import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  ENDPOINT_DEFINITIONS,
  PUBLIC_API_ENDPOINT_DEFINITIONS,
  STATIC_ENDPOINT_ROUTE_DEFINITIONS,
} from "../../shared/lib/api-endpoints";
import { CRON_JOB_DEFINITIONS, CRON_SCHEDULES } from "../../shared/lib/cron-jobs";
import { SCHEDULED_TASK_DESCRIPTORS } from "../../shared/lib/scheduled-runner-registry";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PINNED_REF = "e668189409213f9977a2022ba12ffa15eb67a179";
export const BASELINE_PATH = "scripts/data/simplification-baseline.json";

export const CATEGORY_ORDER = [
  "generated",
  "migrations",
  "test-fixtures",
  "tests",
  "stablecoin-authored-data",
  "production-runtime",
  "tooling-scripts",
  "docs-guidance",
  "other-authored-static-data",
  "root-config-automation-static-text",
] as const;

export type BaselineCategory = (typeof CATEGORY_ORDER)[number];
export type Reproducibility = "deterministic" | "pinned-input" | "network-derived" | "mixed" | "unknown";

interface GeneratedPathRule {
  id: string;
  pattern: RegExp;
  reproducibility: Reproducibility;
}

type GeneratedBinaryPathRule = GeneratedPathRule;

/**
 * Generated paths are deliberately enumerated here instead of inferred from a
 * filename suffix. W1 needs a stable, reviewable manifest of all generated
 * surfaces, including registry output which does not uniformly use .generated.
 */
export const GENERATED_PATH_MANIFEST: readonly GeneratedPathRule[] = [
  {
    id: "stablecoin-projections",
    pattern: /^shared\/data\/stablecoins\/(?:coins(?:\.(?:client|compliance|telegram-mini-app))?\.generated\.json|coins\.prevalidated\.generated\.ts|legacy-llama-redirects\.generated\.json)$/,
    reproducibility: "deterministic",
  },
  { id: "case-study-client-index", pattern: /^src\/app\/learn\/case-studies\/content\/client-index\.ts$/, reproducibility: "deterministic" },
  { id: "docs-metadata", pattern: /^src\/generated\/docs-metadata\.json(?:\.d\.ts)?$/, reproducibility: "deterministic" },
  { id: "sitemap-dates", pattern: /^src\/generated\/sitemap-dates\.json(?:\.d\.ts)?$/, reproducibility: "deterministic" },
  { id: "depeg-event-related-data", pattern: /^src\/generated\/depeg-event-related-data\.json(?:\.d\.ts)?$/, reproducibility: "pinned-input" },
  { id: "depeg-event-search-data", pattern: /^src\/generated\/depeg-event-search-data\.json(?:\.d\.ts)?$/, reproducibility: "pinned-input" },
  { id: "homepage-bootstrap", pattern: /^src\/generated\/homepage-bootstrap\.json(?:\.d\.ts)?$/, reproducibility: "network-derived" },
  { id: "logo-variants", pattern: /^src\/lib\/logo-variants\.generated\.json$/, reproducibility: "deterministic" },
  { id: "public-datasets", pattern: /^public\/(?:datasets|sheets)\//, reproducibility: "network-derived" },
  { id: "remote-digests", pattern: /^data\/(?:digests|depeg-events)\.json$/, reproducibility: "network-derived" },
  { id: "logos-catalog", pattern: /^data\/logos\.json$/, reproducibility: "mixed" },
  { id: "openapi", pattern: /^public\/openapi\.json$/, reproducibility: "deterministic" },
  { id: "postman", pattern: /^public\/postman\/pharos-api\.postman_(?:collection|environment)\.json$/, reproducibility: "deterministic" },
  { id: "llms", pattern: /^public\/llms\.txt$/, reproducibility: "network-derived" },
  { id: "agent-code-map", pattern: /^docs\/agent-code-map\.md$/, reproducibility: "deterministic" },
  { id: "og-signatures", pattern: /^scripts\/maintenance\/state\/og-(?:case-study|editorial)-signatures\.json$/, reproducibility: "deterministic" },
  { id: "og-card-svg", pattern: /^public\/og-card\.svg$/, reproducibility: "deterministic" },
  { id: "world-countries-map", pattern: /^public\/maps\/world-countries\.svg$/, reproducibility: "deterministic" },
];

/** Generated binaries are inventoried separately so no binary bytes enter LOC metrics. */
export const GENERATED_BINARY_PATH_MANIFEST: readonly GeneratedBinaryPathRule[] = [
  { id: "compact-logos", pattern: /^public\/logos\/compact\/[^/]+\.webp$/, reproducibility: "deterministic" },
  { id: "og-images", pattern: /^public\/og-[^/]+\.png$/, reproducibility: "deterministic" },
];

const FIXTURE_PATH_PATTERN = /(?:^|\/)(?:__fixtures__|fixtures|fixture)(?:\/|$)/i;
const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__|test)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const STABLECOIN_DATA_PATTERN = /^shared\/data\/stablecoins\/(?:coins|domains)\//;
const RUNTIME_PATH_PATTERN = /^(?:src|worker\/src|functions|shared\/(?:lib|types))\//;
const TOOLING_PATH_PATTERN = /^(?:scripts|worker\/scripts|\.github\/(?:actions|scripts|workflows))\//;
const DOCS_PATH_PATTERN = /^(?:docs|agents)\/|^(?:AGENTS|CLAUDE|README)\.md$|^\.(?:claude|codex)\//;
const OTHER_AUTHORED_DATA_PATTERN = /^(?:data|shared\/data|src\/data|worker\/assets)\//;

export interface TrackedBlobEntry {
  path: string;
  sha: string;
  bytes: number;
  mode: string;
  type: string;
}

export interface ClassifiedFile {
  path: string;
  category: BaselineCategory;
  lines: number;
  bytes: number;
  sha: string;
  mode: string;
  symlinkTarget?: string;
  reproducibility?: Reproducibility;
}

export interface BinaryFile {
  path: string;
  bytes: number;
  sha: string;
  mode: string;
}

function runGit(args: string[], input?: string | Buffer): Buffer {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr?.toString("utf8") || "git command failed").trim());
  }
  return result.stdout;
}

function gitText(args: string[]): string {
  return runGit(args).toString("utf8").trim();
}

export function resolvePinnedRef(ref = process.env.PHAROS_SIMPLIFICATION_BASELINE_REF ?? PINNED_REF): string {
  return gitText(["rev-parse", `${ref}^{commit}`]);
}

function parseLsTree(output: Buffer): TrackedBlobEntry[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      if (tab === -1) throw new Error(`Unexpected git ls-tree record: ${record}`);
      const [mode, type, sha, size] = record.slice(0, tab).split(" ");
      if (!mode || !type || !sha || !size) throw new Error(`Incomplete git ls-tree record: ${record}`);
      return { path: record.slice(tab + 1), mode, type, sha, bytes: Number(size) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function listTrackedEntries(ref: string): TrackedBlobEntry[] {
  const output = runGit([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    `--format=%(objectmode) %(objecttype) %(objectname) %(objectsize)%x09%(path)`,
    ref,
  ]);
  const entries = parseLsTree(output);
  const nonBlobs = entries.filter((entry) => entry.type !== "blob");
  if (nonBlobs.length > 0) {
    throw new Error(`Pinned tree includes non-blob entries: ${nonBlobs.map((entry) => entry.path).join(", ")}`);
  }
  return entries;
}

function readGitBlobContents(entries: readonly TrackedBlobEntry[]): Map<string, Buffer> {
  const ids = [...new Set(entries.map((entry) => entry.sha))].sort();
  const output = runGit(["cat-file", "--batch"], `${ids.join("\n")}\n`);
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd === -1) throw new Error("Malformed git cat-file output header");
    const header = output.subarray(offset, lineEnd).toString("utf8").split(" ");
    const [sha, type, sizeText] = header;
    offset = lineEnd + 1;
    if (type !== "blob" || !sha || !sizeText) throw new Error(`Unexpected git cat-file object: ${header.join(" ")}`);
    const size = Number(sizeText);
    const body = output.subarray(offset, offset + size);
    if (body.length !== size) throw new Error(`Truncated git object ${sha}`);
    blobs.set(sha, body);
    offset += size;
    if (output[offset] !== 0x0a) throw new Error(`Missing separator after git object ${sha}`);
    offset += 1;
  }
  return blobs;
}

export function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

export function countPhysicalLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let newlines = 0;
  for (const byte of content) if (byte === 0x0a) newlines += 1;
  return newlines + (content[content.length - 1] === 0x0a ? 0 : 1);
}

export function generatedRuleForPath(path: string): GeneratedPathRule | undefined {
  return GENERATED_PATH_MANIFEST.find((rule) => rule.pattern.test(path));
}

export function generatedBinaryRuleForPath(path: string): GeneratedBinaryPathRule | undefined {
  return GENERATED_BINARY_PATH_MANIFEST.find((rule) => rule.pattern.test(path));
}

export function classifyPath(path: string): { category: BaselineCategory; reproducibility?: Reproducibility } {
  const generated = generatedRuleForPath(path);
  if (generated) return { category: "generated", reproducibility: generated.reproducibility };
  if (/^worker\/migrations\//.test(path)) return { category: "migrations" };
  if (FIXTURE_PATH_PATTERN.test(path)) return { category: "test-fixtures" };
  if (TEST_PATH_PATTERN.test(path)) return { category: "tests" };
  if (STABLECOIN_DATA_PATTERN.test(path)) return { category: "stablecoin-authored-data" };
  if (RUNTIME_PATH_PATTERN.test(path)) return { category: "production-runtime" };
  if (TOOLING_PATH_PATTERN.test(path)) return { category: "tooling-scripts" };
  if (DOCS_PATH_PATTERN.test(path)) return { category: "docs-guidance" };
  if (OTHER_AUTHORED_DATA_PATTERN.test(path)) return { category: "other-authored-static-data" };
  return { category: "root-config-automation-static-text" };
}

export function classifyTrackedEntries(entries: readonly TrackedBlobEntry[], blobs: ReadonlyMap<string, Buffer>): {
  files: ClassifiedFile[];
  binaryFiles: BinaryFile[];
} {
  const files: ClassifiedFile[] = [];
  const binaryFiles: BinaryFile[] = [];
  for (const entry of entries) {
    const content = blobs.get(entry.sha);
    if (!content) throw new Error(`Missing git blob ${entry.sha} for ${entry.path}`);
    if (isBinary(content)) {
      binaryFiles.push({ path: entry.path, bytes: entry.bytes, sha: entry.sha, mode: entry.mode });
      continue;
    }
    const classified = classifyPath(entry.path);
    files.push({
      path: entry.path,
      category: classified.category,
      lines: countPhysicalLines(content),
      bytes: entry.bytes,
      sha: entry.sha,
      mode: entry.mode,
      ...(entry.mode === "120000" ? { symlinkTarget: content.toString("utf8") } : {}),
      ...(classified.reproducibility ? { reproducibility: classified.reproducibility } : {}),
    });
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    binaryFiles: binaryFiles.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function aggregateFiles(files: readonly ClassifiedFile[]) {
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, { files: 0, lines: 0, bytes: 0 }])) as Record<
    BaselineCategory,
    { files: number; lines: number; bytes: number }
  >;
  for (const file of files) {
    const aggregate = categories[file.category];
    aggregate.files += 1;
    aggregate.lines += file.lines;
    aggregate.bytes += file.bytes;
  }
  const totals = files.reduce(
    (sum, file) => ({ files: sum.files + 1, lines: sum.lines + file.lines, bytes: sum.bytes + file.bytes }),
    { files: 0, lines: 0, bytes: 0 },
  );
  const authoredEngineering = (["production-runtime", "tests", "tooling-scripts"] as const).reduce(
    (sum, category) => ({
      files: sum.files + categories[category].files,
      lines: sum.lines + categories[category].lines,
      bytes: sum.bytes + categories[category].bytes,
    }),
    { files: 0, lines: 0, bytes: 0 },
  );
  return { categories, totals, authoredEngineering };
}

export function digestRecordSet(records: readonly string[]): string {
  return createHash("sha256").update([...records].sort().join("\n")).digest("hex");
}

function treeDigestRecord(entry: TrackedBlobEntry): string {
  return [entry.path, entry.mode, entry.type, entry.bytes, entry.sha].join("\t");
}

function textDigestRecord(file: ClassifiedFile): string {
  return [
    file.path,
    file.category,
    file.lines,
    file.bytes,
    file.sha,
    file.mode,
    file.symlinkTarget ?? "",
    file.reproducibility ?? "",
  ].join("\t");
}

function binaryDigestRecord(file: BinaryFile): string {
  return [file.path, file.bytes, file.sha, file.mode].join("\t");
}

function modeCounts(entries: readonly Pick<TrackedBlobEntry, "mode">[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.mode] = (counts[entry.mode] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function generatedInventory(files: readonly ClassifiedFile[]) {
  const generatedFiles = files.filter((file) => file.category === "generated");
  const ruleAggregates = new Map<string, {
    id: string;
    reproducibility: Reproducibility;
    files: number;
    lines: number;
    bytes: number;
    records: string[];
  }>();
  const reproducibilityAggregates = new Map<Reproducibility, { files: number; lines: number; bytes: number; records: string[] }>();

  for (const file of generatedFiles) {
    const rule = generatedRuleForPath(file.path);
    if (!rule || !file.reproducibility) throw new Error(`Generated path has no manifest rule: ${file.path}`);
    const record = textDigestRecord(file);
    const ruleAggregate = ruleAggregates.get(rule.id) ?? {
      id: rule.id,
      reproducibility: rule.reproducibility,
      files: 0,
      lines: 0,
      bytes: 0,
      records: [],
    };
    ruleAggregate.files += 1;
    ruleAggregate.lines += file.lines;
    ruleAggregate.bytes += file.bytes;
    ruleAggregate.records.push(record);
    ruleAggregates.set(rule.id, ruleAggregate);

    const reproducibilityAggregate = reproducibilityAggregates.get(file.reproducibility) ?? {
      files: 0,
      lines: 0,
      bytes: 0,
      records: [],
    };
    reproducibilityAggregate.files += 1;
    reproducibilityAggregate.lines += file.lines;
    reproducibilityAggregate.bytes += file.bytes;
    reproducibilityAggregate.records.push(record);
    reproducibilityAggregates.set(file.reproducibility, reproducibilityAggregate);
  }

  return {
    files: generatedFiles.length,
    lines: generatedFiles.reduce((total, file) => total + file.lines, 0),
    bytes: generatedFiles.reduce((total, file) => total + file.bytes, 0),
    sha256: digestRecordSet(generatedFiles.map(textDigestRecord)),
    byRule: [...ruleAggregates.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ records, ...aggregate }) => ({ ...aggregate, sha256: digestRecordSet(records) })),
    byReproducibility: (["deterministic", "pinned-input", "network-derived", "mixed", "unknown"] as const).map((reproducibility) => {
      const aggregate = reproducibilityAggregates.get(reproducibility) ?? { files: 0, lines: 0, bytes: 0, records: [] };
      return { reproducibility, files: aggregate.files, lines: aggregate.lines, bytes: aggregate.bytes, sha256: digestRecordSet(aggregate.records) };
    }),
    paths: generatedFiles.map((file) => ({
      path: file.path,
      rule: generatedRuleForPath(file.path)?.id,
      reproducibility: file.reproducibility,
      lines: file.lines,
      bytes: file.bytes,
      sha: file.sha,
      mode: file.mode,
    })),
  };
}

function generatedBinaryInventory(entries: readonly TrackedBlobEntry[], binaryFiles: readonly BinaryFile[]) {
  const binaryPaths = new Set(binaryFiles.map((file) => file.path));
  const generatedFiles = entries.filter((entry) => generatedBinaryRuleForPath(entry.path));
  const ruleAggregates = new Map<string, {
    id: string;
    reproducibility: Reproducibility;
    files: number;
    bytes: number;
    records: string[];
  }>();

  for (const file of generatedFiles) {
    const rule = generatedBinaryRuleForPath(file.path);
    if (!rule) throw new Error(`Generated binary path has no manifest rule: ${file.path}`);
    const aggregate = ruleAggregates.get(rule.id) ?? {
      id: rule.id,
      reproducibility: rule.reproducibility,
      files: 0,
      bytes: 0,
      records: [],
    };
    aggregate.files += 1;
    aggregate.bytes += file.bytes;
    aggregate.records.push(binaryDigestRecord(file));
    ruleAggregates.set(rule.id, aggregate);
  }

  return {
    binaryRule: "Generated binary artifacts are excluded from text LOC and tracked separately from all binary exclusions.",
    files: generatedFiles.length,
    binaryBackedFiles: generatedFiles.filter((file) => binaryPaths.has(file.path)).length,
    textBackedFiles: generatedFiles.filter((file) => !binaryPaths.has(file.path)).length,
    bytes: generatedFiles.reduce((total, file) => total + file.bytes, 0),
    sha256: digestRecordSet(generatedFiles.map(binaryDigestRecord)),
    byRule: [...ruleAggregates.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ records, ...aggregate }) => ({ ...aggregate, sha256: digestRecordSet(records) })),
    paths: generatedFiles.map((file) => file.path).sort(),
  };
}

function contentForPath(entries: readonly TrackedBlobEntry[], blobs: ReadonlyMap<string, Buffer>, path: string): Buffer {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Pinned tree is missing ${path}`);
  const content = blobs.get(entry.sha);
  if (!content) throw new Error(`Missing blob for ${path}`);
  return content;
}

function entryHash(entries: readonly TrackedBlobEntry[], path: string): string {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Pinned tree is missing source path ${path}`);
  return entry.sha;
}

function countStaticRedirects(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length;
}

function validationPhaseCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const lane of VALIDATION_LANES) {
    for (const leaf of lane.leaves) {
      counts[leaf.phase] = (counts[leaf.phase] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function indexedPathCount(): { total: number; modes: Record<string, number> } {
  const output = runGit(["ls-files", "--stage", "-z"]);
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const modes: Record<string, number> = {};
  for (const record of records) {
    const mode = record.split(" ", 1)[0];
    if (!mode) throw new Error(`Malformed git index record: ${record}`);
    modes[mode] = (modes[mode] ?? 0) + 1;
  }
  return { total: records.length, modes: Object.fromEntries(Object.entries(modes).sort(([a], [b]) => a.localeCompare(b))) };
}

async function collectMigrationInventory() {
  const validationProgram = [
    "import { validateWorkerMigrations } from './scripts/ci/check-worker-migrations.mjs';",
    "const result = await validateWorkerMigrations({ includeSchemaFingerprint: true });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const validationOutput = execFileSync("node", ["--input-type=module", "--eval", validationProgram], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const migrationResult = JSON.parse(validationOutput) as {
    migrationCount: number;
    manifestParity: { activeManifestCount: number; retiredManifestCount: number };
    schemaFingerprint: { algorithm: string; value: string; schemaRowCount: number } | null;
  };
  const migrationDir = resolve(REPO_ROOT, "worker/migrations");
  const { DatabaseSync } = await import("node:sqlite");
  const databaseDir = resolve(REPO_ROOT, ".tmp");
  mkdirSync(databaseDir, { recursive: true });
  const databasePath = join(databaseDir, `simplification-baseline-${process.pid}.db`);
  // The validation helper above establishes replay compatibility. This query only
  // counts the resulting SQLite schema object types for the baseline inventory.
  try {
    const database = new DatabaseSync(databasePath);
    try {
      for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
        database.exec(readFileSync(join(migrationDir, file), "utf8"));
      }
      const rows = database.prepare(
        "SELECT type, COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type",
      ).all() as Array<{ type: string; count: number }>;
      const objectCounts = Object.fromEntries(rows.map((row) => [row.type, Number(row.count)]));
      return {
        migrationFiles: migrationResult.migrationCount,
        manifest: {
          active: migrationResult.manifestParity.activeManifestCount,
          retired: migrationResult.manifestParity.retiredManifestCount,
        },
        schema: {
          fingerprint: migrationResult.schemaFingerprint,
          tables: objectCounts.table ?? 0,
          indexes: objectCounts.index ?? 0,
          triggers: objectCounts.trigger ?? 0,
          views: objectCounts.view ?? 0,
        },
      };
    } finally {
      database.close();
    }
  } finally {
    rmSync(databasePath, { force: true });
  }
}

function directoryStats(path: string): { files: number; bytes: number } {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const visit = (current: string) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) visit(join(current, name));
      return;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
    }
  };
  visit(path);
  return { files, bytes };
}

function ignoredBuildOutputInventory() {
  const paths = [".next", "out", "coverage", "output"];
  return Object.fromEntries(paths.map((path) => [path, directoryStats(resolve(REPO_ROOT, path))]));
}

function sourcePaths(entries: readonly TrackedBlobEntry[]) {
  const paths = [
    "scripts/lib/automation-registry.mjs",
    "scripts/lib/validation-command-registry.mjs",
    "scripts/ci/check-worker-migrations.mjs",
    "shared/lib/api-endpoints/definitions.ts",
    "shared/lib/api-endpoints/dynamic.ts",
    "shared/lib/cron-jobs.ts",
    "shared/lib/scheduled-runner-registry.ts",
    "public/_redirects",
    "shared/data/stablecoins/legacy-llama-redirects.generated.json",
    "package.json",
  ];
  return paths.map((path) => ({ path, sha: entryHash(entries, path) }));
}

function registryFilenameInventory(files: readonly ClassifiedFile[]) {
  const registryFiles = files.filter((file) => /(?:^|\/)[^/]*registr(?:y|ies)[^/]*\.[^/]+$/i.test(file.path));
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<BaselineCategory, number>;
  for (const file of registryFiles) categories[file.category] += 1;
  return {
    filenameBased: true,
    count: registryFiles.length,
    categories,
    paths: registryFiles.map((file) => file.path),
  };
}

export async function captureBaseline({ ref = resolvePinnedRef() }: { ref?: string } = {}) {
  const resolvedRef = resolvePinnedRef(ref);
  const head = resolvePinnedRef("HEAD");
  if (resolvedRef !== head) {
    throw new Error(
      `Baseline capture requires the pinned ref to be checked out so registry inventories are revision-consistent (requested ${resolvedRef}, HEAD ${head}).`,
    );
  }
  const entries = listTrackedEntries(resolvedRef);
  const blobs = readGitBlobContents(entries);
  const { files, binaryFiles } = classifyTrackedEntries(entries, blobs);
  const textAggregates = aggregateFiles(files);
  const packageJson = JSON.parse(contentForPath(entries, blobs, "package.json").toString("utf8")) as { scripts?: Record<string, string> };
  const scripts = Object.keys(packageJson.scripts ?? {}).sort();
  const legacyRedirects = JSON.parse(
    contentForPath(entries, blobs, "shared/data/stablecoins/legacy-llama-redirects.generated.json").toString("utf8"),
  ) as Record<string, string>;
  const appRouteModules = entries
    .filter((entry) => {
      if (!entry.path.startsWith("src/app/")) return false;
      const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      return ["page.ts", "page.tsx", "route.ts", "route.tsx"].includes(fileName);
    })
    .map((entry) => entry.path)
    .sort();
  const pageModules = appRouteModules.filter((path) => /(?:^|\/)page\.tsx?$/.test(path));
  const routeModules = appRouteModules.filter((path) => /(?:^|\/)route\.tsx?$/.test(path));
  const routeClientModules = entries
    .filter((entry) => entry.path.startsWith("src/app/") && entry.path.endsWith("/client.tsx"))
    .map((entry) => entry.path)
    .sort();
  const indexInventory = indexedPathCount();
  const migrationInventory = await collectMigrationInventory();

  return {
    schemaVersion: 1,
    pinnedRef: resolvedRef,
    classification: {
      precedence: CATEGORY_ORDER,
      generatedPathManifest: GENERATED_PATH_MANIFEST.map(({ id, pattern, reproducibility }) => ({
        id,
        pattern: pattern.source,
        reproducibility,
      })),
      generatedBinaryPathManifest: GENERATED_BINARY_PATH_MANIFEST.map(({ id, pattern, reproducibility }) => ({
        id,
        pattern: pattern.source,
        reproducibility,
      })),
      binaryRule: "A tracked blob containing a NUL byte is excluded from text metrics.",
      lineRule: "Physical lines are LF delimiters plus one non-empty unterminated final line.",
    },
    trackedInventory: {
      gitLsTreePaths: entries.length,
      gitLsTreeModes: modeCounts(entries),
      symlinks: entries.filter((entry) => entry.mode === "120000").length,
      binary: {
        files: binaryFiles.length,
        bytes: binaryFiles.reduce((total, file) => total + file.bytes, 0),
        sha256: digestRecordSet(binaryFiles.map(binaryDigestRecord)),
      },
      text: textAggregates,
      generated: generatedInventory(files),
      generatedBinary: generatedBinaryInventory(entries, binaryFiles),
      digests: {
        fullTreeSha256: digestRecordSet(entries.map(treeDigestRecord)),
        textSha256: digestRecordSet(files.map(textDigestRecord)),
        categories: Object.fromEntries(
          CATEGORY_ORDER.map((category) => [
            category,
            digestRecordSet(files.filter((file) => file.category === category).map(textDigestRecord)),
          ]),
        ),
      },
    },
    surfaces: {
      appRoutes: {
        pageModules: pageModules.length,
        routeModules: routeModules.length,
        routeClientModules: routeClientModules.length,
        total: appRouteModules.length,
        paths: appRouteModules,
        clientPaths: routeClientModules,
      },
      redirects: {
        staticRules: countStaticRedirects(contentForPath(entries, blobs, "public/_redirects").toString("utf8")),
        legacyStablecoinMappings: Object.keys(legacyRedirects).length,
      },
      api: {
        endpointDefinitions: ENDPOINT_DEFINITIONS.length,
        staticRouteDefinitions: STATIC_ENDPOINT_ROUTE_DEFINITIONS.length,
        dynamicDescriptors: DYNAMIC_ENDPOINT_DESCRIPTORS.length,
        publicApiDefinitions: PUBLIC_API_ENDPOINT_DEFINITIONS.length,
      },
      cron: {
        jobs: CRON_JOB_DEFINITIONS.length,
        schedules: Object.keys(CRON_SCHEDULES).length,
        tasks: SCHEDULED_TASK_DESCRIPTORS.length,
      },
      npm: {
        scripts: scripts.length,
        checkScripts: scripts.filter((script) => script.startsWith("check:")).length,
      },
      validation: {
        lanes: VALIDATION_LANES.length,
        leaves: VALIDATION_LANES.flatMap((lane) => lane.leaves).length,
        phases: validationPhaseCounts(),
      },
      generatedArtifacts: {
        registryCount: GENERATED_ARTIFACT_REGISTRY.length,
        ids: GENERATED_ARTIFACT_REGISTRY.map((artifact) => artifact.id).sort(),
      },
      migrations: migrationInventory,
      registries: registryFilenameInventory(files),
      authoritativeSources: sourcePaths(entries),
    },
    source: {
      paths: sourcePaths(entries),
      hashes: {
        classificationScript: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      },
    },
    // These are intentionally not compared by --check: local build products and
    // executable versions document the capture environment, not repository state.
    observational: {
      workingIndex: {
        paths: indexInventory.total,
        modes: indexInventory.modes,
        reconciliation: entries.length === indexInventory.total ? "matched" : "mismatch",
      },
      toolVersions: {
        git: execFileSync("git", ["--version"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
        node: process.version,
      },
      ignoredBuildOutputs: ignoredBuildOutputInventory(),
    },
  };
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function comparableSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const { observational: _observational, surfaces: _surfaces, source, ...stable } = snapshot;
  if (source == null || typeof source !== "object" || Array.isArray(source)) return stable;
  const { hashes: _hashes, ...stableSource } = source as Record<string, unknown>;
  return { ...stable, source: stableSource };
}

export function snapshotsMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableStringify(comparableSnapshot(left)) === stableStringify(comparableSnapshot(right));
}

async function main() {
  const ref = resolvePinnedRef();
  const snapshot = await captureBaseline({ ref });
  const outputPath = resolve(REPO_ROOT, process.env.PHAROS_SIMPLIFICATION_BASELINE_OUTPUT ?? BASELINE_PATH);
  const check = process.env.PHAROS_SIMPLIFICATION_BASELINE_CHECK === "1";
  if (check) {
    if (!existsSync(outputPath)) throw new Error(`Baseline snapshot is missing: ${relative(REPO_ROOT, outputPath)}`);
    const expected = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    if (!snapshotsMatch(expected, snapshot)) {
      throw new Error(`Baseline snapshot differs: ${relative(REPO_ROOT, outputPath)}`);
    }
    console.log(`Simplification baseline matches ${relative(REPO_ROOT, outputPath)}.`);
    return;
  }
  const { writeFileSync } = await import("node:fs");
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, stableStringify(snapshot));
  console.log(`Wrote simplification baseline to ${relative(REPO_ROOT, outputPath)}.`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
