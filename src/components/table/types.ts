export type { TableDensity } from "@/hooks/use-table-density";

export type TableChrome = "default" | "embedded" | "content" | "bare";
export type TableStriping = boolean | "indexed";
export type TableId = string;

export interface TableIdentityProps {
  /**
   * Stable table identity used by integrations for persisted density,
   * column visibility, export filenames, and test selectors.
   */
  tableId?: TableId;
  testId?: string;
}
