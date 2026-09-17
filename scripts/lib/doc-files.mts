import { resolve } from "node:path";
import { collectSourceFiles } from "./source-files.mts";

// Documentation trees have no test/mock directories to skip, so the walker runs
// with an empty exclusion set rather than the source-scanner default.
const NO_EXCLUDED_DIRS = new Set<string>();
export interface InlineCodeSpan {
  line: number;
  value: string;
}


export function collectMarkdownFiles(rootDir: string): string[] {
  return collectSourceFiles(rootDir, { extensions: [".md"], excludedDirs: NO_EXCLUDED_DIRS });
}

export function getVerifiedDocFiles(repoRoot = process.cwd()): string[] {
  const docsRoot = resolve(repoRoot, "docs");
  return [
    resolve(repoRoot, "README.md"),
    ...collectMarkdownFiles(docsRoot),
  ];
}

export function splitLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function* iterInlineCodeSpans(content: string): Generator<InlineCodeSpan> {
  let inFence = false;

  for (const [lineIndex, line] of splitLines(content).entries()) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const regex = /`([^`\n]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      yield {
        line: lineIndex + 1,
        value: match[1] ?? "",
      };
    }
  }
}
