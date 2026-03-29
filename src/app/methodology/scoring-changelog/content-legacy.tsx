import { VersionCard, WeightRow, getScoringEntry } from "./content-shared";

export function ScoringChangelogLegacyEntries() {
  return (
    <>
            {/* ──────────── v4 ──────────── */}
            <VersionCard
              entry={getScoringEntry("4.1")}
              accent="border-l-cyan-500"
            >
              <p>
                Liquidity 25%&rarr;30% (&ldquo;swappability is the most defining
                aspect of a stablecoin&rdquo;), resilience 25%&rarr;20%.
              </p>
              <p>
                5 coins reclassified from centralized-dependent to decentralized:
                crvUSD, FRXUSD, USR, GYD, ALUSD.
              </p>
              <WeightRow
                values={["multiplier", "30%", "\u2014", "20%", "15%", "25%"]}
              />
            </VersionCard>

            <VersionCard
              entry={getScoringEntry("4.0")}
              accent="border-l-cyan-500"
            >
              <p>
                <span className="text-foreground font-medium">
                  Biggest structural change.
                </span>{" "}
                Peg Stability removed from the weighted base dimensions entirely and
                applied as a post-hoc power-curve multiplier:
              </p>
              <div className="rounded-lg border p-3 font-mono text-xs bg-muted">
                final = base &times; (pegScore / 100) ^ 0.20
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">pegScore</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                        Multiplier
                      </th>
                      <th scope="col" className="py-2 font-medium text-foreground">Impact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="py-2 pr-4 text-foreground">100</td>
                      <td className="py-2 pr-4">1.000</td>
                      <td className="py-2">none</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">90</td>
                      <td className="py-2 pr-4">&asymp;0.979</td>
                      <td className="py-2">&minus;2%</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">50</td>
                      <td className="py-2 pr-4">&asymp;0.870</td>
                      <td className="py-2">&minus;13%</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">10</td>
                      <td className="py-2 pr-4">&asymp;0.631</td>
                      <td className="py-2">&minus;37%</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">0</td>
                      <td className="py-2 pr-4">0</td>
                      <td className="py-2">dead</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Grade thresholds lowered 5 points to compensate for structural
                deflation. Minimum rated base dimensions reduced from 3 to 2.
              </p>
              <WeightRow
                values={["multiplier", "25%", "\u2014", "25%", "10%", "30%"]}
              />
            </VersionCard>

            {/* ──────────── v3 ──────────── */}
            <VersionCard
              entry={getScoringEntry("3.3")}
              accent="border-l-emerald-500"
            >
              <p>
                For coins with curated reserve composition data, collateral quality is
                computed as a weighted average of per-slice risk scores instead of
                using the enum fallback:
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                        Reserve risk tier
                      </th>
                      <th scope="col" className="py-2 font-medium text-foreground">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {[
                      ["very-low", "100"],
                      ["low", "75"],
                      ["medium", "50"],
                      ["high", "25"],
                      ["very-high", "5"],
                    ].map(([tier, score]) => (
                      <tr key={tier}>
                        <td className="py-2 pr-4 text-foreground">{tier}</td>
                        <td className="py-2">{score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </VersionCard>

            <VersionCard
              entry={getScoringEntry("3.2")}
              accent="border-l-emerald-500"
            >
              <p>
                New dependency types: <code className="text-xs bg-muted px-1 py-0.5 rounded">wrapper</code>,{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">mechanism</code>,{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">collateral</code> (default).
                After blended score is computed, ceilings apply:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground font-medium">wrapper</span>{" "}
                  &rarr; ceiling = upstream &minus; 3
                </li>
                <li>
                  <span className="text-foreground font-medium">mechanism</span>{" "}
                  &rarr; ceiling = upstream
                </li>
                <li>
                  <span className="text-foreground font-medium">collateral</span>{" "}
                  &rarr; no ceiling
                </li>
              </ul>
              <p>
                Prevents thin wrappers (e.g. a USDC wrapper) from scoring higher than
                their upstream.
              </p>
            </VersionCard>

            <VersionCard
              entry={getScoringEntry("3.0")}
              accent="border-l-emerald-500"
            >
              <p>
                Complete redesign of Resilience from 2 factors (chain distribution +
                freeze rate) to 4 equal sub-factors (25% each):
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                        Sub-factor
                      </th>
                      <th scope="col" className="py-2 font-medium text-foreground">
                        Tiers &amp; scores
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Chain Risk</td>
                      <td className="py-2">
                        ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">
                        Collateral Quality
                      </td>
                      <td className="py-2">
                        native=100, eth-lst=66, alt-lst-bridged-or-mixed=20, rwa=50,
                        exotic=0
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Custody Model</td>
                      <td className="py-2">onchain=100, institutional=50, cex=0</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">
                        Blacklist Capability
                      </td>
                      <td className="py-2">
                        not-blacklistable=100, possible=50, blacklistable=0
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <WeightRow
                values={["25%", "20%", "\u2014", "20%", "10%", "25%"]}
              />
            </VersionCard>

            {/* ──────────── v2 ──────────── */}
            <VersionCard
              entry={getScoringEntry("2.0")}
              accent="border-l-violet-500"
            >
              <p>
                Only ~20 of 142 coins had Bluechip ratings. Sparse coverage caused
                inconsistent weight redistribution. Safety dimension removed entirely;
                Bluechip display kept for informational use.
              </p>
              <WeightRow
                values={["25%", "25%", "removed", "15%", "10%", "25%"]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">
                  Other changes in the v2 era
                </h3>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    Self-backed CeFi-Dependent score lowered 95&rarr;75 (systemic
                    coupling risk)
                  </li>
                  <li>
                    Active-depeg cap and +3 bonus removed from peg stability (pegScore
                    already encodes severity)
                  </li>
                  <li>HHI concentration penalty removed from liquidity</li>
                  <li>
                    Decentralization widened: decentralized 95&rarr;100,
                    centralized-dependent 70&rarr;50, centralized 50&rarr;0
                  </li>
                  <li>
                    &ldquo;Possible&rdquo; blacklist tier added (0/50/100 scale)
                  </li>
                  <li>
                    Chain-risk penalty on decentralization: stage1-l2 &minus;15,
                    established-alt-l1 &minus;50, unproven &minus;65
                  </li>
                </ul>
              </div>
            </VersionCard>

            {/* ──────────── v1 ──────────── */}
            <VersionCard
              entry={getScoringEntry("1.0")}
              accent="border-l-zinc-500"
            >
              <p>Six weighted dimensions:</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                        Dimension
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                        Weight
                      </th>
                      <th scope="col" className="py-2 font-medium text-foreground">Approach</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Peg Stability</td>
                      <td className="py-2 pr-4">25%</td>
                      <td className="py-2">
                        pegScore passthrough, capped at 65 during active depeg, +3
                        bonus if last depeg &gt; 12 months ago
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Liquidity</td>
                      <td className="py-2 pr-4">25%</td>
                      <td className="py-2">
                        liquidityScore from DEX data, HHI penalty (&minus;5 if &gt;0.5,
                        &minus;10 if &gt;0.8)
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Safety</td>
                      <td className="py-2 pr-4">20%</td>
                      <td className="py-2">
                        Bluechip rating passthrough (A+=100 &hellip; F=25), NR if no
                        rating
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Resilience</td>
                      <td className="py-2 pr-4">15%</td>
                      <td className="py-2">
                        2-factor: chain distribution 60% + freeze rate 40%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">
                        Decentralization
                      </td>
                      <td className="py-2 pr-4">10%</td>
                      <td className="py-2">
                        3-tier: decentralized=95, centralized-dependent=70,
                        centralized=50
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                      <td className="py-2 pr-4">5%</td>
                      <td className="py-2">
                        CeFi-Dependent only, unweighted avg of upstream scores
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Grade thresholds: A+&ge;97, A&ge;93, A&minus;&ge;90, B+&ge;85,
                B&ge;80, B&minus;&ge;75, C+&ge;70, C&ge;65, C&minus;&ge;60, D&ge;50.
                Minimum 3 rated dimensions required.
              </p>
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">
                  Day-one patches
                </h3>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    Dependencies switched from unweighted to weighted averages
                  </li>
                  <li>
                    Dependency renormalization fix: partial backing properly penalized
                    via self-backed blending
                  </li>
                  <li>
                    Peg +3 bonus restricted to coins with actual depeg history
                  </li>
                  <li>NAV tokens included in grading</li>
                  <li>
                    Rebalanced: dependency 5%&rarr;15%, resilience 15%&rarr;10%,
                    decentralization 10%&rarr;5%
                  </li>
                </ul>
              </div>
            </VersionCard>
    </>
  );
}
