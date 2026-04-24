import { TableHead } from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";
import { cn } from "@/lib/utils";

interface SortableTableHeadProps<T extends string = string> {
  sortKey: T;
  currentSortKey: T;
  sortDirection: "asc" | "desc";
  label: string;
  toggleSort: (key: T) => void;
  getAriaSortValue: (key: T) => "ascending" | "descending" | "none";
  adornment?: React.ReactNode;
  className?: string;
  title?: string;
  scope?: "col";
}

function getButtonAlignment(className: string): string {
  if (className.includes("text-right")) return "justify-end";
  if (className.includes("text-center")) return "justify-center";
  return "justify-start";
}

export function SortableTableHead<T extends string = string>({
  sortKey,
  currentSortKey,
  sortDirection,
  label,
  toggleSort,
  getAriaSortValue,
  adornment,
  className = "",
  title,
  scope = "col",
}: SortableTableHeadProps<T>) {
  return (
    <TableHead
      scope={scope}
      className={className}
      aria-sort={getAriaSortValue(sortKey)}
      title={title}
    >
      <span className={cn("flex w-full items-center gap-1", getButtonAlignment(className))}>
        <button
          type="button"
          className="pharos-focus-ring -mx-1 inline-flex min-h-8 items-center gap-1 rounded-sm px-1 text-inherit transition-colors hover:bg-muted/50"
          onClick={() => toggleSort(sortKey)}
          aria-label={label ? `Sort by ${label}` : undefined}
        >
          <span>{label}</span>
          <SortIcon columnKey={sortKey} sortKey={currentSortKey} sortDirection={sortDirection} />
        </button>
        {adornment}
      </span>
    </TableHead>
  );
}
