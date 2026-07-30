import { WorkedExample } from "../../methodology-shared";

export function LiquidityWorkedExample() {
  return (
    <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
      <p className="pharos-numeric">
        Inputs: effectiveTVL=$10M, TVL=$20M, marketCap=$100M, volume24h=$1M, qualityTVL=$12M, durability=70, pools=8
      </p>
      <p className="pharos-numeric">depthRatio=10M/100M=10%, tvlDepth=35&times;log10(0.10/0.0007)=75</p>
      <p className="pharos-numeric">vtRatio=1M/20M=5%, volume=38&times;(log10(0.05)+3)=65</p>
      <p className="pharos-numeric">retention=12M/20M=60%, quality=(0.60&minus;0.15)/0.65&times;100=69</p>
      <p className="pharos-numeric">diversity=min(100,8&times;5)=40</p>
      <p className="pharos-numeric">
        score=round(0.30&times;75+0.20&times;65+0.20&times;69+0.20&times;70+0.10&times;40)=67
      </p>
      <p>
        Result: <span className="text-foreground">Liquidity score 67</span>.
      </p>
    </WorkedExample>
  );
}
