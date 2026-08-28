import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_DIR = join(__dirname, "../../src/data/changelogs");
const OUTPUT = join(CHANGELOG_DIR, "index.ts");
const CHECK_MODE = process.argv.includes("--check");
const SUPPORT_FILES = new Set(["index.ts", "types.ts"]);
const CHANGELOG_ENTRY_FILE_RE = /^(?<date>\d{4}-\d{2}-\d{2})\.ts$/;

function listChangelogFiles(): string[] {
  return readdirSync(CHANGELOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function isPotentialChangelogFile(fileName: string): boolean {
  return !SUPPORT_FILES.has(fileName) && (fileName.endsWith(".ts") || /^\d{4}/.test(fileName));
}

function isValidIsoDate(date: string): boolean {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

export function collectChangelogEntryFiles(fileNames: readonly string[] = listChangelogFiles()): string[] {
  const entryFiles = fileNames.filter(isPotentialChangelogFile);
  const dates = new Set<string>();

  for (const fileName of entryFiles) {
    const match = CHANGELOG_ENTRY_FILE_RE.exec(fileName);
    const date = match?.groups?.date;
    if (!date || !isValidIsoDate(date)) {
      throw new Error(
        `[changelog-registry] Malformed changelog entry filename "${fileName}"; expected a valid YYYY-MM-DD.ts filename.`,
      );
    }
    if (dates.has(date)) {
      throw new Error(`[changelog-registry] Duplicate changelog entry date "${date}".`);
    }
    dates.add(date);
  }

  return [...entryFiles].sort((left, right) => left.localeCompare(right));
}

function entryIdentifier(fileName: string): string {
  return `e${fileName.slice(0, -3).replaceAll("-", "")}`;
}

export function renderChangelogRegistry(fileNames: readonly string[] = listChangelogFiles()): string {
  const entryFiles = collectChangelogEntryFiles(fileNames);
  if (entryFiles.length === 0) {
    throw new Error("[changelog-registry] No dated changelog entry files found.");
  }

  const imports = entryFiles.map((fileName) => {
    const date = fileName.slice(0, -3);
    return `import { entry as ${entryIdentifier(fileName)} } from "./${date}";`;
  });
  const entries = entryFiles.map((fileName) => `  ${entryIdentifier(fileName)},`);

  return [
    'import type { ChangelogEntry } from "./types";',
    "",
    ...imports,
    "",
    "const all: ChangelogEntry[] = [",
    ...entries,
    "];",
    "",
    "export const changelogs: ChangelogEntry[] = all.sort(",
    "  (a, b) => b.dateRange.to.localeCompare(a.dateRange.to),",
    ");",
    "",
  ].join("\n");
}

function main(): void {
  syncGeneratedArtifacts({
    artifacts: [{ path: OUTPUT, contents: renderChangelogRegistry() }],
    check: CHECK_MODE,
    staleMessage:
      "src/data/changelogs/index.ts is out of date. Run `node --import tsx scripts/maintenance/generate-changelog-registry.ts`.",
    currentMessage: "Changelog registry is current",
    writtenMessage: "Generated changelog registry",
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
