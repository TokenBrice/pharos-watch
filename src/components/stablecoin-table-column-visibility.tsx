import { useMemo } from "react";
import { Columns3 } from "lucide-react";
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

interface ColumnVisibilityDropdownProps {
  visibleColumns: ColumnId[];
  setVisibleColumns: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  resetColumns: () => void;
}

export function ColumnVisibilityDropdown({
  visibleColumns,
  setVisibleColumns,
  resetColumns,
}: ColumnVisibilityDropdownProps) {
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const hiddenCount = ALL_COLUMNS.length - visibleColumns.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="min-h-11 border-border/70 sm:min-h-8">
          <Columns3 className="h-3.5 w-3.5" />
          Columns
          {hiddenCount > 0 && (
            <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {hiddenCount}
            </span>
          )}
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
              setVisibleColumns((prev) =>
                checked
                  ? [...prev, col.id]
                  : prev.filter((c) => c !== col.id),
              );
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
