export type ColumnId =
  | "rank"
  | "name"
  | "price"
  | "peg"
  | "mcap"
  | "change24h"
  | "change7d"
  | "grade"
  | "stability"
  | "liquidity"
  | "blacklistable"
  | "mintAuthority"
  | "backing"
  | "type"
  | "flags";

interface ColumnDef {
  id: ColumnId;
  label: string;
  locked?: boolean;
  hiddenMobile?: boolean;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "rank", label: "#", locked: true },
  { id: "name", label: "Name", locked: true },
  { id: "price", label: "Price" },
  { id: "peg", label: "Peg", hiddenMobile: true },
  { id: "mcap", label: "Market Cap" },
  { id: "change24h", label: "24h" },
  { id: "change7d", label: "7d", hiddenMobile: true },
  { id: "grade", label: "Grade", hiddenMobile: true },
  { id: "stability", label: "Peg Score", hiddenMobile: true },
  { id: "liquidity", label: "Liq", hiddenMobile: true },
  { id: "blacklistable", label: "Blacklistable", hiddenMobile: true },
  { id: "mintAuthority", label: "Mint Authority", hiddenMobile: true },
  { id: "backing", label: "Backing", hiddenMobile: true },
  { id: "type", label: "Type", hiddenMobile: true },
  { id: "flags", label: "Flags", hiddenMobile: true },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnId[] = ALL_COLUMNS
  .filter((column) => column.id !== "flags")
  .map((column) => column.id);

export const MOBILE_DEFAULT_COLUMNS: ColumnId[] = ALL_COLUMNS
  .filter((column) => !column.hiddenMobile && column.id !== "flags")
  .map((column) => column.id);

export const LOCKED_COLUMNS: Set<ColumnId> = new Set(
  ALL_COLUMNS.filter((column) => column.locked).map((column) => column.id),
);

const COLUMN_IDS = new Set<ColumnId>(ALL_COLUMNS.map((column) => column.id));

function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && COLUMN_IDS.has(value as ColumnId);
}

export function normalizeVisibleColumns(raw: unknown, fallback: readonly ColumnId[]): ColumnId[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }

  const selected = new Set<ColumnId>(LOCKED_COLUMNS);
  for (const value of raw) {
    if (isColumnId(value)) {
      selected.add(value);
    }
  }

  return ALL_COLUMNS
    .map((column) => column.id)
    .filter((id) => selected.has(id));
}
