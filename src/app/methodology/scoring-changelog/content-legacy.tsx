import type { ReactNode } from "react";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { ChangelogTable, WeightRow, changelogTableClassNames } from "./content-shared";

export const scoringChangelogLegacyDetails: Record<string, ReactNode> = {
  "4.1": (
    <>
      <p>
        Liquidity 25%&rarr;30% (&ldquo;swappability is the most defining aspect of a stablecoin&rdquo;), resilience
        25%&rarr;20%.
      </p>
      <p>5 coins reclassified from centralized-dependent to decentralized: crvUSD, FRXUSD, USR, GYD, ALUSD.</p>
      <WeightRow values={["multiplier", "30%", "\u2014", "20%", "15%", "25%"]} />
    </>
  ),
  "4.0": (
    <>
      <p>
        <span className="text-foreground font-medium">Biggest structural change.</span> Peg Stability removed from the
        weighted base dimensions entirely and applied as a post-hoc power-curve multiplier:
      </p>
      <div className="rounded-lg border p-3 pharos-numeric text-xs bg-muted">
        final = base &times; (pegScore / 100) ^ 0.20
      </div>
      <ChangelogTable
        ariaLabel="Safety Score v4 pegScore multiplier examples"
        tableId="scoring-v4-pegscore-multiplier"
        testId="scoring-v4-pegscore-multiplier-table"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              pegScore
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Multiplier
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Impact
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>100</TableCell>
            <TableCell className={changelogTableClassNames.cell}>1.000</TableCell>
            <TableCell className={changelogTableClassNames.cell}>none</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>90</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&asymp;0.979</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&minus;2%</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>50</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&asymp;0.870</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&minus;13%</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>10</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&asymp;0.631</TableCell>
            <TableCell className={changelogTableClassNames.cell}>&minus;37%</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>0</TableCell>
            <TableCell className={changelogTableClassNames.cell}>0</TableCell>
            <TableCell className={changelogTableClassNames.cell}>dead</TableCell>
          </TableRow>
        </TableBody>
      </ChangelogTable>
      <p>
        Grade thresholds lowered 5 points to compensate for structural deflation. Minimum rated base dimensions reduced
        from 3 to 2.
      </p>
      <WeightRow values={["multiplier", "25%", "\u2014", "25%", "10%", "30%"]} />
    </>
  ),
  "3.3": (
    <>
      <p>
        For coins with curated reserve composition data, collateral quality is computed as a weighted average of
        per-slice risk scores instead of using the enum fallback:
      </p>
      <ChangelogTable
        ariaLabel="Safety Score v3.3 reserve risk tiers"
        tableId="scoring-v3-reserve-risk-tiers"
        testId="scoring-v3-reserve-risk-tiers-table"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Reserve risk tier
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Score
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ["very-low", "100"],
            ["low", "75"],
            ["medium", "50"],
            ["high", "25"],
            ["very-high", "5"],
          ].map(([tier, score]) => (
            <TableRow key={tier}>
              <TableCell className={changelogTableClassNames.rowHeader}>{tier}</TableCell>
              <TableCell className={changelogTableClassNames.cell}>{score}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </ChangelogTable>
    </>
  ),
  "3.2": (
    <>
      <p>
        New dependency types: <code className="text-xs bg-muted px-1 py-0.5 rounded">wrapper</code>,{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">mechanism</code>,{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">collateral</code> (default). After blended score is
        computed, ceilings apply:
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">wrapper</span> &rarr; ceiling = upstream &minus; 3
        </li>
        <li>
          <span className="text-foreground font-medium">mechanism</span> &rarr; ceiling = upstream
        </li>
        <li>
          <span className="text-foreground font-medium">collateral</span> &rarr; no ceiling
        </li>
      </ul>
      <p>Prevents thin wrappers (e.g. a USDC wrapper) from scoring higher than their upstream.</p>
    </>
  ),
  "3.0": (
    <>
      <p>
        Complete redesign of Resilience from 2 factors (chain distribution + freeze rate) to 4 equal sub-factors (25%
        each):
      </p>
      <ChangelogTable
        ariaLabel="Safety Score v3 resilience sub-factors"
        tableId="scoring-v3-resilience-subfactors"
        testId="scoring-v3-resilience-subfactors-table"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Sub-factor
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Tiers &amp; scores
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Chain Risk</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Collateral Quality</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              native=100, eth-lst=66, alt-lst-bridged-or-mixed=20, rwa=50, exotic=0
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Custody Model</TableCell>
            <TableCell className={changelogTableClassNames.cell}>onchain=100, institutional=50, cex=0</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Blacklist Capability</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              not-blacklistable=100, possible=50, blacklistable=0
            </TableCell>
          </TableRow>
        </TableBody>
      </ChangelogTable>
      <WeightRow values={["25%", "20%", "\u2014", "20%", "10%", "25%"]} />
    </>
  ),
  "2.0": (
    <>
      <p>
        Only ~20 of 142 coins had Bluechip ratings. Sparse coverage caused inconsistent weight redistribution. Safety
        dimension removed entirely; Bluechip display kept for informational use.
      </p>
      <WeightRow values={["25%", "25%", "removed", "15%", "10%", "25%"]} />
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Other changes in the v2 era</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>Self-backed CeFi-Dependent score lowered 95&rarr;75 (systemic coupling risk)</li>
          <li>Active-depeg cap and +3 bonus removed from peg stability (pegScore already encodes severity)</li>
          <li>HHI concentration penalty removed from liquidity</li>
          <li>
            Decentralization widened: decentralized 95&rarr;100, centralized-dependent 70&rarr;50, centralized 50&rarr;0
          </li>
          <li>&ldquo;Possible&rdquo; blacklist tier added (0/50/100 scale)</li>
          <li>
            Chain-risk penalty on decentralization: stage1-l2 &minus;15, established-alt-l1 &minus;50, unproven
            &minus;65
          </li>
        </ul>
      </div>
    </>
  ),
  "1.0": (
    <>
      <p>Six weighted dimensions:</p>
      <ChangelogTable
        ariaLabel="Safety Score v1 weighted dimensions"
        tableId="scoring-v1-weighted-dimensions"
        testId="scoring-v1-weighted-dimensions-table"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Dimension
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Weight
            </TableHead>
            <TableHead scope="col" className={changelogTableClassNames.head}>
              Approach
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Peg Stability</TableCell>
            <TableCell className={changelogTableClassNames.cell}>25%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              pegScore passthrough, capped at 65 during active depeg, +3 bonus if last depeg &gt; 12 months ago
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Liquidity</TableCell>
            <TableCell className={changelogTableClassNames.cell}>25%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              liquidityScore from DEX data, HHI penalty (&minus;5 if &gt;0.5, &minus;10 if &gt;0.8)
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Safety</TableCell>
            <TableCell className={changelogTableClassNames.cell}>20%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              Bluechip rating passthrough (A+=100 &hellip; F=25), NR if no rating
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Resilience</TableCell>
            <TableCell className={changelogTableClassNames.cell}>15%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              2-factor: chain distribution 60% + freeze rate 40%
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Decentralization</TableCell>
            <TableCell className={changelogTableClassNames.cell}>10%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              3-tier: decentralized=95, centralized-dependent=70, centralized=50
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={changelogTableClassNames.rowHeader}>Dependency Risk</TableCell>
            <TableCell className={changelogTableClassNames.cell}>5%</TableCell>
            <TableCell className={changelogTableClassNames.cell}>
              CeFi-Dependent only, unweighted avg of upstream scores
            </TableCell>
          </TableRow>
        </TableBody>
      </ChangelogTable>
      <p>
        Grade thresholds: A+&ge;97, A&ge;93, A&minus;&ge;90, B+&ge;85, B&ge;80, B&minus;&ge;75, C+&ge;70, C&ge;65,
        C&minus;&ge;60, D&ge;50. Minimum 3 rated dimensions required.
      </p>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Day-one patches</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>Dependencies switched from unweighted to weighted averages</li>
          <li>Dependency renormalization fix: partial backing properly penalized via self-backed blending</li>
          <li>Peg +3 bonus restricted to coins with actual depeg history</li>
          <li>NAV tokens included in grading</li>
          <li>Rebalanced: dependency 5%&rarr;15%, resilience 15%&rarr;10%, decentralization 10%&rarr;5%</li>
        </ul>
      </div>
    </>
  ),
};
