import type { ReactNode } from "react";

export type { TableDensity } from "@/hooks/use-table-density";

export type TableAlign = "left" | "center" | "right";
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

export interface TableColumn<T, K extends string = string> {
  id: K;
  header: ReactNode;
  cell?: (row: T) => ReactNode;
  sortAccessor?: (row: T) => string | number | null | undefined;
  exportAccessor?: (row: T) => string | number | null | undefined;
  align?: TableAlign;
  width?: string;
  mobile?: (row: T) => ReactNode;
}
