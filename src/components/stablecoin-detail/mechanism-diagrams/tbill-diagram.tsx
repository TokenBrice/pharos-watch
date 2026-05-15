import { DiagramStep, DiagramArrow } from "./primitives";

export function TbillDiagram({ symbol }: { symbol: string }) {
  return (
    <svg
      viewBox="0 0 600 120"
      className="w-full max-w-2xl text-foreground"
      role="img"
      aria-label={`Investor cash funds a short-duration Treasury portfolio; ${symbol} units accrue NAV daily.`}
    >
      <desc>
        Investors subscribe cash into a regulated fund; the fund deploys into short-duration T-Bills and repurchase agreements; {symbol} units represent fund shares whose NAV accrues daily from the underlying yield.
      </desc>
      <DiagramStep x={0} label="Investor cash" subtitle="subscribed via fund" />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label="T-Bills + Repos" subtitle="short-duration RWA" />
      <DiagramArrow x={350} />
      <DiagramStep x={400} label={`${symbol} units`} subtitle="NAV accrues daily" width={200} />
    </svg>
  );
}
