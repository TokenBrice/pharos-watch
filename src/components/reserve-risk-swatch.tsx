import type { ReserveRisk } from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { formatDecimal } from "@shared/lib/format";

/** A risk-tier swatch is the tile itself in miniature: same fill, same accent border. */
export function ReserveRiskSwatch({ risk }: { risk: ReserveRisk }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-xs border"
      style={{ backgroundColor: RESERVE_RISK_PRESENTATION[risk].fillColor, borderColor: RESERVE_RISK_PRESENTATION[risk].accentColor }}
    />
  );
}

/** Sentence-case tier phrase for visible text ("Very low risk"); never mono caps, it is a phrase. */
export function formatReserveRiskTier(risk: ReserveRisk): string {
  return `${RESERVE_RISK_PRESENTATION[risk].shortLabel} risk`;
}
/** Summing authored decimal shares can land a whole basket a few ULPs short of
 *  100 (a seven-slice group renders 99.99999999999999); that is not a gap. */
const WHOLE_SHARE_ROUNDOFF = 1e-9;

/** True when a share is the whole basket up to float-summation roundoff. */
export function isWholeReserveShare(pct: number): boolean {
  return pct >= 100 - WHOLE_SHARE_ROUNDOFF;
}

/** Reserve shares are display-rounded to two decimals; positive dust stays visible,
 *  and a share short of the whole never rounds up into a claim of 100%. */
export function formatReserveSharePct(pct: number): string {
  if (pct > 0 && pct < 0.01) return "<0.01%";
  const rounded = formatDecimal(pct, 0, 2);
  return pct < 100 && !isWholeReserveShare(pct) && Number(rounded.replaceAll(",", "")) >= 100
    ? "<100%"
    : `${rounded}%`;
}
