import { DiagramStep, DiagramArrow } from "./index";

export function AlgorithmicDiagram({ symbol }: { symbol: string }) {
  return (
    <svg
      viewBox="0 0 600 120"
      className="w-full max-w-2xl text-foreground"
      role="img"
      aria-label={`An algorithmic mint/burn module trades a governance token for ${symbol} to defend the peg; the design has no 1:1 reserve backing.`}
    >
      <desc>
        Users burn a governance token to algorithmically mint {symbol}; an autonomous mint/burn module defends the peg through arbitrage incentives; the system has no 1:1 reserve backing, so confidence in the governance token is critical.
      </desc>
      <DiagramStep x={0} label="User burns governance token" subtitle="algorithmic mint" />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label="Mint/burn AMO" subtitle="defends peg via arbitrage" />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={`${symbol} minted`}
        subtitle="no 1:1 backing"
        width={200}
      />
    </svg>
  );
}
