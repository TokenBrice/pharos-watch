import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { splitNullDelimited } from "./changed-files.mts";

export const SITEMAP_COMMIT_DERIVED_SOURCE_PATHS: string[] = [
  "shared/data/stablecoins/coins/**",
  "src/app/**",
  "src/lib/case-studies/**",
  "src/data/blog/**",
  "src/components/stablecoin-detail/static-seo-content.tsx",
  "src/lib/page-metadata.ts",
  "src/lib/stablecoin-detail-json-ld.ts",
];

function parseNullDelimitedPaths(output: string): string[] {
  return splitNullDelimited(output)
    .map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter(Boolean);
}

export function collectUncommittedPaths({
  cwd = process.cwd(),
  execFile = execFileSync,
}: {
  cwd?: string;
  execFile?: typeof execFileSync;
} = {}): string[] {
  const commands = [
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];

  return [
    ...new Set(commands.flatMap((args) => parseNullDelimitedPaths(execFile("git", args, { cwd, encoding: "utf8" })))),
  ].sort();
}

export function findUncommittedArtifactSources(sourcePaths: readonly string[], dirtyPaths: readonly string[]): string[] {
  return dirtyPaths.filter((path) => sourcePaths.some((pattern) => path === pattern || matchesGlob(path, pattern)));
}

export function enforceCommittedArtifactSources({
  artifactId,
  check,
  command,
  cwd = process.cwd(),
  execFile = execFileSync,
  outputPaths = [],
  sourcePaths,
  warn = console.warn,
}: {
  artifactId: string;
  check: boolean;
  command: string;
  cwd?: string;
  execFile?: typeof execFileSync;
  outputPaths?: readonly string[];
  sourcePaths: readonly string[];
  warn?: (message: string) => unknown;
}): { clean: boolean; dirtyOutputs: string[]; dirtySources: string[] } {
  const dirtyPaths = collectUncommittedPaths({ cwd, execFile });
  const dirtySources = findUncommittedArtifactSources(sourcePaths, dirtyPaths);
  const dirtyOutputs = findUncommittedArtifactSources(outputPaths, dirtyPaths);
  if (dirtySources.length === 0 && (!check || dirtyOutputs.length === 0)) {
    return { clean: true, dirtyOutputs: [], dirtySources: [] };
  }

  const sourceDetail = dirtySources.map((path) => `  - ${path}`).join("\n");
  const outputDetail = dirtyOutputs.map((path) => `  - ${path}`).join("\n");
  const instruction =
    `Commit the source changes first, run \`${command}\`, then commit or amend the generated output. ` +
    "The final timestamps cannot be calculated before the source commit exists.";

  if (check) {
    const reasons = [];
    if (dirtySources.length > 0) {
      reasons.push(`Git-history inputs are uncommitted:\n${sourceDetail}\n${instruction}`);
    }
    if (dirtyOutputs.length > 0) {
      reasons.push(
        `generated outputs are uncommitted:\n${outputDetail}\nCommit or discard the generated output before verifying the pushed commit.`,
      );
    }
    throw new Error(`[${artifactId}] cannot verify a commit-derived artifact while ${reasons.join("\n")}`);
  }

  warn(
    `[${artifactId}] WARNING: generated output is provisional because these Git-history inputs are uncommitted:\n${sourceDetail}\n${instruction}`,
  );
  return { clean: false, dirtyOutputs: [], dirtySources };
}
