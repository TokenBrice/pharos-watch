import { DiagramStep, DiagramArrow } from "./primitives";

export function FiatCashDiagram({ symbol }: { symbol: string }) {
  return (
    <svg
      viewBox="0 0 600 120"
      className="w-full max-w-2xl text-foreground"
      role="img"
      aria-label={`${symbol} mechanism: user dollars in, custodied 1:1, redeemable on demand`}
    >
      <desc>
        Users send USD via wire or ACH to the issuer; the issuer custodies the dollars in cash, repos, and short-term Treasuries; the issuer mints {symbol} 1:1 and lets holders redeem at any time.
      </desc>
      <DiagramStep x={0} label="User USD" subtitle="wire / ACH" />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label="Issuer reserves" subtitle="custodied 1:1" />
      <DiagramArrow x={350} />
      <DiagramStep x={400} label={`${symbol} minted`} subtitle="redeem any time" width={200} />
    </svg>
  );
}
