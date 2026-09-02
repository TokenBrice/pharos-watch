export type MarkdownAlignment = "left" | "right";
export type MarkdownPipeStyle = "bare" | "wrapped";

export function markdownValue(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdownRows<T>({
  headings,
  rows,
  cells,
  alignments,
  empty,
  limit,
  overflow,
  pipeStyle = "bare",
}: {
  headings: readonly string[]; rows: readonly T[]; cells: (row: T) => readonly unknown[];
  alignments?: readonly MarkdownAlignment[]; empty?: string; limit?: number;
  overflow?: (hidden: number) => string; pipeStyle?: MarkdownPipeStyle;
}): string[] {
  const renderLine = (values: readonly unknown[]): string => {
    const line = values.map(markdownValue).join(" | ");
    return pipeStyle === "wrapped" ? `| ${line} |` : line;
  };

  if (rows.length === 0 && empty !== undefined) return [empty];

  const selected = limit == null ? rows : rows.slice(0, limit);
  const lines = [
    renderLine(headings),
    renderLine(headings.map((_, index) => alignments?.[index] === "right" ? "---:" : "---")),
    ...selected.map((row) => renderLine(cells(row))),
  ];
  const hidden = rows.length - selected.length;
  if (hidden > 0 && overflow) lines.push(overflow(hidden));
  return lines;
}
