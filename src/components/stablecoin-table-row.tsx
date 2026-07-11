"use client";

import { memo } from "react";
import { TableRow } from "@/components/table";
import { StablecoinTableRowCells } from "@/components/stablecoin-table-row-cells";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinVirtualRowProps } from "@/components/stablecoin-table-row-types";

function isNestedInteractiveTarget(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveAncestor = target.closest('a,button,input,select,textarea,[role="button"],[role="link"]');
  return interactiveAncestor != null && interactiveAncestor !== currentTarget;
}

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
    pegRates: row.pegRates,
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
      data-row-intent={model.isOverview ? "scan" : undefined}
      data-row-striped={isStriped ? "true" : undefined}
      tabIndex={isCursor ? 0 : undefined}
      onClick={(event) => {
        if (isNestedInteractiveTarget(event.target, event.currentTarget)) return;
        onNavigate(row.coin.id);
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
