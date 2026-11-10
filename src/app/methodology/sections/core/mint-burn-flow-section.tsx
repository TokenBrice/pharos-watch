import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ContentTable } from "@/components/table";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologyPreconditions,
  MethodologySectionShell,
  ResponsiveMethodologyPipeline,
  type ResponsiveMethodologyPipelineProps,
  WorkedExample,
} from "../../methodology-shared";
import { MINT_BURN_FLOW_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_SECTION_ACCENT_CLASSES } from "@shared/lib/classification";
import { GAUGE_BAND_RANGES, type GaugeBand } from "@shared/lib/mint-burn-gauge-bands";
import { getPressureShiftState } from "@shared/lib/mint-burn-signals";

const NEUTRAL_GAUGE_RANGE = GAUGE_BAND_RANGES.find(({ band }) => band === "NEUTRAL")!;

const BANK_RUN_GAUGE_COLUMNS = [
  { id: "band", header: "Band", cellClassName: "text-foreground" },
  { id: "scoreRange", header: "Score range" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
];

const BANK_RUN_GAUGE_MEANINGS: Record<GaugeBand, string> = {
  CRISIS: "Severe below-baseline redemption pressure across major coins",
  STRESS: "Worsening coordinated pressure versus normal conditions",
  CAUTIOUS: "Mild but broad pressure deterioration",
  NEUTRAL: "Close to 30D norms across the market",
  HEALTHY: "Improving aggregate pressure versus baseline",
  CONFIDENT: "Strong positive pressure shift across major coins",
  SURGE: "Exceptional improvement versus recent norms",
};
const BANK_RUN_GAUGE_ROWS = GAUGE_BAND_RANGES.map(({ band, min, max }, index) => ({
  id: band.toLowerCase(),
  cells: {
    band,
    scoreRange: `[${min}, ${max}${index === GAUGE_BAND_RANGES.length - 1 ? "]" : ")"}`,
    meaning: BANK_RUN_GAUGE_MEANINGS[band],
  },
}));

const MINT_BURN_CARD_CLASSES = {
  desktop: ["rounded-lg border p-3 text-center flex-1", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  desktopCenter: ["rounded-lg border p-3 text-center flex-1 flex flex-col justify-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  mobile: ["rounded-lg border p-3 text-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  mobileCompact: ["rounded-lg border p-3 text-center", "text-foreground font-medium text-xs", "text-xs text-muted-foreground"],
  mobileCenter: ["w-full rounded-lg border p-3 text-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
} as const;

const MINT_BURN_CARDS = {
  inputs: [{ title: "Mints", subtitle: "Transfer from 0x0" }, { title: "Burns", subtitle: "Transfer to 0x0" }],
  buckets: [{ title: "Hourly buckets", subtitle: "Trailing 30 closed daily issuance-chain buckets" }],
  signals: [{ title: "Net Flow 24h", subtitle: "Current mint minus burn direction" }, { title: "Pressure Shift vs 30D", subtitle: "-100 worsening · 0 baseline · +100 improving" }],
  desktopOutputs: [{ title: "Bank Run Gauge", subtitle: "market-cap weighted" }, { title: "Flight-to-Quality", subtitle: "dual threshold detection" }],
  mobileOutputs: [{ title: "Bank Run Gauge", subtitle: "market-cap weighted" }, { title: "Flight-to-Quality", subtitle: "dual threshold" }],
};

const MINT_BURN_PIPELINE = {
  desktop: {
    wrapperClassName: "hidden md:flex items-stretch gap-4",
    arrow: { className: "flex items-center text-muted-foreground text-xl font-bold", symbol: "→" },
    exactClassNames: MINT_BURN_CARD_CLASSES.desktop,
    stages: [
      { wrapperClassName: "flex flex-col gap-2 flex-1", cards: MINT_BURN_CARDS.inputs },
      { exactClassNames: MINT_BURN_CARD_CLASSES.desktopCenter, cards: MINT_BURN_CARDS.buckets },
      { wrapperClassName: "flex flex-col gap-2 flex-1", cards: MINT_BURN_CARDS.signals },
      { wrapperClassName: "flex flex-col gap-2 flex-1", cards: MINT_BURN_CARDS.desktopOutputs },
    ],
  },
  mobile: {
    wrapperClassName: "flex flex-col items-center gap-3 md:hidden",
    arrow: { className: "text-muted-foreground text-xl font-bold", symbol: "↓" },
    exactClassNames: MINT_BURN_CARD_CLASSES.mobile,
    stages: [
      { wrapperClassName: "grid grid-cols-2 gap-2 w-full", exactClassNames: MINT_BURN_CARD_CLASSES.mobileCompact, cards: MINT_BURN_CARDS.inputs },
      { exactClassNames: MINT_BURN_CARD_CLASSES.mobileCenter, cards: MINT_BURN_CARDS.buckets },
      { wrapperClassName: "grid w-full gap-2", cards: MINT_BURN_CARDS.signals },
      { wrapperClassName: "grid grid-cols-2 gap-2 w-full", exactClassNames: MINT_BURN_CARD_CLASSES.mobileCompact, cards: MINT_BURN_CARDS.mobileOutputs },
    ],
  },
} satisfies ResponsiveMethodologyPipelineProps;

export function MintBurnFlowMethodologySection() {
  return (
          <MethodologySectionShell
            id={MINT_BURN_FLOW_SECTION_CONTENT.id}
            title={MINT_BURN_FLOW_SECTION_CONTENT.title}
            versionBadge={{ label: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL }}
            changelogPath={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when admitted issuance coverage, flow scoring logic, tracked event semantics, or ingestion attribution policies change."
            changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.mintBurnFlow.changelogHover}
          >
              <p>
                Every closed hour appears in the chart: only proven quiet hours are zero. Missing evidence withholds
                daily nets and rolling means, and stops cumulative net at the first unavailable hour. Operator replay
                requires complete raw hours before it can replace aggregates.
              </p>
              <p>
                Pharos tracks on-chain mint and burn events for major stablecoins via JSON-RPC (Transfer mints/burns
                plus USDT Issue/Redeem). EVM reads use admitted Dwellir with Alchemy fallback; Tron uses admitted Dwellir
                with TronGrid JSON-RPC fallback. These raw events are aggregated into hourly buckets and exposed as two separate
                signals: raw net flow for current direction, and a baseline-relative pressure score for context. Counted
                flow excludes bridge transfers, review-required burns, atomic roundtrips, and individually reviewed
                protocol-internal movements such as an issuer deploying reserves into its own loan book. Mints to
                and burns from addresses curated as non-circulating on the same chain are also protocol-internal;
                all other internal-flow exclusions require per-event review. These rows remain in the event ledger.
              </p>
              <p>
                Atomic roundtrips require exactly equal mint and burn sums in raw token units among resolved standard
                rows for the complete transaction, coin and chain. Unequal groups remain counted with their real net
                residual; bridge, internal and unproven legs cannot establish neutrality. Historical groups without
                recorded raw amounts retain their existing classification until separately repaired.
              </p>
              <p>
                Positive events below the native display threshold remain priced and classified accounting rows.
                Counted dust contributes to volumes, nets, counts and activity; event feeds, Tape and largest-event
                ranking hide it. Dust-inclusive accounting starts with fully scanned hours from the v6.41 writer.
                Previously materialized hours keep the earlier cutoff, so windows spanning activation mix accounting
                scopes and a count increase alone does not establish an activity change.
              </p>
              <p>
                Reviewed issuance coverage includes Ethereum BRSRV, CHFSAFO and GLDon. Exact start blocks and
                token thresholds remain explicit in the contract registry; GLDon&apos;s reviewed OFT adapter
                preserves bridge-transfer classification. Other native deployments are not implicitly covered,
                and configured history does not establish a completed backfill or a mature flow baseline.
              </p>
              <p>
                An N-hour flow window covers N closed UTC hours ending at the common fully scanned hour
                across admitted sources, within the published freshness budget, not a rolling window ending now.
                The response exposes that watermark; pressure, largest events, baselines and longer net-flow windows
                share it. CCTP v1/v2, CCIP pools and LayerZero OFT routes require token-bound receipt proofs
                for each bridge mint or burn, including separately matched CCTP fee mints. Unrelated issuance in that transaction
                stays counted; a selector or shared endpoint alone cannot exclude it. Historical valuation requires an actual observation within the inclusive 24-hour
                distance from the event; retention preserves all hourly siblings until repair and aggregation settle.
              </p>
              <p>
                A new issuance leg joins published flows only after contiguous scan proof for its current
                configuration covers 90 days through the publication watermark, its frontier is fresh,
                and that baseline passes the existing valuation-completeness rules. Missing or unknown
                valuation keeps it pending; incomplete classification does too. A proven zero-event baseline can qualify without prices.
                Supported new legs keep catching up, with their reason and progress disclosed, while the coin&apos;s
                admitted legs keep publishing. Pending or operator-disabled legs contribute neither totals nor
                gauge weights. Existing contracts sharing a chain bucket must be disabled together; a new
                sibling contract waits for independently attributable history. The frozen 137 pre-gate config keys are grandfathered for membership;
                source-field edits retain that membership, while current-fingerprint coverage remains required.
                An active leg with a durable admission or prior native scan evidence, but missing proof or a
                frontier beyond the 8-hour watermark budget, can be quarantined from the common watermark with its shared bucket only when the complete
                active roster leaves nonempty survivors proving a fresh common complete hour. Otherwise the
                unavailable or stale watermark remains and no new pause is recorded. Isolated outputs stay unavailable rather
                than zero; publication reports pending-admission / reactivation-pending until catch-up, and
                operator diagnostics retain valid unresolved mismatches through quarantine. A
                re-enabled stale leg needs fresh frontier and incumbent-hour proof without repeating the
                90-day gate; every paused sibling must prove that hour before shared buckets resume together.
              </p>
              <p>
                When an established leg is isolated or paused, surviving admitted-leg net and
                gross totals remain published with partial windows and coverage. Never-admitted additions
                do not make the incumbent partial. A partial coin has no full-coin direction or pressure;
                its otherwise eligible admitted-chain weight is withheld from the gauge and disclosed with
                the existing partial inputs, while the score re-weights over scored coins. FTQ keeps the
                partial coin as an unbounded cohort input: only a provably inactive verdict survives,
                otherwise the verdict is unavailable with flow-window-unavailable. Existing Partial
                treatment applies without additional captions.
              </p>
              <p>
                Classification completeness is independent of scan and price coverage. Unresolved events
                withhold exact net, direction, bounds, baseline and pressure; the affected gross side remains
                an observed lower-bound subtotal. Historical hours with unrecorded classification are unknown
                when the current configuration can produce unresolved events. Retention preserves their entire
                coin/chain/hour for later proof, and classification corrections atomically mark the hour dirty.
                Largest valued events rank counted events on admitted tracked chains; they do not rank unpriced
                or unresolved candidates.
              </p>
              <p>
                DAI and USDD use reviewed range proof and retained repair. Their exact windows remain unavailable
                while unresolved or historically unknown hours are present; recent windows can recover before
                longer ones as old hours are repaired or age out. Changed bridge-decoder fingerprints separately
                exclude hours classified under earlier evidence. Gross observed subtotals stay published.
              </p>
              <p>
                USDT Tron joins through that admission gate in the critical lane. Only Issue/Redeem count;
                their paired zero-address Transfers would duplicate the same flow. Scans stop at a fresh
                solidified head. Historical conservation remains unsupported because Tron cannot supply the
                required historical state. Once admitted, Tron joins USDT&apos;s totals, pressure baseline and
                tracked-chain gauge weight. The digest re-bins the published gauge and uses its coin nets;
                DDR&apos;s mint-surge input includes all admitted chains. DEWS keeps Ethereum as USDT&apos;s
                canonical chain. The 90-day admission baseline protects the published 90-day net from a
                newly joined chain with shorter history.
              </p>
              <p>
                Historical hours before the fixed October 20, 2026 noon UTC cutover may use explicitly labelled
                legacy cursor/event assurance. At and after the cutover, current-fingerprint durable scan proof is
                mandatory. Dirty hours and missing valuation remain unavailable. This bounded transition expires
                after the 90-day window passes the cutover. The Bank Run Gauge weights only admitted scored coins;
                incomplete scan membership is disclosed, not silently counted as zero or presented as full coverage.
              </p>
              <p>
                Reviewed zero-recipient transfers require supply-destruction evidence. Exact custom issuance
                receipts can admit internal or batch burns; router selectors alone cannot. Unproven observations
                remain review-required and non-counted. Rebasing and unverified-source exclusions are not blanket
                burn exclusions. Retained-hour repairs track materialization debt; per-config reconciliation
                advances through retained burns and revisits unavailable receipts when its cursor wraps, preserving
                their named reason. Pruned history needs audited replay rather than an invented exact repair.
              </p>
              <p>
                Reviewed range proof can admit exact internal-burn event IDs when all raw mint and zero-recipient
                Transfer amounts reconcile exactly to hash-pinned total-supply change. Dust, bridge and atomic
                legs enter that integer equation before economic exclusions. Source law must exclude counterfeit
                mints, or the range must contain no positive mint events; USYC requires the latter. Proxy and
                delegate eras need pinned implementation state and an in-range change check. Negative source-only
                residuals and unavailable evidence keep candidates unresolved; positive residuals, ambiguous
                zero-to-zero events and inconsistent evidence fence the range. Proof never overrides bridge,
                atomic or protocol-internal exclusions. Proof verifies the parser&apos;s exact raw amounts, and
                pending proof-backed burns cannot neutralize mints in roundtrip reconciliation. Proven rows use
                normal eight-day retention; old unreferenced proof records are pruned. Durable configuration
                fingerprints withdraw stale scan coverage even after raw and proof records expire. Retained range
                repair has a separate cursor from live ingestion and rebuilds only complete raw-retained hours.
              </p>
              <p>
                Every closed window requires admitted scan coverage, using durable current-fingerprint proof
                after the cutover and the bounded legacy rule before it. Without admission, signed net, bounds, direction and pressure are unavailable, while observed gross
                and event-count subtotals remain visible separately. The legacy has24hActivity field stays null
                for an incomplete scan, even when events were observed; the additive observed24hActivity field
                preserves that observed fact without requiring older readers to understand it. A false observed
                activity value is not proof of quiet. Quiet-zero days need affirmative scan coverage.
                Earlier fingerprint evidence does not establish current long-window coverage, and sealed
                historical bytes keep their original identity.
                Hourly totals and repair debt are read atomically; readers using scan proof include it in that
                same batch. Dirty hours withhold exact affected windows until their materialization debt drains,
                even when current-fingerprint scan proof was already issued.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Data source", value: "On-chain mint + burn events" },
                  { label: "Primary score", value: "Pressure Shift vs 30D" },
                  { label: "Main outputs", value: "Net flow, gauge, and FtQ" },
                ]}
              />
              <MethodologyPreconditions
                facts={[
                    {
                      label: "Minimum data",
                      value: "Pressure Shift vs 30D requires at least 7 days of flow history per coin",
                    },
                    { label: "Required sources", value: "24h mint/burn totals plus 30-day baseline aggregates" },
                    {
                      label: "Failure behavior",
                      value:
                        "Pressure shift can be null (NR); gauge is null when no weighted inputs contribute; FtQ needs ±$100M dual threshold",
                    },
                    {
                      label: "Counted rows",
                      value: "Economic-flow aggregates count standard rows only, which in practice means non-bridge mints plus effective burns",
                    },
                ]}
              />
              <WorkedExample summary="Worked example (verified against computeFlowIntensity)">
                <p className="pharos-numeric">Inputs: currentNet=-$0.2M, baselineNet=-$7.5M, baselineAbs=$40M</p>
                <p className="pharos-numeric">denominator=max(40M*0.3,1M)=12M; z=(-0.2M-(-7.5M))/12M=0.608</p>
                <p className="pharos-numeric">pressureShift=clamp(-100,100,z*50)=30.4</p>
                <p>
                  Result: <span className="text-foreground">still burning today, but much lighter than its baseline.</span>
                </p>
              </WorkedExample>

              <MethodologyDetails summary="Technical details: two-signal pipeline, pressure formula, and gauge bands">
                <ResponsiveMethodologyPipeline {...MINT_BURN_PIPELINE} />

                {/* Net Flow */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Net Flow 24h</h3>
                  <p>
                    Net Flow answers whether a coin minted or burned over the last 24 closed UTC hours. It is the
                    mint volume minus burn volume over that window, not the still-open current hour.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Minting</span> &mdash; `netFlow24hUsd &gt; 0`
                    </li>
                    <li>
                      <span className="text-foreground">Burning</span> &mdash; `netFlow24hUsd &lt; 0`
                    </li>
                    <li>
                      <span className="text-foreground">Flat</span> &mdash; `netFlow24hUsd = 0` with activity and complete
                      USD valuation
                    </li>
                    <li>
                      <span className="text-foreground">No activity</span> &mdash; no observed 24h mint/burn events with complete current-fingerprint scan coverage
                    </li>
                    <li>
                      <span className="text-foreground">Invariant</span> &mdash; minting vs burning always comes from raw
                      net flow, never from the pressure score sign
                    </li>
                    <li>
                      <span className="text-foreground">Valuation completeness</span> &mdash; events without a USD price
                      are counted as unpriced, never as $0. Known mint and burn totals are then lower bounds, and a partial
                      window publishes no exact net. With complete scan coverage, unpriced mints can only raise the
                      net and unpriced burns can only lower it, so a window with only one side unpriced shows the
                      known net as an explicit bound (&ge; or &le;); direction also requires complete scan coverage
                      and missing valuation that cannot flip it. Buckets aggregated before v6.22 read as coverage unknown and keep their
                      old-method net, labelled, until they leave the 30-day baseline and 7/30/90-day windows.
                    </li>
                    <li>
                      <span className="text-foreground">Event-time pricing</span> &mdash; an event is valued only with a
                      plausible price whose actual observation time is within &plusmn;24 hours of the event (inclusive):
                      a daily supply snapshot price through its recorded observation time (never its day label; nominal
                      par is never stored), or a replay-safe cached observation, whichever was observed closer to the event. A current price is never applied to an
                      old event; without such evidence, including NAV observations more than 24 hours old over weekends,
                      the event stays unpriced.
                    </li>
                  </ul>
                </div>

                {/* Pressure Shift */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Pressure Shift vs 30D</h3>
                  <p>
                    This is the existing Flow Intensity formula under clearer naming. It measures how far current 24-hour
                    flow pressure deviates from the coin&apos;s own trailing 30 fully closed daily configured issuance-chain baseline.
                  </p>
                  <p className="pharos-numeric text-xs border border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                    denominator = max(baselineDailyAbs &times; 0.3, $1M)
                    <br />
                    z = (currentDailyNet &minus; baselineDailyNet) / denominator
                    <br />
                    pressureShift = clamp(-100, 100, z &times; 50)
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Baseline period</span> &mdash; trailing 30 fully closed UTC days of
                      configured issuance-chain daily net flows and absolute volumes, excluding the current partial day
                    </li>
                    <li>
                      <span className="text-foreground">Minimum data</span> &mdash; requires 7 days of history; returns null
                      (NR) otherwise
                    </li>
                    <li>
                      <span className="text-foreground">Activity gate</span> &mdash; windows with no 24h mint/burn activity
                      or less than $50K absolute 24h flow are marked NR and excluded from gauge weighting
                    </li>
                    <li>
                      <span className="text-foreground">Coverage and valuation gates</span> &mdash; pressure is NR,
                      and the coin leaves gauge weighting, unless current-fingerprint scan proof covers the window,
                      the 24h window and baseline are fully valued and classification-complete. An unknown
                      baseline cannot score or display as an exact daily average. Legacy scan
                      coverage remains unknown, not proof of quiet activity. Omitted coin counts and market-cap
                      weight remain disclosed; observed gross subtotals cannot establish a signed net or pressure
                    </li>
                    <li>
                      <span className="text-foreground">Literal minting pressure</span> &mdash; stablecoin pages also show
                      the raw 24h mint-versus-burn volume balance. Since v6.27 it is NR, with its reason, unless both sides
                      are fully valued: a balance of lower-bound volumes is not a measurement
                    </li>
                    <li>
                      <span className="text-foreground">Ingestion safety</span> &mdash; sync state advances only to the
                      shared safe coverage frontier when some event definitions or block timestamps are incomplete;
                      established coverage is marked lagging when block progress trails its scan lane&apos;s cadence, or unknown when the
                      current chain head is unavailable. For quiet assets, completed block-scan span proves window
                      maturity even when the oldest event row has aged out of retention. BUIDL tracks both registered
                      Ethereum share-class contracts; coverage requires both scan cursors to catch up
                    </li>
                    <li>
                      <span className="text-foreground">Floor</span> &mdash; denominator is floored at $1M to prevent noise
                      in low-volume coins
                    </li>
                    <li>
                      <span className="text-foreground">Aggregate gauge interpretation</span> &mdash; &ge; +{NEUTRAL_GAUGE_RANGE.max} = improving vs baseline,
                      [{NEUTRAL_GAUGE_RANGE.min}, +{NEUTRAL_GAUGE_RANGE.max}) = stable vs baseline, below {NEUTRAL_GAUGE_RANGE.min} = worsening.
                      Per-coin pressure-state labels are separate: exactly +{NEUTRAL_GAUGE_RANGE.max} is {getPressureShiftState(NEUTRAL_GAUGE_RANGE.max)}.
                    </li>
                  </ul>
                </div>

                {/* Bank Run Gauge */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Bank Run Gauge</h3>
                  <p>
                    Market-cap-weighted composite of all tracked coins&apos; pressure-shift values, producing a single
                    ecosystem-wide admitted issuance-chain flow-pressure reading. Gauge weights use each coin&apos;s admitted tracked-chain circulating supply. Every admitted chain must have observed supply when a chain breakdown is used; a missing chain withholds the whole weight, while observed zero counts. The gauge score maps to one of seven condition bands:
                  </p>
                  <ContentTable
                    tableId="methodology-mint-burn-bank-run-gauge"
                    testId="methodology-mint-burn-bank-run-gauge-table"
                    columns={BANK_RUN_GAUGE_COLUMNS}
                    rows={BANK_RUN_GAUGE_ROWS}
                  />
                  <p>
                    The gauge is unavailable when no coin with a pressure-shift value has a positive market-cap weight,
                    for example when all tracked coins are NR or their weights are unavailable or zero. Coins with null
                    pressure-shift values are skipped from the composite.
                  </p>
                </div>

                {/* Flight-to-quality */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Flight-to-Quality Detection</h3>
                  <p>
                    Detects capital rotation from lower-scored to higher-scored tracked mint/burn stablecoins &mdash; a
                    pattern typically seen during market stress when holders move funds out of weaker assets and into
                    stronger safety-score cohorts.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Safety cohorts</span> &mdash; safe is B- or above, neutral is C-/C/C+,
                      and risky is below C-. Classification is unavailable for inactive assets or when the canonical V10
                      publication is missing, held, stale, invalid, or identity-incompatible. Coins pending mint/burn admission leave the cohorts and are listed as excluded
                    </li>
                    <li>
                      <span className="text-foreground">Dual threshold</span> &mdash; active when risky coins have &gt;$100M
                      net outflows AND safe coins have &gt;$100M net inflows simultaneously over 24h
                    </li>
                    <li>
                      <span className="text-foreground">Intensity scaling</span> &mdash; min(100, |riskyOutflows| / $1B
                      &times; 100), reflecting the magnitude of the rotation
                    </li>
                  </ul>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
