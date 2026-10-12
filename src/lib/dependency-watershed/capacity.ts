import type { WatershedModel } from "./model";

export interface WatershedCapacityOptions {
  heightBudget: number;
  /** Estimated advance per character for 11px label text. */
  charWidth: number;
  labelOf: (id: string) => string;
}

export const DEFAULT_WATERSHED_HEIGHT_BUDGET = 1200;

/** Longest label a hub row carries: "SYMBOL $9.03B" or its folded-dependents chip. */
export function watershedLabelChars(label: string, chip: string | null, figure: string | null): number {
  return Math.max(label.length + (figure ? figure.length + 1 : 0), chip?.length ?? 0);
}

/**
 * Checks the layout constants against the data so growth that breaks the
 * plan fails a test instead of drawing badly: row pitch, stacked rows that
 * overlap in a column, labels that run into the next column, and the
 * canvas height budget.
 */
export function validateWatershedCapacity(model: WatershedModel, options: Partial<WatershedCapacityOptions> = {}): string[] {
  if (!model.ok) return [];
  const { heightBudget = DEFAULT_WATERSHED_HEIGHT_BUDGET, charWidth = 6.2, labelOf = (id: string) => id } = options;
  const issues: string[] = [];
  const { layout } = model;
  const spacing = model.columns.length > 1 ? model.columns[1]!.x - model.columns[0]!.x : layout.width;
  const deltas = new Map(model.deltas.map(delta => [delta.hubId, delta]));
  const byColumn = new Map<number, typeof model.nodes>();
  for (const node of model.nodes) (byColumn.get(node.column) ?? byColumn.set(node.column, []).get(node.column)!).push(node);
  for (const [column, nodes] of byColumn) {
    const sorted = [...nodes].sort((a, b) => a.y - b.y);
    sorted.forEach((node, index) => {
      if (node.height < layout.minRow) issues.push(`row pitch below ${layout.minRow}px: ${node.id}`);
      const next = sorted[index + 1];
      if (next && node.y + node.height + layout.gap > next.y + 1e-6) issues.push(`rows overlap in column ${column}: ${node.id} / ${next.id}`);
      const delta = deltas.get(node.id);
      const chip = delta ? `${delta.leafIds.length}${delta.remainder ? " more" : ""} dependents · $00.00M` : null;
      const chars = watershedLabelChars(labelOf(node.id), chip, node.showFigure ? "$0.00B" : null);
      const room = column === model.columns.length - 1 ? layout.padRight : spacing - layout.barWidth;
      if (layout.barWidth + 6 + layout.deltaStub + chars * charWidth > room) issues.push(`label overflows column ${column}: ${node.id}`);
    });
  }
  if (model.height > heightBudget) issues.push(`canvas height ${Math.round(model.height)}px exceeds ${heightBudget}px budget`);
  return issues;
}
