import { isDirectRun } from "./smoke-runtime.mjs";

function appendListSection(lines, title, values) {
  lines.push(`${title}:`);
  if (values.length === 0) {
    lines.push("- none");
  } else {
    for (const value of values) lines.push(`- ${value}`);
  }
  lines.push("");
}

export function appendGscReportPreamble(lines, {
  title,
  detailLines = [],
  inputs,
  notes,
  parsedFileCounts,
}) {
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

export function runAsyncDirect(importMetaUrl, argv1, runCli) {
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
