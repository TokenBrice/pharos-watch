import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/table";
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
  const isActive = currentSortKey === sortKey;

  return (
    <TableHead
      scope={scope}
      className={cn(
        className,
        isActive && "text-foreground shadow-[inset_0_-2px_0_0_var(--brand-accent)]",
      )}
      aria-sort={getAriaSortValue(sortKey)}
      title={title}
    >
      <span className={cn("flex w-full min-w-0 items-center gap-1", getButtonAlignment(className))}>
        <button
          type="button"
          // No negative horizontal margins: keeps the focus ring unclipped and
          // prevents sort buttons from overlapping adjacent adornment buttons.
          // min-w-0 + truncate: a squeezed fixed-layout column ellipsizes the
          // label instead of overflowing glyphs onto the neighboring header.
          className="group/sort pharos-focus-ring inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-sm px-1.5 text-inherit transition-colors hover:bg-muted/50 hover:text-foreground sm:min-h-8 sm:px-1"
          onClick={() => toggleSort(sortKey)}
          aria-label={label ? `Sort by ${label}` : undefined}
        >
          <span className="truncate">{label}</span>
          {!isActive ? (
            <ArrowUpDown
              className="ml-0.5 inline h-3.5 w-3.5 shrink-0 opacity-35 transition-opacity group-hover/sort:opacity-75"
              aria-hidden="true"
            />
          ) : sortDirection === "asc" ? (
            <ArrowUp className="ml-0.5 inline h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
          ) : (
            <ArrowDown className="ml-0.5 inline h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
          )}
        </button>
        {adornment ? <span className="relative z-10 shrink-0">{adornment}</span> : null}
      </span>
    </TableHead>
  );
}
