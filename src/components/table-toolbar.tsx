"use client";

import { Download, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { DensityToggle } from "./density-toggle";
import { ColumnVisibilityDropdown } from "./stablecoin-table-column-visibility";
import type { TableDensity } from "@/hooks/use-table-density";
import type { ColumnId } from "@/hooks/use-preferences";

interface TableToolbarProps {
  // Density
  density: TableDensity;
  onDensityChange: (density: TableDensity) => void;

  // Columns
  visibleColumns: ColumnId[];
  onVisibleColumnsChange: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  onResetColumns: () => void;
  defaultColumns: ColumnId[];

  // Export
  onExport: () => void;
  exportDisabled?: boolean;

  // Additional actions
  additionalActions?: React.ReactNode;
}

export function TableToolbar({
  density,
  onDensityChange,
  visibleColumns,
  onVisibleColumnsChange,
  onResetColumns,
  defaultColumns,
  onExport,
  exportDisabled,
  additionalActions,
}: TableToolbarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        {additionalActions}
      </div>

      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
              <Settings2 className="h-3.5 w-3.5" />
              Table settings
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-4 p-4">
            <div className="space-y-2">
              <p className="pharos-kicker">Density</p>
              <DensityToggle value={density} onChange={onDensityChange} />
            </div>
            <div className="space-y-2">
              <p className="pharos-kicker">Columns</p>
              <ColumnVisibilityDropdown
                visibleColumns={visibleColumns}
                setVisibleColumns={onVisibleColumnsChange}
                resetColumns={onResetColumns}
                defaultColumns={defaultColumns}
              />
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="sm"
          className="hidden sm:inline-flex"
          onClick={onExport}
          disabled={exportDisabled}
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </div>
    </div>
  );
}
