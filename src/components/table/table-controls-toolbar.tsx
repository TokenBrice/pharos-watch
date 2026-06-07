import * as React from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TableDensity } from "@/hooks/use-table-density";

import { TableSettingsMenu } from "./table-settings-menu";
import { TableToolbarFrame } from "./table-toolbar-frame";

export interface TableControlsToolbarProps {
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  columnsSlot?: React.ReactNode;
  settingsSlot?: React.ReactNode;
  additionalActions?: React.ReactNode;
  onExport?: () => void;
  exportDisabled?: boolean;
  exportLabel?: string;
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  titleId?: string;
  meta?: React.ReactNode;
}

export function TableControlsToolbar({
  density,
  onDensityChange,
  columnsSlot,
  settingsSlot,
  additionalActions,
  onExport,
  exportDisabled,
  exportLabel = "Export CSV",
  eyebrow = "Table Controls",
  description,
  titleId,
  meta,
}: TableControlsToolbarProps) {
  return (
    <TableToolbarFrame
      eyebrow={eyebrow}
      description={description}
      titleId={titleId}
      meta={meta}
      actions={(
        <>
          {additionalActions}
          <TableSettingsMenu
            density={density}
            onDensityChange={onDensityChange}
            columnsSlot={columnsSlot}
          >
            {settingsSlot}
          </TableSettingsMenu>
          {onExport ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={onExport}
              disabled={exportDisabled}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {exportLabel}
            </Button>
          ) : null}
        </>
      )}
    />
  );
}
