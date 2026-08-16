import { isDirectRun } from "./smoke-runtime.mjs";

/**
 * @param {string[]} lines
 * @param {string} title
 * @param {string[]} values
 */
function appendListSection(lines: string[], title: string, values: readonly string[]): void {
  lines.push(`${title}:`);
  if (values.length === 0) {
    lines.push("- none");
  } else {
    for (const value of values) lines.push(`- ${value}`);
  }
  lines.push("");
}

export function appendGscReportPreamble(lines: string[], {
  title,
  detailLines = [],
  inputs,
  notes,
  parsedFileCounts,
}: {
  title: string;
  detailLines?: readonly string[];
  inputs: readonly string[];
  notes: readonly string[];
  parsedFileCounts: readonly (readonly [string, number])[];
}): void {
  lines.push(title);
  lines.push("No live network checks were performed.");
  for (const detail of detailLines) lines.push(detail);
  lines.push("");

  appendListSection(lines, "Inputs", inputs);
  appendListSection(lines, "Unsupported or skipped files", notes);

  lines.push("Parsed files:");
  for (const [label, count] of parsedFileCounts) {
    lines.push(`- ${label}: ${count}`);
  }
  lines.push("");
}

export function runAsyncDirect(importMetaUrl: string, argv1: string | undefined, runCli: () => Promise<number>): boolean {
  if (!isDirectRun(importMetaUrl, argv1)) return false;

  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
  return true;
}
