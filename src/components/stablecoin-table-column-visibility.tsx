import { useMemo } from "react";
import { ChevronDown, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
  triggerClassName?: string;
  compactOnMobile?: boolean;
}

export function ColumnVisibilityDropdown({
  visibleColumns,
  setVisibleColumns,
  resetColumns,
  defaultColumns,
  triggerClassName,
  compactOnMobile = false,
}: ColumnVisibilityDropdownProps) {
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  // Count how many default columns are currently hidden (user has disabled them)
  const hiddenCount = useMemo(
    () => defaultColumns.filter((id) => !visibleSet.has(id)).length,
    [defaultColumns, visibleSet],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("min-h-11 w-full rounded-lg border-border/70 sm:min-h-8 sm:w-auto", triggerClassName)}
        >
          <Columns3 className="h-3.5 w-3.5" />
          <span className={compactOnMobile ? "sr-only sm:not-sr-only" : undefined}>Columns</span>
          {hiddenCount > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 font-mono text-[10px] font-semibold tabular-nums text-foreground">
              {hiddenCount}
            </span>
          )}
          <ChevronDown
            className={cn("ml-0.5 h-3.5 w-3.5 text-muted-foreground", compactOnMobile && "hidden sm:block")}
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Toggle columns
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_COLUMNS.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={visibleSet.has(col.id)}
            disabled={LOCKED_COLUMNS.has(col.id)}
            onCheckedChange={(checked) => {
              setVisibleColumns((prev) => (checked ? [...prev, col.id] : prev.filter((c) => c !== col.id)));
            }}
            onSelect={(e) => e.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
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
