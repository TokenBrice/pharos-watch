import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { SafetyScoreCalculator } from "@/components/methodology/safety-score-calculator";
import { CollateralQualityMethodologyCopy } from "../core-sections-fragments";

export function SafetyScoresMethodologySection() {
  return (
          <MethodologySectionShell
            id="safety-scores-methodology"
            title="Safety Scores Grading Methodology"
            versionLabel={SAFETY_SCORE_VERSION_LABEL}
            changelogPath={SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when weights, thresholds, or dimension definitions change."
            accentClassName="border-l-amber-500"
            badgeClassName="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            changelogClassName="hover:text-amber-700 dark:text-amber-400"
          >
              <p>
                Pharos synthesizes multiple data signals into a single transparent grade per stablecoin. The overall score
                is computed in two steps: first, a weighted average of four base dimensions (exit liquidity, resilience,
                decentralization, dependency risk), then a peg stability multiplier that penalizes coins with poor pegs
                while barely affecting well-pegged ones. The exit-liquidity dimension blends raw DEX liquidity with
                redemption-backstop quality when a direct exit path exists. When some base dimensions lack data (NR), their
                weight is redistributed proportionally among rated ones.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Model shape", value: "4 dimensions + peg multiplier" },
                  { label: "Grade output", value: "A+ to F, with NR" },
                  { label: "Key caveat", value: "No exit signal = 10% penalty" },
                ]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <MethodologyFacts
                  facts={[
                    { label: "Minimum data", value: "At least 2 rated non-peg dimensions" },
                    { label: "Required sources", value: "Peg summary, DEX liquidity/redemption data, and dependency/metadata inputs" },
                    {
                      label: "Failure behavior",
                      value: "NR if peg is missing on non-NAV coins; 0.9 penalty applies when exit liquidity is NR (no DEX data and no redemption backstop signal available)",
                    },
                  ]}
                />
              </div>
              <WorkedExample summary="Worked example (verified against computeOverallGrade)">
                <p className="font-mono">Inputs: DEX 30, Redemption 88, Exit 56, Res 70, Decen 60, Dep 75, Peg 92</p>
                <p className="font-mono">base=(56*0.30+70*0.20+60*0.15+75*0.25)/0.90=65.06</p>
                <p className="font-mono">final=round(base*(92/100)^0.20)=round(65.06*0.9835)=64</p>
                <p>
                  Result: <span className="text-foreground">Score 64 (grade C+)</span>.
                </p>
              </WorkedExample>

              <MethodologyDetails summary="Interactive calculator: explore how weights and thresholds shape the grade">
                <SafetyScoreCalculator />
              </MethodologyDetails>

              <MethodologyDetails summary="Technical details: full pipeline, dimension formulas, thresholds, and caveats">
                {/* Scoring pipeline diagram — desktop: horizontal dimension row then vertical flow */}
                <div className="hidden md:flex flex-col items-center gap-3">
                  <div className="grid grid-cols-4 gap-3 w-full">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Exit Liquidity</p>
                      <p className="text-xs text-muted-foreground mt-0.5">30%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Resilience</p>
                      <p className="text-xs text-muted-foreground mt-0.5">20%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Decentralization</p>
                      <p className="text-xs text-muted-foreground mt-0.5">15%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium">Dependency Risk</p>
                      <p className="text-xs text-muted-foreground mt-0.5">25%</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="rounded-lg border p-3 text-center w-64">
                    <p className="text-foreground font-medium">Weighted Average</p>
                    <p className="text-xs text-muted-foreground mt-0.5">base score</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="rounded-lg border p-3 text-center w-64">
                    <p className="text-foreground font-medium">&times; Peg Multiplier</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      (pegScore / 100)<sup>0.20</sup>
                    </p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="rounded-lg border border-amber-500/40 p-3 text-center w-64">
                    <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
                    <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="rounded-lg border p-3 text-center w-64">
                    <p className="text-foreground font-medium">Final Grade</p>
                    <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
                  </div>
                </div>

                {/* Scoring pipeline diagram — mobile: vertical stack */}
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="grid grid-cols-2 gap-2 w-full">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Exit Liquidity</p>
                      <p className="text-xs text-muted-foreground">30%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Resilience</p>
                      <p className="text-xs text-muted-foreground">20%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Decentralization</p>
                      <p className="text-xs text-muted-foreground">15%</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-foreground font-medium text-xs">Dep. Risk</p>
                      <p className="text-xs text-muted-foreground">25%</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Weighted Average</p>
                    <p className="text-xs text-muted-foreground mt-0.5">base score</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">&times; Peg Multiplier</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      (pegScore / 100)<sup>0.20</sup>
                    </p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border border-amber-500/40 p-3 text-center">
                    <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
                    <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Final Grade</p>
                    <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
                  </div>
                </div>

                {/* Dimensions table */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Base Dimensions (weighted average)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Dimension</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Weight</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Source</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Description</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Exit Liquidity</td>
                          <td className="py-2 pr-4">30%</td>
                          <td className="py-2 pr-4">DEX liquidity + redemption backstop</td>
                          <td className="py-2">Uses effective exit: DEX liquidity stays the floor, redemption can improve the dimension when a direct exit path exists</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Resilience</td>
                          <td className="py-2 pr-4">20%</td>
                          <td className="py-2 pr-4">Collateral, custody</td>
                          <td className="py-2">2-factor solvency measure; blacklist capability reported descriptively only</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Decentralization</td>
                          <td className="py-2 pr-4">15%</td>
                          <td className="py-2 pr-4">Governance type, chain risk</td>
                          <td className="py-2">Governance structure with chain-risk penalty</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                          <td className="py-2 pr-4">25%</td>
                          <td className="py-2 pr-4">Upstream grades, collateral weights</td>
                          <td className="py-2">Inherited risk from upstream stablecoins, weighted by exposure</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Redemption Backstop and Effective Exit</h3>
                  <p>
                    The standalone Liquidity Score remains a pure DEX market-depth metric. Safety Scores now use an
                    <span className="text-foreground font-medium"> effective exit score</span> for the Liquidity dimension:
                    DEX liquidity is preserved as the floor, while redeemable assets can gain uplift from protocol or issuer
                    redemption quality when the redemption route is both resolved and supported by more than a heuristic
                    capacity model.
                  </p>
                  <p className="font-mono">
                    effectiveExit = max(liquidity, liquidity * 0.55 + redemption * 0.45), with redemption-only capped at 70
                  </p>
                  <p>
                    Redemption backstops are scored across access, settlement, execution certainty, capacity, output-asset
                    quality, and cost. Queue-based and offchain issuer routes are capped so they do not look unrealistically
                    liquid. Low-confidence redemption routes stay visible on the site but do not uplift the Safety Score
                    liquidity dimension, stale DEX inputs are not blended into effective exit, stale live reserve metadata ages out instead of staying resolved indefinitely, fresh live fee telemetry can replace reviewed fallback fee buckets when available, and eventual issuer redemption is reported separately from immediate redeemable buffer capacity.
                    Reviewed `documented-bound` eventual redemption routes can still count as medium-confidence evidence even when no separate live instant buffer is measured, and explicitly published primary-market liquidity-buffer ratios can also graduate out of the heuristic bucket when the underlying source is strong enough. Strategy-backed delta-neutral rails still need an explicit published buffer or live telemetry before they stop being treated as heuristic capacity.
                    Reserve-backed routes still fail closed on degraded live evidence by default, but a route can keep a live lower bound when the only blocking warning says reserve coverage is incomplete rather than that the measured redeemable buffer is invalid.
                  </p>
                </div>
                {/* Peg multiplier */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
                  <p>
                    After computing the base score, peg stability is applied as a power-curve multiplier:
                    final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(pegScore&nbsp;/&nbsp;100)<sup>0.20</sup>. Coins with strong
                    pegs (90+) are barely affected (~2% penalty), while coins with broken pegs are properly penalized (e.g.
                    pegScore&nbsp;10 &rarr; 37% penalty). NAV tokens (pegScore&nbsp;=&nbsp;NR) receive multiplier&nbsp;1.0
                    since peg tracking does not apply to them.
                  </p>
                </div>
                {/* No-liquidity penalty */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">No-Liquidity-Data Penalty</h3>
                  <p>
                    A further 0.9&times; multiplier is applied when a coin has no exit-liquidity signal at all —
                    neither DEX liquidity nor redemption-backstop coverage. Weights are redistributed across available 
                    dimensions; this 0.9&times; multiplier is then applied to the final score to correct for the missing 
                    liquidity data by applying a flat 10% penalty.
                  </p>
                </div>
                {/* Resilience sub-factors */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Resilience Scoring</h3>
                  <p>
                    Average of two equally-weighted sub-factors (50% each): Collateral Quality and Custody Model. Chain
                    infrastructure is scored exclusively in the Decentralization dimension. Blacklist capability is reported
                    descriptively but does not affect the Resilience score.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Sub-factor</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">What it measures</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Scoring</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Collateral Quality</td>
                          <td className="py-2 pr-4">Reserve composition risk</td>
                          <td className="py-2">
                            Weighted avg of curated reserve slices: Very&nbsp;Low&nbsp;(100), Low&nbsp;(75),
                            Medium&nbsp;(50), High&nbsp;(25), Very&nbsp;High&nbsp;(5). Falls back to enum scoring for coins
                            without curated reserves.
                          </td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-2 pr-4 text-foreground">Custody Model</td>
                          <td className="py-2 pr-4">Who holds the collateral?</td>
                          <td className="py-2">
                            Fully&nbsp;on&#8209;chain&nbsp;(100), Top&#8209;tier&nbsp;custodian&nbsp;(80),
                            Regulated&nbsp;custodian&nbsp;(55), Unregulated&nbsp;custodian&nbsp;(30),
                            Sanctioned&nbsp;custodian&nbsp;(5), CEX&nbsp;/&nbsp;off&#8209;exchange&nbsp;custody&nbsp;(0)
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <CollateralQualityMethodologyCopy />
                </div>

                {/* Decentralization scoring */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Decentralization Scoring</h3>
                  <p>
                    Base score from governance quality tier, then a chain-risk penalty for protocols on less decentralized
                    chains &mdash; governance decentralization is undermined when the underlying chain has centralisation
                    concerns:
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Immutable code</span> &mdash; 100 (no admin keys, no upgrade path
                      &mdash; e.g.&nbsp;LUSD, BOLD). Exempt from chain-risk penalty
                    </li>
                    <li>
                      <span className="text-foreground">DAO governance</span> &mdash; 85 (e.g.&nbsp;DAI)
                    </li>
                    <li>
                      <span className="text-foreground">Multisig</span> &mdash; 55 (e.g.&nbsp;GHO, FRAX)
                    </li>
                    <li>
                      <span className="text-foreground">Regulated entity</span> &mdash; 40 (named regulator, license, and
                      independent audit &mdash; e.g.&nbsp;USDC, USDT)
                    </li>
                    <li>
                      <span className="text-foreground">Single entity</span> &mdash; 20 (unregulated or unverified issuer)
                    </li>
                    <li>
                      <span className="text-foreground">Wrapper</span> &mdash; 10 (inherits upstream governance)
                    </li>
                  </ul>
                  <p className="font-medium text-foreground mt-2">
                    Chain-risk penalty (DAO and multisig governance &mdash; exempt for immutable-code, wrapper,
                    regulated-entity, single-entity):
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Combined score &ge;80 &mdash; no penalty</li>
                    <li>Combined score &ge;60 &mdash; &minus;10</li>
                    <li>Combined score &ge;40 &mdash; &minus;25</li>
                    <li>Combined score &ge;20 &mdash; &minus;40</li>
                    <li>Combined score &lt;20 &mdash; &minus;60</li>
                  </ul>
                  <p className="text-xs">
                    Example: hyUSD (DAO governance, Solana, combined score 45) = 85 &minus; 25 = <span className="text-foreground">60</span>.
                    USDB (multisig, Blast L2, combined score 66) = 55 &minus; 10 = <span className="text-foreground">45</span>.
                  </p>
                </div>

                {/* Dependency Risk scoring */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
                  <p>
                    Two-phase computation ensures upstream scores are available before dependent coins are graded. Phase 1
                    grades independent coins (centralized &amp; decentralized), then Phase 2 grades CeFi-Dependent coins
                    using Phase 1 results.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Non-dependent coins</span> &mdash; score 95 (no upstream risk)
                    </li>
                    <li>
                      <span className="text-foreground">With mapped dependencies</span> &mdash; blended score: each
                      upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion
                      (non-stablecoin collateral) scores vary by governance type (decentralized&nbsp;90,
                      centralized-dependent&nbsp;75, centralized&nbsp;95). A &minus;10 penalty applies if any upstream
                      dependency scores below 75
                    </li>
                    <li>
                      <span className="text-foreground">Unmapped dependencies</span> &mdash; falls back to 70 when
                      dependencies aren&apos;t mapped or scores are unavailable
                    </li>
                  </ul>
                  <p className="mt-2">
                    <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is
                    classified as <em>wrapper</em>, <em>mechanism-critical</em>, or <em>collateral</em> (default). Wrappers
                    (e.g., syrupUSDC &rarr; USDC) are thin layers around the upstream &mdash; their score is capped at{" "}
                    <code className="text-xs">upstream &minus; 3</code>. Mechanism-critical dependencies (e.g., DAI &rarr;
                    USDC via PSM) are essential to the peg &mdash; score is capped at the upstream&apos;s score. Collateral
                    dependencies use the blended formula with no ceiling.
                  </p>
                  <p className="text-xs">
                    Self-backed scores vary by governance type: centralized-dependent coins score 75 (systemic coupling
                    risk), decentralized coins 90, and centralized coins 95. Centralized-dependent coins score lower because
                    their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
                  </p>
                </div>

                {/* Grade thresholds */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Grade Thresholds</h3>
                  <div className="overflow-x-auto">
                    <table className="text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-8 font-medium text-foreground">Grade</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Score Range</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">A+</td>
                          <td className="py-1.5">87&ndash;100</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">A</td>
                          <td className="py-1.5">83&ndash;86</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">A&minus;</td>
                          <td className="py-1.5">80&ndash;82</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">B+</td>
                          <td className="py-1.5">75&ndash;79</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">B</td>
                          <td className="py-1.5">70&ndash;74</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">B&minus;</td>
                          <td className="py-1.5">65&ndash;69</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">C+</td>
                          <td className="py-1.5">60&ndash;64</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">C</td>
                          <td className="py-1.5">55&ndash;59</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">C&minus;</td>
                          <td className="py-1.5">50&ndash;54</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">D</td>
                          <td className="py-1.5">40&ndash;49</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">F</td>
                          <td className="py-1.5">0&ndash;39</td>
                        </tr>
                        <tr className="hover:bg-muted/40 transition-colors">
                          <td className="py-1.5 pr-8 text-foreground">NR</td>
                          <td className="py-1.5">Not enough data</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Key design decisions */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Key Design Decisions</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground font-medium">NR (Not Rated)</span> is used when fewer than 2 base
                      dimensions have data &mdash; no misleading partial grades
                    </li>
                    <li>Weight is redistributed proportionally among rated base dimensions when some are NR</li>
                    <li>
                      Peg stability acts as a multiplier, not a base dimension &mdash; maintaining a peg is table stakes,
                      not a differentiator
                    </li>
                    <li>Cemetery (defunct) coins receive a permanent F</li>
                    <li>Decentralization score is structural, not a value judgment</li>
                    <li>
                      Blacklist capability is reported descriptively only and does not affect the Resilience score.
                      Explicit mutable-contract overrides still surface as &ldquo;possible&rdquo;, but reserve-side
                      stablecoin and custody/CEX clues can now also resolve to &ldquo;possible&rdquo; when exposure is
                      below the inherited threshold. Stablecoins where a majority of reserves (by weight) are backed by
                      directly blacklistable collateral or already-blacklistable upstream assets are flagged as
                      &ldquo;inherited&rdquo; blacklist risk
                    </li>
                  </ul>
                </div>

                {/* Dependency ceilings */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Dependency Ceilings</h3>
                  <p>
                    When a stablecoin depends on another (wrapper, mechanism, or collateral relationship), its dependency
                    risk score is capped relative to its upstream:
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <strong>Wrapper dependency:</strong> capped at upstream score minus 3 points
                    </li>
                    <li>
                      <strong>Mechanism dependency:</strong> capped at upstream score
                    </li>
                    <li>
                      <strong>Collateral dependency:</strong> blended into dependency risk dimension via weighted average
                    </li>
                  </ul>
                  <p>
                    If any upstream dependency scores below 75, a 10-point penalty is applied. These ceilings prevent a
                    wrapped token from outscoring its underlying asset.
                  </p>
                </div>

                {/* Limitations */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Limitations</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because
                      nobody trades them
                    </li>
                    <li>Decentralization is structural, not a value judgment</li>
                    <li>Dependency map is manually maintained &mdash; may not capture every collateral relationship</li>
                  </ul>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
