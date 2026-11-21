import { useMemo } from "react";
import { ChevronDown, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_COLUMNS, LOCKED_COLUMNS, type ColumnId } from "@/hooks/use-preferences";
import { cn } from "@/lib/utils";

interface ColumnVisibilityDropdownProps {
  visibleColumns: ColumnId[];
  setVisibleColumns: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  resetColumns: () => void;
  defaultColumns: ColumnId[];
  /** Columns selected by the user but temporarily hidden to fit the container width. */
  hiddenByFit?: readonly ColumnId[];
  /** Reveal fit-hidden columns directly from the dropdown when container fit is active. */
  onShowAllColumns?: () => void;
  triggerClassName?: string;
  compactOnMobile?: boolean;
}

export function ColumnVisibilityDropdown({
  visibleColumns,
  setVisibleColumns,
  resetColumns,
  defaultColumns,
  hiddenByFit,
  onShowAllColumns,
  triggerClassName,
  compactOnMobile = false,
}: ColumnVisibilityDropdownProps) {
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const hiddenByFitSet = useMemo(() => new Set(hiddenByFit ?? []), [hiddenByFit]);
  const hiddenCount = useMemo(
    () => defaultColumns.filter((id) => !visibleSet.has(id)).length,
    [defaultColumns, visibleSet],
  );
  const fitHiddenCount = hiddenByFitSet.size;
  const totalHiddenBadgeCount = hiddenCount + fitHiddenCount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={
            fitHiddenCount > 0
              ? `${fitHiddenCount} ${fitHiddenCount === 1 ? "column" : "columns"} hidden to fit table width`
              : undefined
          }
          className={cn("min-h-11 w-full rounded-md border-border/70 sm:min-h-8 sm:w-auto", triggerClassName)}
        >
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className={compactOnMobile ? "sr-only sm:not-sr-only" : undefined}>Columns</span>
          {totalHiddenBadgeCount > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 font-mono text-3xs font-semibold tabular-nums text-foreground">
              {totalHiddenBadgeCount}
            </span>
          )}
          <ChevronDown
            className={cn("ml-0.5 h-3.5 w-3.5 text-muted-foreground", compactOnMobile && "hidden sm:block")}
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="pharos-label">
          Toggle columns
        </DropdownMenuLabel>
        {fitHiddenCount > 0 ? (
          <p className="px-2 pb-1.5 text-3xs text-muted-foreground">
            {fitHiddenCount} {fitHiddenCount === 1 ? "column" : "columns"} hidden to fit width
          </p>
        ) : null}
        <DropdownMenuSeparator />
        {ALL_COLUMNS.map((col) => {
          const isFitHidden = hiddenByFitSet.has(col.id);
          return (
            <DropdownMenuCheckboxItem
              key={col.id}
              checked={visibleSet.has(col.id)}
              disabled={LOCKED_COLUMNS.has(col.id)}
              onCheckedChange={(checked) => {
                setVisibleColumns((prev) => (checked ? [...prev, col.id] : prev.filter((c) => c !== col.id)));
              }}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span>{col.label}</span>
                {isFitHidden ? (
                  <span
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
                    title="Hidden to fit table width"
                  >
                    Fit-hidden
                  </span>
                ) : null}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {fitHiddenCount > 0 && onShowAllColumns ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onShowAllColumns}
              className="text-xs text-muted-foreground"
            >
              Show all columns
            </DropdownMenuItem>
          </>
        ) : null}
        {hiddenCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={false}
              onCheckedChange={() => resetColumns()}
              onSelect={(e) => e.preventDefault()}
              className="text-xs text-muted-foreground"
            >
              Reset to defaults
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
