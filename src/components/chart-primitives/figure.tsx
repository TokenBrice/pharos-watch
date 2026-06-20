"use client";

import type { ReactNode } from "react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { ChartCrosshairOverlay } from "@/components/chart-primitives/sync";
import { ScreenReaderDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";

interface ChartCrosshairProps {
  hoveredTs: number | null;
  domain: readonly [number, number] | null;
  plotInsetLeft: number;
  plotInsetRight: number;
  plotInsetTop: number;
  plotInsetBottom: number;
}

interface ChartFigureProps<T> {
  data: ReadonlyArray<T>;
  columns: ReadonlyArray<ChartDataTableColumn<T>>;
  caption: (rows: ReadonlyArray<T>, truncated: boolean, total: number) => string;
  ariaLabel: string;
  emptyMessage: string;
  heightClassName: string;
  containerRef: (node: HTMLDivElement | null) => void;
  isReady: boolean;
  renderChart: () => ReactNode;
  crosshair?: ChartCrosshairProps | null;
  overlay?: ReactNode;
}

export function ChartFigure<T>({
  data,
  columns,
  caption,
  ariaLabel,
  emptyMessage,
  heightClassName,
  containerRef,
  isReady,
  renderChart,
  crosshair,
  overlay,
}: ChartFigureProps<T>) {
  if (data.length === 0) {
    return (
      <div className={`flex ${heightClassName} items-center justify-center text-muted-foreground`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`relative ${heightClassName}`}>
      <div ref={containerRef} className="h-full" role="figure" aria-label={ariaLabel}>
        <ScreenReaderDataTable data={data} columns={columns} caption={caption} />
        {isReady ? renderChart() : <ChartSkeleton className="h-full w-full" />}
      </div>
      {crosshair ? (
        <ChartCrosshairOverlay
          hoveredTs={crosshair.hoveredTs}
          domain={crosshair.domain}
          plotInsetLeft={crosshair.plotInsetLeft}
          plotInsetRight={crosshair.plotInsetRight}
          plotInsetTop={crosshair.plotInsetTop}
          plotInsetBottom={crosshair.plotInsetBottom}
        />
      ) : null}
      {overlay}
    </div>
  );
}
