"use client";

import { memo } from "react";
import { TableRow } from "@/components/table";
import { StablecoinTableRowCells } from "@/components/stablecoin-table-row-cells";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinVirtualRowProps } from "@/components/stablecoin-table-row-types";
import { isRowActivation } from "@/lib/row-activation";

function StablecoinVirtualRowBase({
  virtualIndex,
  isStriped,
  onNavigate,
  isCursor = false,
  onCursorMouseEnter,
  measureElement,
  ...row
}: StablecoinVirtualRowProps) {
  const variant = row.variant ?? "default";
  const model = buildStablecoinTableRowModel({
    coin: row.coin,
    pegScores: row.pegScores,
    dexLiquidity: row.dexLiquidity,
    reportCards: row.reportCards,
    density: row.density,
    variant,
  });

  return (
    <TableRow
      ref={measureElement}
      className={`group cursor-pointer data-[cursor=true]:bg-muted/40 data-[cursor=true]:shadow-[inset_3px_0_0_0_var(--brand-accent)] ${model.isOverview ? "pharos-overview-table-row" : ""} ${model.riskClass}`}
      style={{ height: row.densityConfig.rowHeight }}
      data-cursor={isCursor ? "true" : undefined}
      data-index={virtualIndex}
      rowIntent={model.isOverview ? "scan" : undefined}
      data-row-striped={isStriped ? "true" : undefined}
      tabIndex={isCursor ? 0 : undefined}
      onClick={(event) => {
        if (isRowActivation(event)) onNavigate(row.coin.id);
      }}
      onMouseEnter={() => {
        if (virtualIndex != null) onCursorMouseEnter?.(virtualIndex);
        row.onPrefetch(row.coin.id);
      }}
    >
      <StablecoinTableRowCells row={row} model={model} />
    </TableRow>
  );
}

export const StablecoinVirtualRow = memo(StablecoinVirtualRowBase);
StablecoinVirtualRow.displayName = "StablecoinVirtualRow";
