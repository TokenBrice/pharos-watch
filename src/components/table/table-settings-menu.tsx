"use client";

import * as React from "react";
import { Settings2 } from "lucide-react";

import { DensityToggle } from "@/components/density-toggle";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TableDensity } from "@/hooks/use-table-density";

export interface TableSettingsMenuProps {
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  columnsSlot?: React.ReactNode;
  children?: React.ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}

export function TableSettingsMenu({
  density,
  onDensityChange,
  columnsSlot,
  children,
  triggerLabel = "Table settings",
  triggerClassName,
  align = "end",
}: TableSettingsMenuProps) {
  const showDensity = density !== undefined && onDensityChange !== undefined;
  if (!showDensity && !columnsSlot && !children) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={triggerClassName ?? "min-h-11 gap-1.5 text-xs text-muted-foreground sm:min-h-8"}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[22rem] max-w-[calc(100vw-2rem)] space-y-4 p-4">
        {showDensity ? (
          <div className="space-y-2">
            <p className="pharos-kicker">Density</p>
            <DensityToggle value={density} onChange={onDensityChange} />
          </div>
        ) : null}
        {columnsSlot ? (
          <div className="space-y-2">
            <p className="pharos-kicker">Columns</p>
            {columnsSlot}
          </div>
        ) : null}
        {children}
      </PopoverContent>
    </Popover>
  );
}
