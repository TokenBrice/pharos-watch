import { copyText } from "@/lib/clipboard";
import type { CsvColumn } from "./csv";
import type { ExportPreamble } from "./preamble";
import { formatPreambleMarkdown } from "./preamble";

function escapeMarkdownCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

/**
 * Render data as a GFM-style markdown table prefixed with a `>` blockquote
 * preamble. Pure: no DOM access.
 */
export function buildMarkdownWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  preamble: ExportPreamble,
): string {
  const preambleLine = formatPreambleMarkdown(preamble);
  const header = `| ${columns.map((c) => c.header).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = data.map(
    (row, rowIndex) =>
      `| ${columns.map((c) => escapeMarkdownCell(c.accessor(row, rowIndex))).join(" | ")} |`,
  );
  return [preambleLine, "", header, separator, ...rows].join("\n");
}

/**
 * Copy a markdown table to the clipboard. Returns a promise that resolves
 * to `true` on success and `false` if clipboard copying fails.
 */
export async function copyMarkdownWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  preamble: ExportPreamble,
): Promise<boolean> {
  const text = buildMarkdownWithPreamble(data, columns, preamble);
  const result = await copyText(text);
  return result.ok;
}
