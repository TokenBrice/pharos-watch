import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { ReservePanel } from "@/components/stablecoin-detail/reserve-panel";

type ReservePanelProps = ComponentProps<typeof ReservePanel>;

export function makeReserveResponse(overrides: Partial<ReservePanelProps["reserves"]> = {}): NonNullable<ReservePanelProps["reserves"]> {
  return {
    reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
    estimated: false,
    mode: "live",
    liveAt: 1_700_000_000,
    source: "fixture",
    ...overrides,
  } as NonNullable<ReservePanelProps["reserves"]>;
}

export function renderReservePanelStatic(props: ReservePanelProps): string {
  return renderToStaticMarkup(<ReservePanel {...props} />);
}
