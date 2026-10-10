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

const BANK_RUN_GAUGE_COLUMNS = [
  { id: "band", header: "Band", cellClassName: "text-foreground" },
  { id: "scoreRange", header: "Score Range" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
];

const BANK_RUN_GAUGE_ROWS = [
  { id: "crisis", cells: { band: "CRISIS", scoreRange: "−100 to −70", meaning: "Severe below-baseline redemption pressure across major coins" } },
  { id: "stress", cells: { band: "STRESS", scoreRange: "−70 to −40", meaning: "Worsening coordinated pressure versus normal conditions" } },
  { id: "cautious", cells: { band: "CAUTIOUS", scoreRange: "−40 to −10", meaning: "Mild but broad pressure deterioration" } },
  { id: "neutral", cells: { band: "NEUTRAL", scoreRange: "−10 to 10", meaning: "Close to 30D norms across the market" } },
  { id: "healthy", cells: { band: "HEALTHY", scoreRange: "10 to 40", meaning: "Improving aggregate pressure versus baseline" } },
  { id: "confident", cells: { band: "CONFIDENT", scoreRange: "40 to 70", meaning: "Strong positive pressure shift across major coins" } },
  { id: "surge", cells: { band: "SURGE", scoreRange: "70 to 100", meaning: "Exceptional improvement versus recent norms" } },
];

const MINT_BURN_CARD_CLASSES = {
  desktop: ["rounded-lg border p-3 text-center flex-1", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  desktopCenter: ["rounded-lg border p-3 text-center flex-1 flex flex-col justify-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  mobile: ["rounded-lg border p-3 text-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
  mobileCompact: ["rounded-lg border p-3 text-center", "text-foreground font-medium text-xs", "text-xs text-muted-foreground"],
  mobileCenter: ["w-full rounded-lg border p-3 text-center", "text-foreground font-medium", "text-xs text-muted-foreground mt-0.5"],
} as const;

const MINT_BURN_CARDS = {
  inputs: [{ title: "Mints", subtitle: "Transfer from 0x0" }, { title: "Burns", subtitle: "Transfer to 0x0" }],
  buckets: [{ title: "Hourly Buckets", subtitle: "Trailing 30 closed daily issuance-chain buckets" }],
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
            versionNote="Version increments when flow scoring logic, tracked event semantics, or ingestion attribution policies change."
            changelogClassName="hover:text-orange-700 dark:hover:text-orange-400"
          >
              <p>
                Pharos tracks on-chain mint and burn events for major stablecoins via Alchemy JSON-RPC (Transfer mints/burns
                plus USDT Issue/Redeem). These raw events are aggregated into hourly buckets and exposed as two separate
                signals: raw net flow for current direction, and a baseline-relative pressure score for context. Counted
                flow excludes bridge transfers, review-required burns, atomic roundtrips, and individually reviewed
                protocol-internal movements such as an issuer deploying reserves into its own loan book.
              </p>
              <p>
                An N-hour flow window covers N closed UTC hours ending at the current hour boundary, not a rolling
                window ending now. The open hour is excluded; the oldest included hour retains all valuation gaps.
                The same boundary governs pressure, largest events and longer net-flow windows. Verified CCTP V2
                destination recipient and fee mints are bridge transfers, while unrelated issuance in that transaction
                stays counted. Historical valuation requires an actual observation within the inclusive 24-hour
                distance from the event; retention preserves all hourly siblings until repair and aggregation settle.
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
                      <span className="text-foreground">No activity</span> &mdash; no 24h mint/burn events in the window
                    </li>
                    <li>
                      <span className="text-foreground">Invariant</span> &mdash; minting vs burning always comes from raw
                      net flow, never from the pressure score sign
                    </li>
                    <li>
                      <span className="text-foreground">Valuation completeness</span> &mdash; events without a USD price
                      are counted as unpriced, never as $0. Known mint and burn totals are then lower bounds, and a signed
                      net is not a bound: a partial window publishes no net, and a direction is shown only when missing
                      valuation cannot flip it. Buckets aggregated before v6.22 read as coverage unknown and keep their
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
                      <span className="text-foreground">Valuation gate</span> &mdash; pressure is NR, and the coin leaves
                      gauge weighting, unless the 24h window is fully valued and the baseline has no known unpriced events.
                      A baseline aggregated before v6.22 (coverage unknown) is still used, labelled, until it ages out.
                      The gauge discloses how many weighted coins with at least seven days of history, and how much market cap, it left out
                      this way; the daily digest drops the gauge only when that weight could move it across a band edge
                    </li>
                    <li>
                      <span className="text-foreground">Ingestion safety</span> &mdash; sync state advances only to the
                      shared safe coverage frontier when some event definitions or block timestamps are incomplete;
                      established coverage is marked lagging by cadence-derived block progress, or unknown when the
                      current chain head is unavailable. For quiet assets, completed block-scan span proves window
                      maturity even when the oldest event row has aged out of retention. BUIDL tracks both registered
                      Ethereum share-class contracts; coverage requires both scan cursors to catch up
                    </li>
                    <li>
                      <span className="text-foreground">Floor</span> &mdash; denominator is floored at $1M to prevent noise
                      in low-volume coins
                    </li>
                    <li>
                      <span className="text-foreground">Interpretation</span> &mdash; above +10 = improving vs baseline,
                      between -10 and +10 = stable vs baseline, below -10 = worsening
                    </li>
                  </ul>
                </div>

                {/* Bank Run Gauge */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Bank Run Gauge</h3>
                  <p>
                    Market-cap-weighted composite of all tracked coins&apos; pressure-shift values, producing a single
                    ecosystem-wide configured issuance-chain flow-pressure reading. Gauge weights use each coin&apos;s canonical tracked-chain circulating supply. The gauge score maps to one of seven condition bands:
                  </p>
                  <ContentTable
                    tableId="methodology-mint-burn-bank-run-gauge"
                    testId="methodology-mint-burn-bank-run-gauge-table"
                    columns={BANK_RUN_GAUGE_COLUMNS}
                    rows={BANK_RUN_GAUGE_ROWS}
                  />
                  <p>
                    Returns null only when all tracked coins are NR (for example, insufficient history or no 24h mint/burn
                    activity). Coins with null pressure-shift values are skipped from the market-cap-weighted composite.
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
                      publication is missing, held, stale, invalid, or identity-incompatible
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
