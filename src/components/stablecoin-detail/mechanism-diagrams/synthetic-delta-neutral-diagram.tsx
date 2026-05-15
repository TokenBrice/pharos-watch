import { DiagramStep, DiagramArrow } from "./index";

export function SyntheticDeltaNeutralDiagram({ symbol }: { symbol: string }) {
  return (
    <svg
      viewBox="0 0 600 120"
      className="w-full max-w-2xl text-foreground"
      role="img"
      aria-label={`Crypto deposited as spot collateral is hedged with equal short perp positions; the funding rate paid by perp longs becomes the yield on ${symbol}.`}
    >
      <desc>
        Users deposit crypto as spot collateral; the protocol opens an equal-size short perpetual futures position to neutralize price exposure; the funding rate paid by perp longs flows to {symbol} holders as yield.
      </desc>
      <DiagramStep x={0} label="Crypto deposit" subtitle="spot collateral" />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label="Long spot + short perp" subtitle="delta-neutral hedge" />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={`${symbol} minted`}
        subtitle="funding-rate yield"
        width={200}
      />
    </svg>
  );
}
