import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ContentTable } from "@/components/table";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
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
                flow excludes bridge transfers, review-required burns, and atomic roundtrips.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Data source", value: "On-chain mint + burn events" },
                  { label: "Primary score", value: "Pressure Shift vs 30D" },
                  { label: "Main outputs", value: "Net flow, gauge, and FtQ" },
                ]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <MethodologyFacts
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
              </div>
              <WorkedExample summary="Worked example (verified against computeFlowIntensity)">
                <p className="pharos-numeric">Inputs: currentNet=-$0.2M, baselineNet=-$7.5M, baselineAbs=$40M</p>
                <p className="pharos-numeric">denominator=max(40M*0.3,1M)=12M; z=(-0.2M-(-7.5M))/12M=0.608</p>
                <p className="pharos-numeric">pressureShift=clamp(-100,100,z*50)=30.4</p>
                <p>
                  Result: <span className="text-foreground">still burning today, but much lighter than its baseline.</span>
                </p>
              </WorkedExample>

              <MethodologyDetails summary="Technical details: two-signal pipeline, pressure formula, and gauge bands">
                {/* Flow pipeline diagram — desktop: horizontal */}
                <div className="hidden md:flex items-stretch gap-4">
                  {/* Inputs */}
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Mints</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Transfer from 0x0</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Burns</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Transfer to 0x0</p>
                    </div>
                  </div>
                  <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  {/* Aggregation */}
                  <div className="rounded-lg border p-3 text-center flex-1 flex flex-col justify-center">
                    <p className="text-foreground font-medium">Hourly Buckets</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Trailing 30 closed daily issuance-chain buckets</p>
                  </div>
                  <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Net Flow 24h</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Current mint minus burn direction</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Pressure Shift vs 30D</p>
                      <p className="text-xs text-muted-foreground mt-0.5">-100 worsening · 0 baseline · +100 improving</p>
                    </div>
                  </div>
                  <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  {/* Outputs */}
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Bank Run Gauge</p>
                      <p className="text-xs text-muted-foreground mt-0.5">market-cap weighted</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center flex-1">
                      <p className="text-foreground font-medium">Flight-to-Quality</p>
                      <p className="text-xs text-muted-foreground mt-0.5">dual threshold detection</p>
                    </div>
                  </div>
                </div>

                {/* Flow pipeline diagram — mobile: vertical */}
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="grid grid-cols-2 gap-2 w-full">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Mints</p>
                      <p className="text-xs text-muted-foreground">Transfer from 0x0</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Burns</p>
                      <p className="text-xs text-muted-foreground">Transfer to 0x0</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Hourly Buckets</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Trailing 30 closed daily issuance-chain buckets</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="grid w-full gap-2">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Net Flow 24h</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Current mint minus burn direction</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Pressure Shift vs 30D</p>
                      <p className="text-xs text-muted-foreground mt-0.5">-100 worsening · 0 baseline · +100 improving</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="grid grid-cols-2 gap-2 w-full">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Bank Run Gauge</p>
                      <p className="text-xs text-muted-foreground">market-cap weighted</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Flight-to-Quality</p>
                      <p className="text-xs text-muted-foreground">dual threshold</p>
                    </div>
                  </div>
                </div>

                {/* Net Flow */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Net Flow 24h</h3>
                  <p>
                    Net Flow answers the first question directly: is a coin minting or burning right now? It is the raw
                    24-hour mint volume minus burn volume.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Minting</span> &mdash; `netFlow24hUsd &gt; 0`
                    </li>
                    <li>
                      <span className="text-foreground">Burning</span> &mdash; `netFlow24hUsd &lt; 0`
                    </li>
                    <li>
                      <span className="text-foreground">Flat</span> &mdash; `netFlow24hUsd = 0` with activity
                    </li>
                    <li>
                      <span className="text-foreground">No activity</span> &mdash; no 24h mint/burn events in the window
                    </li>
                    <li>
                      <span className="text-foreground">Invariant</span> &mdash; minting vs burning always comes from raw
                      net flow, never from the pressure score sign
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
                      <span className="text-foreground">Ingestion safety</span> &mdash; sync state advances only to the
                      shared safe coverage frontier when some event definitions or block timestamps are incomplete;
                      established coverage is marked lagging by cadence-derived block progress, or unknown when the
                      current chain head is unavailable. For quiet assets, completed block-scan span proves window
                      maturity even when the oldest event row has aged out of retention
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
                      and risky is below C-. Classification is unavailable for inactive assets or when the canonical V9
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
