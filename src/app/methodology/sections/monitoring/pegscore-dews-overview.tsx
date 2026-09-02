import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologyPreconditions,
  WorkedExample,
} from "../../methodology-shared";

export function PegScoreDewsOverview() {
  return (
    <>
      <p>PegScore observes the past and present by scoring realized peg behavior, while DEWS is forward-looking and scores pre-price and live-market depeg stress signals.</p>
      <p>
        Depeg Tracker combines live event detection with a universal 15-minute onset confirmation window,
        source-trust rules, and a per-coin peg score that penalizes time off peg, event severity, active depegs,
        and unstable event spread. Pending depeg confirmation checks sustained same-direction observations,
        independent CoinGecko evidence when the primary does not already use CoinGecko, supported native-peg quotes, Binance tickers,
        trusted aggregate DEX prices, and large challenger pools before promoting or rejecting candidates.
      </p>
      <MethodologyDetails summary="Depeg Confirmation & Trust Gates">
        <div className="space-y-3">
          <p>
            When a live event is later contradicted across the peg by a low-confidence primary price, the detector now
            retires the stale live row immediately and routes the replacement move through pending confirmation instead
            of leaving the wrong direction active.
          </p>
          <p>
            Pending incidents are no longer write-once snapshots. While a candidate is waiting for confirmation,
            Pharos now preserves the original first-seen timestamp, refreshes the current last-seen state, tracks the
            worst same-direction move, and resets the pending row cleanly if the market flips to the opposite side of
            the peg.
          </p>
          <p>
            DEX cross-validation uses explicit trust gates: detection and pending confirmation only trust fresh DEX rows with at least $1M of aggregate source TVL, while the public DEX Price Check UI requires a lighter but still non-trivial floor of $250K. Aggregate DEX rows also need deeper corroboration before they can mutate live event state: recoveries/suppression and pending confirmation now require at least two protocol-level DEX groups, and ambiguous-primary recoveries are vetoed when a large challenger pool still shows the old depeg direction. Pool challenger confirmation counts distinct protocol/source-family groups, with the documented $5M single-pool exception preserved. For already-open depegs, same-direction aggregate DEX disagreement is advisory rather than a synthetic recovery signal, so events stay continuous until the normal recovery path confirms the coin is back inside threshold.
          </p>
          <p>
            Every onset waits beyond the full trigger threshold for at least 15 minutes, even when multiple sources already agree. Pending confirmation chooses off-chain confirmers by source family from the primary <code className="mx-1 text-xs">agreeSources</code> set. CoinGecko-family primary evidence cannot be confirmed by CoinGecko again, and Pharos does not treat DefiLlama&apos;s <code className="mx-1 text-xs">coingecko:&#123;id&#125;</code> mirror as independent. A native CoinGecko quote may initiate a pending non-USD candidate, but it cannot confirm itself: promotion also requires a fresh canonical USD price from a non-CoinGecko family to agree after normalization through the authoritative FX reference. Promoted rows store canonical keys such as <code className="mx-1 text-xs">temporal:15m</code>, <code className="mx-1 text-xs">primary:defillama</code>, and <code className="mx-1 text-xs">dex:curve</code> for auditability.
          </p>
          <p>
            Extreme moves of 50% or more, small-cap assets, and fresh multi-source clusters all use the same minimum 15-minute onset window. Independent source agreement can satisfy the source rule after that window, but it never bypasses temporal confirmation.
          </p>
          <p>
            Those 15-minute windows are continuous-observation windows, not endpoint-age checks. Onset and recovery both require consecutive qualifying observations no more than 1200 seconds apart, and a longer gap resets the window to the new observation rather than counting the blind interval toward confirmation. The tolerance is deliberately wider than the 900-second producer cadence: measured start-to-start gaps for the producing job run 868&ndash;932 seconds, so a tolerance equal to one interval would reset almost every observation and suppress confirmation entirely. It stays below two intervals, so a fully missed run still resets the episode. A depeg therefore cannot be promoted with a start time backdated across an interval nobody observed, and missing data leaves an event open rather than proving recovery.
          </p>
          <p>
            Non-USD fiat pegs use the live fiat FX rate as their primary reference whenever it is available, even when three or more same-peg assets are tracked. A peer median is only a fallback and must contain at least three contributors; thinner peer groups or an empty peer set fail closed. The same authority gate covers the displayed deviation: while no trustworthy reference is available, peg surfaces report the current deviation as reference unavailable instead of quoting a self-referential number. Once a live row is already open, a fresh non-cached multi-source primary cluster can retire it after recovery even if that source mix is still too soft to open brand-new events directly.
          </p>
          <p>
            For supported fiat pairs with a CoinGecko native-currency quote, depeg routing checks that quote before trusting a derived USD-versus-FX move. That means BRZ-style BRL reference drift can no longer open, sustain, or confirm a live depeg when the fresh <code className="mx-1 text-xs">BRZ/BRL</code> quote is near parity; conversely, the native quote can initiate a pending candidate when the USD-versus-FX path masks the native discount. Historical backfill follows the same principle for supported non-USD fiat assets: when CoinGecko exposes a native fiat pair, replay prefers that native history and compares it directly to the native <code className="mx-1 text-xs">1.0</code> peg before falling back to USD-plus-FX reconstruction. In that native-replay mode, Pharos uses daily points plus a two-point confirmation window across 36 hours so thin hourly native prints do not manufacture long false historical depeg streaks.
          </p>
          <p>
            Resolution uses hysteresis and persistence rather than the onset boundary. A live event enters recovery only at half the trigger threshold, then must remain there for 15 minutes before closing; a move back into the deadband or depeg range resets that recovery timer. This prevents near-boundary prices from repeatedly closing and reopening one incident.
          </p>
          <p>
            How an incident closed is decided by its recorded closure reason, not by whether a recovery price happens to be stored. An explicit recovered-primary, recovered-dex, or recovered-native reason means recovered even where quote-domain policy stores no recovery price, so a genuinely recovered non-USD event is no longer misfiled as orphan-closed and excluded from duration training. Conversely, direction supersession, coverage loss, orphan cleanup, and unknown explicit closures cannot be read as recovered just because a stray recovery price is present, so they stay out of the recovered duration corpus and out of Resolver Reviewer outcomes. Legacy rows that predate recorded closure reasons keep the older price-based reading, so historical recovered labels are preserved rather than rewritten.
          </p>
          <p>
            Live depeg events still require at least $1M of current circulating supply. Historical replay applies the same floor from historical supply snapshots, or from current stablecoins-cache supply when historical supply is absent; if neither supply source exists, backfill preserves existing rows. Below that floor, the detail page may still show the current price deviation from peg, but it labels live event coverage as limited instead of implying the coin held peg.
          </p>
          <p>
            PegScore begins at a reviewed replay-coverage anchor when one is curated for the asset; otherwise it uses the documented age and first-observation fallbacks. Detail and tracker surfaces distinguish projected incidents from their constituent threshold crossings and publish a recent 90-day peg view whose denominator contains only observed coverage.
          </p>
          <p>
            DEWS (Depeg Early Warning System) computes forward-looking stress every 30 minutes from market, liquidity,
            confidence, blacklist, flow, and yield signals, with optional PSI-based amplification during systemic stress.
            Blacklist activity is attributed through the tracker config&apos;s canonical stablecoin ID, so same-symbol
            siblings do not inherit one issuer&apos;s freeze events. Hourly DEX prices remain eligible for 75 minutes, and
            its divergence input reuses the live depeg DEX trust floor, so fresh-but-thin rows stay visible for analytics but do not affect the score unless they
            pass the same `$1M` aggregate-TVL gate. The Mint/Burn Flow signal separates 30-day baseline coverage from
            source freshness: a fresh zero-volume 24-hour row is calm, while a mature baseline with no fresh 24-hour row
            is unavailable and recorded as stale.
          </p>
          <p>
            Historical DEWS daily snapshots do not retain the underlying DEX trust metadata needed to replay that gate
            exactly. When operators remediate the old thin-DEX window, the repair path refreshes current rows and
            prunes unrecomputable daily history back to the Mar 9, 2026 trust-floor boundary before new snapshots are
            published under the stricter rule.
          </p>
        </div>
      </MethodologyDetails>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <a href="#mint-burn-flow-methodology" className={METHODOLOGY_LINK_CLASS}>Mint/Burn Flow</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "PegScore focus", value: "History: realized peg behavior" },
          { label: "DEWS focus", value: "Forward stress score" },
          { label: "Refresh", value: "Peg 15m / DEWS 30m" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
            {
              label: "Minimum data",
              value:
                "PegScore requires >=7 tracking days; DEWS requires >=2 available signals (total weight >=0.30) plus fresh core source tables",
            },
            {
              label: "Required sources",
              value:
                "Peg events + tracking window inputs; DEWS consumes supply/liquidity/price plus optional flow/blacklist/yield signals",
            },
            {
              label: "Failure behavior",
              value: "PegScore can be null; DEWS returns null when signal coverage is below threshold; stablecoins-cache failure aborts writes, while other source failures or stale DEX liquidity/mint-burn freshness publish partial rows and mark the cron degraded",
            },
        ]}
      />
      <WorkedExample summary="Worked examples (verified against computePegScore and computeDEWS)">
        <p className="pharos-numeric">PegScore input: 100-day tracking window, 1 event (2 days, 220 bps, inactive)</p>
        <p className="pharos-numeric">pegPct=98.0, severityScore=99.86, spread=0, activePenalty=0 &rarr; pegScore=99</p>
        <p className="pharos-numeric">
          DEWS input signals: supply=40, pool=55, liq=25, price=0, diverg=10 (others unavailable), psiScore=70
        </p>
        <p className="pharos-numeric">
          base=(0.25*40+0.2*55+0.15*25+0.15*0+0.15*10)/0.9=29.17; PSI amplifier=1.02 &rarr; DEWS=30
        </p>
        <p>
          Result: <span className="text-foreground">PegScore 99 and DEWS 30 (WATCH)</span>.
        </p>
      </WorkedExample>
    </>
  );
}
