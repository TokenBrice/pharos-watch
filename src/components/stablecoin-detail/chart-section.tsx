"use client";

import { McapChart } from "@/components/mcap-chart";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

interface ChartSectionProps {
  supplyHistory: SupplyHistoryPoint[];
}

export function ChartSection({ supplyHistory }: ChartSectionProps) {
  return (
    <section id="chart">
      <McapChart data={supplyHistory} />
    </section>
  );
}
