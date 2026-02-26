import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { getScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityMap } from "@/lib/types";

export function LiquidityBox({ stablecoinId, liquidityMap }: { stablecoinId: string; liquidityMap: DexLiquidityMap | undefined }) {
  const liq = liquidityMap?.[stablecoinId];
  if (!liq || (liq.liquidityScore === null && liq.poolCount === 0)) return null;

  const score = liq.liquidityScore ?? 0;
  const textColor = getScoreColor(score);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Liquidity Score</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold font-mono tracking-tight ${textColor}`}>
          {Math.round(score)}<span className="text-lg text-muted-foreground">/100</span>
        </div>
        <p className="text-sm text-muted-foreground font-mono">
          {formatCurrency(liq.totalTvlUsd)} TVL
        </p>
        <p className="text-sm text-muted-foreground">
          {liq.poolCount} pool{liq.poolCount !== 1 ? "s" : ""} &middot; {liq.chainCount} chain{liq.chainCount !== 1 ? "s" : ""}
        </p>
      </CardContent>
    </Card>
  );
}
