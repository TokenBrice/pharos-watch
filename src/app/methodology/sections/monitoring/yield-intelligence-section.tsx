import Link from "next/link";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import {
  MethodologyDetails,
  MethodologyDiagramArrow,
  MethodologyDiagramCard,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { YIELD_SECTION_CONTENT } from "../methodology-content";
import { YieldMethodologyRelatedLinks, YieldNavTokenMechanismLinks } from "./yield-mechanism-links";

const YIELD_OVERVIEW_PARAGRAPH =
  "Pharos tracks native stablecoin yield plus selected lending opportunities and computes a risk-adjusted ranking via the Pharos Yield Score (PYS). Core rankings publish hourly using a source-aware APY resolution strategy, while slower supplemental-source families refresh on a separate four-hour lane. Alternative sources are retained when multiple valid yield paths exist, address-first identity is used before symbol fallback, curated exact-pool overrides can cover named non-stablecoin venues, confidence-weighted arbitration selects the primary row, and published lending suggestions exclude Resolv / USR-linked venues so broken wrapper ecosystems do not surface as recommended base-asset routes. Eligible tracked wrapper variants can also surface their native/wrapper sources as linked parent routes, so parent assets such as BOLD can show yBOLD and sBOLD context without removing the variants' own rows. The curated auto-discovery lane also pins current Felix, Sovryn, Loopscale, Resupply, Sovryn XUSD, and Anzens exact venues when they pass the normal source-quality gates, and the allowlist now includes reviewed Tier C venues such as AutoFinance, Neverland, Metrom, Mystic Finance, Bitway, and Frankencoin. Future allowlist rounds start from the monthly unmatched-high-TVL audit queue and protocol-category gate rather than broad protocol hunting. Rate-derived coverage includes cgUSD, USDN, BENJI, WTGXX, USTBL, EUTBL, and wiTRY, while commodity exact-pool coverage includes XAUT on Lista Lending and PAXG on Hydration. Published lending-opportunity rows now also require observable venue TVL and a size floor of at least 0.1% of the tracked stablecoin's current supply before they can become the live recommendation. PYS is benchmark-aware and source-risk-aware, with missing source-risk evidence treated as neutral. Royco Dawn structured-tranche rows now attach senior and junior opportunities to the tracked underlying stablecoin when the deposit token resolves, using opportunity-level tranche safety for PYS without changing the underlying Report Card score. Midas mMEV now has a curated NAV-oracle row, and Curve Savings crvUSD now follows the active on-chain profit-unlock stream instead of a trailing exchange-rate delta; pre-launch assets remain manifest-visible as intentional gaps but cannot publish into the live leaderboard before launch.";

export function YieldIntelligenceMethodologySection() {
  return (
          <MethodologySectionShell
            id={YIELD_SECTION_CONTENT.id}
            title={YIELD_SECTION_CONTENT.title}
            versionBadge={{ label: YIELD_METHODOLOGY_VERSION_LABEL }}
            changelogPath={YIELD_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when APY source resolution, source arbitration, history semantics, PYS scoring logic, or eligibility rules for discovered yield sources change."
            changelogClassName="hover:text-violet-700 dark:hover:text-violet-400"
          >
              <p>{YIELD_OVERVIEW_PARAGRAPH}</p>
              <YieldMethodologyRelatedLinks />
              <MethodologyFacts
                facts={[
                  { label: "Update cadence", value: "1h publish / 4h supplemental" },
                  { label: "APY priority", value: "Confidence-weighted across deterministic, curated, and fallback sources" },
                  { label: "Output", value: "PYS (0-100)" },
                ]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <MethodologyFacts
                  facts={[
                    {
                      label: "Minimum data",
                      value:
                        "Need one resolved APY source; deterministic exchange-rate rows can publish from current state, but need prior source-specific history for a nonzero exchange-rate-derived APY",
                    },
                    {
                      label: "Required sources",
                      value:
                        "Direct on-chain reads, curated DeFiLlama pools, curated protocol-native APIs, rate-derived benchmark inputs, or 7-45d price history",
                    },
                    {
                      label: "Failure behavior",
                      value:
                        "No resolved source skips coin update; PYS returns 0 when apy30d <= 0 or the benchmark-adjusted effective yield is non-positive (safety defaults to 40 / NR if live report-card hydration is missing; missing source-risk penalty resolves to neutral 1), while degraded benchmark or safety inputs are surfaced in provenance",
                    },
                  ]}
                />
              </div>
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Adapter manifest</h3>
                <p>
                  The adapter manifest is the canonical machine-readable source list for every yield-bearing
                  asset Pharos tracks. It enumerates the deterministic on-chain readers, curated DeFiLlama
                  pools, protocol-API venues, rate-derived benchmark fallbacks, price-derived NAV
                  fallbacks, auto-discovery lending overrides, and intentional coverage gaps that feed the
                  ranking pipeline, along with each entry&apos;s lifecycle (`active`, `quarantined`,
                  `intentional-gap`, `experimental`). The manifest is published at{" "}
                  <Link
                    href="/docs/api-reference/#get-apiyield-adapter-manifest"
                    className="text-foreground underline underline-offset-2 hover:text-foreground/80 transition-colors"
                  >
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">/api/yield-adapter-manifest</code>
                  </Link>
                  {" "}with a 5-minute cache, stamped with the current methodology version on every entry.
                </p>
              </div>
              <WorkedExample summary="Worked example (verified against computePYS)">
                <p className="pharos-numeric">Inputs: apy30d=8.4, benchmarkRate=4.25, safetyScore=72, sourceRisk.sourceRiskPenalty=1.2, apyVarianceScore=0.18, scalingFactor=8</p>
                <p className="pharos-numeric">
                  benchmarkSpread=8.4-4.25=4.15; effectiveYield=max(0,8.4+0.25*4.15)=9.44; riskPenalty=max(0.5,(101-72)/20)=1.45;
                  sourceRiskPenalty=1.2; rowUtility=9.44/1.2=7.87; adjustedPenalty=1.45^1.75=1.92; yieldEfficiency=7.87/1.92=4.10; sustainability=1-0.18=0.82
                </p>
                <p className="pharos-numeric">PYS=clamp(round(4.10*0.82*8),0,100)=27</p>
                <p>
                  Result: <span className="text-foreground">PYS 27</span>.
                </p>
              </WorkedExample>
              <MethodologyDetails summary="Technical details: APY source resolution, confidence arbitration, PYS formula, NAV handling, and limits">
                {/* Yield pipeline diagram — desktop: horizontal */}
                <div className="hidden md:flex items-stretch gap-4">
                  {/* Three tiers */}
                  <div className="flex flex-col gap-2 flex-1">
                    <MethodologyDiagramCard className="flex-1" title="Tier 1" subtitle="Direct on-chain reads" />
                    <MethodologyDiagramCard className="flex-1" title="Tier 2" subtitle="Curated pools + protocol APIs" />
                    <MethodologyDiagramCard className="flex-1" title="Tier 3 / 4" subtitle="Price- or rate-derived fallback" />
                  </div>
                  <MethodologyDiagramArrow direction="right" />
                  {/* APY */}
                  <MethodologyDiagramCard className="w-32 flex flex-shrink-0 flex-col justify-center" title="Effective Yield" subtitle="APY + 25% benchmark spread" />
                  <MethodologyDiagramArrow direction="right" />
                  {/* Formula components */}
                  <div className="flex flex-col gap-2 flex-1">
                    <MethodologyDiagramCard className="flex-1" title="Row Utility" subtitle="Effective yield ÷ source risk" />
                    <MethodologyDiagramCard className="flex-1" title="Yield Efficiency" subtitle="Row utility ÷ curved safety penalty" />
                    <MethodologyDiagramCard className="flex-1" title="Sustainability" subtitle="penalises high variance" />
                  </div>
                  <MethodologyDiagramArrow direction="right" />
                  {/* PYS */}
                  <MethodologyDiagramCard className="w-32 flex flex-shrink-0 flex-col justify-center" title="PYS Score" subtitle="0–100" />
                </div>
                {/* Yield pipeline diagram — mobile: vertical */}
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="grid grid-cols-3 gap-2 w-full">
                    <MethodologyDiagramCard title="Tier 1" titleClassName="text-xs text-foreground font-medium" subtitle="On-chain reads" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Tier 2" titleClassName="text-xs text-foreground font-medium" subtitle="Curated venues" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Tier 3 / 4" titleClassName="text-xs text-foreground font-medium" subtitle="Fallbacks" subtitleClassName="text-xs text-muted-foreground" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full" title="Effective Yield" subtitle="APY + 25% benchmark spread" />
                  <MethodologyDiagramArrow />
                  <div className="grid grid-cols-3 gap-2 w-full">
                    <MethodologyDiagramCard title="Row Utility" titleClassName="text-xs text-foreground font-medium" subtitle="yield ÷ source risk" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Efficiency" titleClassName="text-xs text-foreground font-medium" subtitle="utility ÷ safety" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Sustainability" titleClassName="text-xs text-foreground font-medium" subtitle="penalises variance" subtitleClassName="text-xs text-muted-foreground" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full" title="PYS Score" subtitle="0–100" />
                </div>
                {/* APY Resolution tiers */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">APY Resolution and Source Arbitration</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Tier 1 &mdash; Direct on-chain reads</span>: reads protocol state
                      directly, either as an exchange-rate delta (e.g.&nbsp;sUSDe), a conservative reward-only estimator
                      (e.g.&nbsp;LUSD B.Protocol Stability Pool, LQTY only), or scrvUSD&apos;s Yearn V3 profit-unlock current-rate reader
                    </li>
                    <li>
                      <span className="text-foreground">Tier 2 &mdash; DeFiLlama pools</span>: matches the coin to a
                      DeFiLlama yield pool via static mapping, chain-scoped wrapper rules, and address-first fallback
                      matching, while explicitly preserving wrapper pools that upstream marks as non-stablecoin when they
                      are configured as relevant yield sources, allowing exact-pool curated overrides for assets such as
                      XAUT, and TVL-weighting exact pool groups when one tracked asset maps to chain-isolated wrapper
                      vaults. Wrapper-over-native venues such as BOLD/yBOLD stay classified as native yield rather than
                      governance-set when the wrapper is just packaging the protocol&apos;s own Stability Pool return
                    </li>
                    <li>
                      <span className="text-foreground">Tier 2.5 &mdash; Protocol-native venues</span>: ingests curated
                      protocol-owned APIs and protocol-specific on-chain venue readers when the canonical savings path is
                      not representable as a reliable DeFiLlama pool; these rows stay in the curated tier rather than
                      inheriting Tier 1 deterministic precedence reserved for native wrapper readers. Royco Dawn senior
                      and junior tranches publish here as <code className="text-xs bg-muted px-1 py-0.5 rounded">structured-tranche</code>{" "}
                      rows keyed by <code className="text-xs bg-muted px-1 py-0.5 rounded">royco-dawn:&lt;chainId&gt;:&lt;marketId&gt;:&lt;side&gt;</code>, while Midas mMEV publishes a NAV-appreciation row from the issuer-listed mMEV/USD oracle
                    </li>
                    <li>
                      <span className="text-foreground">Tier 3 &mdash; Price-derived</span>: for NAV tokens only, derives
                      APY from 7-45 day price appreciation in `supply_history`
                    </li>
                    <li>
                      <span className="text-foreground">Tier 4 &mdash; Rate-derived</span>: for dividend-distributing and
                      Treasury-tracking tokens, derives APY from the selected benchmark registry entry net of known fee
                      spreads, using USD by default, product-specific EFFR where configured, 3-month compounded €STR for EUR pegs, 3-month compounded SARON
                      for Swiss-franc pegs, the CBR key rate for RUB pegs, and BIST TLREF for TRY pegs. Rate-derived rows can also carry an explicit benchmark override for PYS/excess-yield provenance without changing the APY derivation benchmark
                    </li>
                  </ul>
                  <p>
                    Deterministic and curated paths can all contribute rows, then a confidence-weighted arbitration layer
                    chooses the best row. Divergent discovered or fallback sources can be demoted or rejected when a
                    canonical source disagrees materially. Protocol-native supplemental lending venues such as Aave V3 do
                    not outrank stronger native wrapper yields purely because they query protocol state directly. Within a
                    confidence tier, candidates compare source-risk-adjusted utility after source-risk penalty resolution
                    before falling back to APY and TVL tie-breakers, and
                    Resolv / USR-linked lending-opportunity venues are excluded from publication entirely. Published
                    lending-opportunity rows also need observable venue TVL and must clear the higher of the absolute
                    TVL floor or 0.1% of the tracked stablecoin&apos;s current supply. Linked tracked-variant rows can
                    become parent alternatives when they represent native/wrapper yield, while third-party
                    lending-opportunity rows stay on the asset that owns the venue, and explicit lending overrides only
                    publish for active assets.
                  </p>
                  <p>
                    Yield-bearing coverage is now explicitly inventoried per asset. If no reliable runtime source exists,
                    the asset is marked as an intentional gap rather than silently disappearing from audit coverage.
                  </p>
                  <p>
                    Royco Dawn tranche rows are opportunity rows, not stablecoin registry additions. Senior rows are capped
                    at or below the underlying Safety Score; junior rows receive first-loss, utilization, coverage,
                    market-status, drawdown, TVL, withdrawal, explicit access, and venue-posture penalties. These tranche scores are
                    used by PYS for the opportunity row only.
                  </p>
                  <p>
                    Deterministic rows keep their own source identity (`onchain:&lt;stablecoinId&gt;`) rather than sharing
                    a pool UUID with curated sources, so source-aware history and previous-rate lookups stay isolated when
                    both paths coexist.
                  </p>
                  <p>
                    Trailing APY metrics are computed from source-specific history rather than a mixed coin-level series, so
                    source switches no longer contaminate the displayed 7d/30d averages.
                  </p>
                  <p>
                    Read-time <code className="text-xs bg-muted px-1 py-0.5 rounded">data-stale</code> warnings are also
                    cadence-aware: hourly families attach only after three missed <code className="text-xs bg-muted px-1 py-0.5 rounded">sync-yield-data</code>{" "}
                    intervals (about 3 hours at the current publisher), while <code className="text-xs bg-muted px-1 py-0.5 rounded">price-derived</code>{" "}
                    rows wait 36 hours because they are backed by daily <code className="text-xs bg-muted px-1 py-0.5 rounded">supply_history</code>{" "}
                    snapshots rather than hourly source observations.
                  </p>
                </div>
                {/* PYS formula */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Pharos Yield Score (PYS)</h3>
                  <p className="pharos-numeric text-xs border border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                    benchmarkSpread = apy30d &minus; benchmarkRate
                    <br />
                    effectiveYield = max(0, apy30d + benchmarkSpread &times; 0.25)
                    <br />
                    sourceRiskPenalty = deriveOrResolve(sourceRisk, neutral=1, max=2.5)
                    <br />
                    rowUtility = effectiveYield / sourceRiskPenalty
                    <br />
                    riskPenalty = max(0.5, (101 &minus; safetyScore) / 20)
                    <br />
                    yieldEfficiency = rowUtility / (riskPenalty ^ 1.75)
                    <br />
                    sustainability = max(0.3, 1.0 &minus; apyVarianceScore)
                    <br />
                    PYS = clamp(round(yieldEfficiency &times; sustainability &times; scalingFactor), 0, 100)
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Effective yield</span> keeps raw APY as the anchor, then adds 25%
                      of the row&apos;s benchmark spread so tighter local-currency cash hurdles can lift the score without
                      turning PYS into a pure excess-yield ranker
                    </li>
                    <li>
                      <span className="text-foreground">Source-risk penalty</span> uses nested source-risk evidence from
                      measured reward share, source depth, freshness, source switching, bootstrap history, and sourced
                      venue tier where available, then clamps it to 1&ndash;2.5 while treating missing evidence as neutral
                    </li>
                    <li>
                      <span className="text-foreground">Yield efficiency</span> rewards higher APY relative to the
                      opportunity and coin risk profile &mdash; source-risk-adjusted row utility is divided by the curved
                      safety penalty so weaker safety grades need much more effective yield to compete
                    </li>
                    <li>
                      <span className="text-foreground">Sustainability multiplier</span> penalizes volatile yields (high
                      variance over 30 days), favouring consistent returns
                    </li>
                    <li>
                      <span className="text-foreground">Scaling factor</span> is a global constant that normalises scores
                      into a readable 0&ndash;100 range after the steeper safety curve is applied
                    </li>
                  </ul>
                </div>
                {/* NAV token note */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">NAV Token Handling</h3>
                  <p>
                    NAV-appreciating tokens (e.g.&nbsp;sDAI, wUSDM, BUIDL) use live report-card scores when the safety
                    framework has enough data for them, including NAV-aware report-card coverage. The default safety baseline
                    of 40 (NR) is only a missing-safety fallback, so a NAV token&apos;s PYS can still reflect a full safety
                    assessment when report-card hydration succeeds.
                  </p>
                  <YieldNavTokenMechanismLinks />
                </div>
                {/* Limitations */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Limitations</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      Trailing averages require sufficient history &mdash; newly tracked coins may show unstable scores
                      until 7 days of data accumulate
                    </li>
                    <li>
                      Some DeFiLlama and protocol-native surfaces still depend on upstream asset metadata completeness; the
                      resolver now drops ambiguous candidates rather than guessing across duplicate symbols
                    </li>
                    <li>
                      The LUSD B.Protocol Stability Pool row is conservative by design: it includes projected LQTY
                      incentives only and excludes ETH liquidation gains
                    </li>
                    <li>Price-derived APY (Tier 3) can be noisy for low-liquidity NAV tokens</li>
                  </ul>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
