"use client";

import { DexLiquidityCard } from "@/components/dex-liquidity-card";

interface LiquiditySectionProps {
  stablecoinId: string;
}

export function LiquiditySection({ stablecoinId }: LiquiditySectionProps) {
  return (
    <section id="liquidity">
      <DexLiquidityCard stablecoinId={stablecoinId} />
    </section>
  );
}
