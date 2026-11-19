"use client";

import { useMemo } from "react";
import { useDepegResolver, usePegSummary, useStressSignals } from "@/hooks/api-hooks";
import { useUtcDayNowMs } from "@/hooks/use-utc-day-clock";
import { readPublishedDeviation } from "@/lib/current-peg";
import { DAY_MS } from "@/lib/constants";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { resolveCoinStates, type CoinState } from "@shared/lib/coin-state";
import { isDdrBookUsable, selectCurrentDdrVerdicts } from "@shared/lib/depeg-resolver/current-verdict";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";

export interface CoinStatesResult {
  /** Exceptional states per tracked coin id, highest precedence first; calm coins are absent. */
  byId: ReadonlyMap<string, readonly CoinState[]>;
  /**
   * The live peg summary and DEWS bands have both loaded: before that only
   * curated states (lifecycle, notices) are known, so a coin with no state is
   * "unknown", never "none".
   */
  liveReady: boolean;
  /** The visitor's day clock is known, so deadline states can be claimed (false on the server and first hydration). */
  clockReady: boolean;
}

/**
 * Every tracked coin's exceptional states (`resolveCoinStates`), from the
 * curated list projection plus the live peg summary, DEWS bands and published
 * DDR verdicts. The three live reads are shared React Query entries, so a page
 * that already loads them pays nothing extra. Deadline states need the
 * visitor's clock (`useUtcDayNowMs`), so they appear only after hydration.
 */
export function useCoinStates({ enabled = true }: { enabled?: boolean } = {}): CoinStatesResult {
  const peg = usePegSummary({ enabled });
  const stress = useStressSignals({ enabled });
  const resolver = useDepegResolver({ enabled: enabled && isDepegResolverEnabled() });
  // Day-scoped visitor clock: null on the server and first hydration, so deadlines never use the build date.
  // Keyed by UTC day so a tab refocus (which re-reads the clock) does not rebuild every state.
  const dayNowMs = useUtcDayNowMs();
  const dayIndex = dayNowMs === null ? null : Math.floor(dayNowMs / DAY_MS);
  const pegCoins = peg.data?.coins;
  const signals = stress.data?.signals;
  const resolverData = resolver.data;

  const byId = useMemo(() => {
    const pegById = new Map((pegCoins ?? []).map((coin) => [coin.id, coin]));
    // The dossier's book gate and row choice, so a chip never names a verdict the page does not.
    const verdictById: ReturnType<typeof selectCurrentDdrVerdicts> = isDdrBookUsable(resolverData)
      ? selectCurrentDdrVerdicts(resolverData!.rows) : new Map<never, never>();
    const nowSec = dayIndex === null ? null : (dayIndex * DAY_MS) / 1000;
    const map = new Map<string, readonly CoinState[]>();
    for (const meta of CLIENT_TRACKED_STABLECOINS) {
      const pegCoin = pegById.get(meta.id);
      const verdict = verdictById.get(meta.id);
      // As on the dossier, NAV tokens and frozen archives carry no live depeg state.
      const depegEligible = meta.flags.navToken !== true && meta.status !== "frozen";
      const states = resolveCoinStates({
        status: meta.status,
        notices: meta.alerts,
        activeDepeg: depegEligible ? pegCoin?.activeDepeg : false,
        deviationBps: readPublishedDeviation(meta.flags.pegCurrency, pegCoin).deviationBps,
        ddrTier: verdict?.tier,
        ddrMethodologyVersion: verdict?.methodologyVersion,
        dewsBand: signals?.[meta.id]?.band,
        nowSec,
      });
      if (states.length > 0) map.set(meta.id, states);
    }
    return map;
  }, [pegCoins, signals, resolverData, dayIndex]);

  return { byId, liveReady: peg.isSuccess && stress.isSuccess, clockReady: dayIndex !== null };
}
