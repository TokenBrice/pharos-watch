import { TableHead } from "@/components/table";
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
      <span className={cn("flex w-full items-center gap-1 overflow-hidden", getButtonAlignment(className))}>
        <button
          type="button"
          // Trailing negative margin is dropped when an adornment follows: it
          // pulled the sort hit-area over the adornment button, leaving only a
          // ~8px clickable sliver (axe target-size "partially obscured").
          // min-w-0 + truncate: a squeezed fixed-layout column ellipsizes the
          // label instead of overflowing glyphs onto the neighboring header.
          className={cn(
            "pharos-focus-ring -ml-2 inline-flex min-h-11 min-w-0 items-center gap-1 rounded-sm px-2 text-inherit transition-colors hover:bg-muted/50 sm:-ml-1 sm:min-h-8 sm:px-1",
            adornment ? "mr-0" : "-mr-2 sm:-mr-1",
          )}
          onClick={() => toggleSort(sortKey)}
          aria-label={label ? `Sort by ${label}` : undefined}
        >
          <span className="truncate">{label}</span>
          <SortIcon columnKey={sortKey} sortKey={currentSortKey} sortDirection={sortDirection} />
        </button>
        {adornment ? <span className="relative z-10 shrink-0">{adornment}</span> : null}
      </span>
    </TableHead>
  );
}
