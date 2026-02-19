"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { CHART_PALETTE } from "@/lib/chart-colors";
import type { StablecoinData } from "@/lib/types";

interface ChainSlice {
  name: string;
  value: number;
  otherChains?: string[];
}

interface ChainDistributionProps {
  coin: StablecoinData;
}

function ChainTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: ChainSlice }> }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const data = entry.payload;
  return (
    <div
      className="rounded-lg border px-3 py-2 text-sm shadow-md"
      style={{ backgroundColor: "var(--color-card)", borderColor: "var(--color-border)", color: "var(--color-card-foreground)" }}
    >
      <p className="font-medium">{data.name}: {formatCurrency(data.value)}</p>
      {data.otherChains && data.otherChains.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Includes: {data.otherChains.join(", ")}
        </p>
      )}
    </div>
  );
}

export function ChainDistribution({ coin }: ChainDistributionProps) {
  if (!coin.chainCirculating) {
    return null;
  }

  const chains = Object.entries(coin.chainCirculating)
    .map(([chain, data]) => ({
      name: chain,
      value: data?.current ?? 0,
    }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);

  if (chains.length === 0) return null;

  // Group small chains into "Other"
  const TOP_N = 8;
  const topChains: ChainSlice[] = chains.slice(0, TOP_N);
  const otherChains = chains.slice(TOP_N);
  const otherValue = otherChains.reduce((sum, c) => sum + c.value, 0);
  if (otherValue > 0) {
    topChains.push({
      name: "Other",
      value: otherValue,
      otherChains: otherChains.map((c) => c.name),
    });
  }

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
      <CardHeader>
        <CardTitle as="h2">Chain Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Chain distribution chart across ${topChains.length} chains`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={topChains}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={120}
              dataKey="value"
              nameKey="name"
              paddingAngle={2}
            >
              {topChains.map((_, index) => (
                <Cell key={index} fill={CHART_PALETTE[index % CHART_PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChainTooltip />} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
