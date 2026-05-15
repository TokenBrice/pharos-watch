import { DiagramStep, DiagramArrow } from "./primitives";

export function CdpDiagram({ symbol }: { symbol: string }) {
  return (
    <svg
      viewBox="0 0 600 120"
      className="w-full max-w-2xl text-foreground"
      role="img"
      aria-label={`Users overcollateralize crypto in a vault to mint ${symbol} as debt; the position is liquidated if collateral falls below the safety ratio.`}
    >
      <desc>
        Users deposit crypto collateral worth more than the debt they want to issue; a vault or peg-stability module mints {symbol} as debt against the collateral; the position is liquidated if the collateral value falls below the configured safety ratio.
      </desc>
      <DiagramStep x={0} label="Crypto collateral" subtitle="overcollateralized" />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label="Vault / PSM" subtitle="mint debt vs collateral" />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={`${symbol} minted`}
        subtitle="liquidated if undercollateralized"
        width={200}
      />
    </svg>
  );
}
