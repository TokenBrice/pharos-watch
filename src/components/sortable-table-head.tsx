import { TableHead } from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";

interface SortableTableHeadProps<T extends string = string> {
  sortKey: T;
  currentSortKey: T;
  sortDirection: "asc" | "desc";
  label: string;
  toggleSort: (key: T) => void;
  getAriaSortValue: (key: T) => "ascending" | "descending" | "none";
  handleSortKeyDown: (e: React.KeyboardEvent, key: T) => void;
  className?: string;
  title?: string;
  children?: React.ReactNode;
}

export function SortableTableHead<T extends string = string>({
  sortKey,
  currentSortKey,
  sortDirection,
  label,
  toggleSort,
  getAriaSortValue,
  handleSortKeyDown,
  className = "",
  title,
  children,
}: SortableTableHeadProps<T>) {
  return (
    <TableHead
      className={`cursor-pointer hover:bg-muted/50 transition-colors ${className}`}
      onClick={() => toggleSort(sortKey)}
      aria-sort={getAriaSortValue(sortKey)}
      tabIndex={0}
      onKeyDown={(e) => handleSortKeyDown(e, sortKey)}
      title={title}
    >
      {children ?? label} <SortIcon columnKey={sortKey} sortKey={currentSortKey} sortDirection={sortDirection} />
    </TableHead>
  );
}
