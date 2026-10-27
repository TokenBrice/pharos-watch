import type { DepegEvent } from "../types";
import type { OpenIncidentEvidence } from "./classification/depeg";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";
import { hasCurrentTrustedDepegObservation } from "./peg-utils";

/**
 * The active-depeg census: `/api/peg-summary` coins flagged `activeDepeg` over
 * the active registry. One reducer for the homepage Active depegs card rows
 * and the route share cards (headline counts use the peg summary's own
 * `activeDepegCount`, as the /depeg/ hero does). The id set is passed in so
 * client bundles can supply their generated projection instead of loading the
 * registry.
 */
export function selectActiveDepegCoins<T extends { id: string; activeDepeg?: boolean | null }>(
  coins: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  return coins.filter((coin) => activeIds.has(coin.id) && coin.activeDepeg === true);
}

/**
 * Evidence for one coin's open confirmed incident, from the event detail page.
 * Only a unique open event with a current trusted observation says anything:
 * off-peg needs the gap-free continuity scoring uses; at-par keeps its
 * intentional gap but must be no older than the continuous-observation limit.
 * Missing, ambiguous (several open rows), blind, stale or future-dated evidence
 * reads "unconfirmed" — never recovered, never off peg. Spot bps are not used.
 */
export function classifyOpenIncidentEvidence(
  events: readonly DepegEvent[] | null | undefined,
  stablecoinId: string,
  nowSec: number,
): OpenIncidentEvidence {
  if (!events || !(nowSec > 0)) return "unconfirmed";
  const open = events.filter((event) => event.stablecoinId === stablecoinId && event.endedAt == null);
  if (open.length !== 1) return "unconfirmed";
  const [event] = open;
  const coverage = event.priceCoverage;
  if (coverage?.lastObservationKind === "trusted-off-peg" && hasCurrentTrustedDepegObservation(event, nowSec)) {
    return "outside";
  }
  const last = coverage?.lastTrustedObservationAt;
  if (coverage?.lastObservationKind === "trusted-at-par" && last != null &&
      nowSec >= last && nowSec - last <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC) {
    return "inside";
  }
  return "unconfirmed";
}
