import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Safety Scores Changelog — Version History",
  description:
    "Full version history of the Pharos safety scoring methodology, from v1.0 through v5.5. Every weight change, new dimension, and structural decision documented.",
  alternates: { canonical: "/methodology/scoring-changelog/" },
  openGraph: {
    title: "Safety Scores Changelog — Version History",
    description:
      "Full version history of the Pharos safety scoring methodology, from v1.0 through v5.5.",
    url: "/methodology/scoring-changelog/",
  },
};

/* ── tiny helpers ────────────────────────────────────────────────── */

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function VersionCard({
  version,
  title,
  date,
  accent,
  children,
}: {
  version: string;
  title: string;
  date: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={`rounded-xl border-l-[3px] ${accent}`}>
      <CardHeader>
        <CardTitle as="h2">
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{version}</Pill>
            {title}
            <span className="text-sm font-normal text-muted-foreground">
              {date}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
        {children}
      </CardContent>
    </Card>
  );
}

function WeightRow({
  values,
}: {
  values: [string, string, string, string, string, string];
}) {
  const headers = [
    "Peg",
    "Liquidity",
    "Safety",
    "Resilience",
    "Decentralization",
    "Dep Risk",
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            {headers.map((h) => (
              <th
                key={h}
                className="py-2 pr-4 font-medium text-foreground last:pr-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {values.map((v, i) => (
              <td key={i} className="py-2 pr-4 last:pr-0">
                {v}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────────── */

export default function ScoringChangelogPage() {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd
        name="Scoring Changelog"
        path="/methodology/scoring-changelog/"
      />

      {/* Breadcrumb + heading */}
      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link
            href="/"
            className="hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
          <span>/</span>
          <Link
            href="/methodology"
            className="hover:text-foreground transition-colors"
          >
            Methodology
          </Link>
          <span>/</span>
          <span className="text-foreground">Scoring Changelog</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">
          Safety Scores Changelog
        </h1>
        <p className="text-sm text-muted-foreground">
          Full version history of the grading methodology &mdash; every weight
          change, new dimension, and structural decision from v1.0 to v5.5.
        </p>
      </div>

      {/* ──────────── v5.5 ──────────── */}
      <VersionCard
        version="v5.5"
        title="Peg score fairness for young coins"
        date="Mar 1"
        accent="border-l-amber-500"
      >
        <p>
          Three fixes to the peg score formula that prevent young coins with chronic
          depegs from scoring artificially high:
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground font-medium">Tracking window capped at coin age</span>
            {" "}&mdash; uses the coin&apos;s earliest supply snapshot instead of always
            defaulting to a 4-year window. A 30-day-old coin is now scored over 30 days,
            not 1,461.
          </li>
          <li>
            <span className="text-foreground font-medium">Severity magnitude floor</span>
            {" "}&mdash; every depeg event carries a minimum penalty of
            (peakBps&nbsp;/&nbsp;2000)&nbsp;&times;&nbsp;recencyWeight, regardless of
            duration. Hundreds of brief high-magnitude depegs now accumulate real cost.
          </li>
          <li>
            <span className="text-foreground font-medium">Active depeg penalty steepened</span>
            {" "}&mdash; floor raised from 2 to 5, divisor changed from 200 to 50.
            A 500&nbsp;bps ongoing depeg now costs 10 points (was 2.5).
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.4 ──────────── */}
      <VersionCard
        version="v5.4"
        title="No-liquidity penalty"
        date="Feb 28"
        accent="border-l-amber-500"
      >
        <p>
          When the Liquidity dimension is NR (no DEX data), the overall score
          now receives a <span className="text-foreground font-medium">10% penalty</span> instead
          of silently redistributing the weight to other dimensions.
        </p>
        <div className="rounded-lg border p-3 font-mono text-xs bg-muted">
          final = score &times; 0.9
        </div>
        <p>
          As DEX pipeline coverage matures, absence of liquidity data is
          increasingly suspect and should not inflate grades.
        </p>
      </VersionCard>

      {/* ──────────── v5.3 ──────────── */}
      <VersionCard
        version="v5.3"
        title="Remove chain infra from Resilience"
        date="Feb 28"
        accent="border-l-amber-500"
      >
        <p>
          Chain infrastructure was scored in{" "}
          <span className="text-foreground font-medium">both</span> Resilience
          (as a 25% sub-factor) and Decentralization (as a penalty) &mdash;
          double-counting chain risk.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Chain infra now scored{" "}
            <span className="text-foreground font-medium">
              exclusively in Decentralization
            </span>
          </li>
          <li>
            Resilience becomes a 3-factor model (each &frac13;): Collateral
            Quality, Custody Model, Blacklist Capability
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.2 ──────────── */}
      <VersionCard
        version="v5.2"
        title="Immutable-code governance tier"
        date="Feb 28"
        accent="border-l-amber-500"
      >
        <p>
          New highest GovernanceQuality tier:{" "}
          <span className="text-foreground font-medium">
            immutable-code &rarr; 100
          </span>
          . For protocols with no admin keys, no upgrade path, no DAO attack
          surface (e.g. LUSD, BOLD). Exempt from chain infrastructure penalty.
        </p>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">
            Full GovernanceQuality tiers
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-4 font-medium text-foreground">
                    Tier
                  </th>
                  <th className="py-2 font-medium text-foreground">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[
                  ["immutable-code", "100"],
                  ["dao-governance", "85"],
                  ["multisig", "55"],
                  ["regulated-entity", "40"],
                  ["single-entity", "20"],
                  ["wrapper", "10"],
                ].map(([tier, score]) => (
                  <tr key={tier}>
                    <td className="py-2 pr-4 text-foreground">{tier}</td>
                    <td className="py-2">{score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </VersionCard>

      {/* ──────────── v5.1 ──────────── */}
      <VersionCard
        version="v5.1"
        title="Regulated-entity tier + blacklist softening"
        date="Feb 28"
        accent="border-l-amber-500"
      >
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground font-medium">
              Blacklist scoring softened
            </span>
            : blacklistable 0&rarr;33, possible 50&rarr;66, not-blacklistable
            100 (unchanged). Non-zero floor for blacklistable tokens.
          </li>
          <li>
            <span className="text-foreground font-medium">
              regulated-entity tier
            </span>{" "}
            added (score 40). Auto-promoted from single-entity when:
            jurisdiction regulator + license set, and proof of reserves via
            independent audit. Exempt from chain infra penalty.
          </li>
          <li>
            <span className="text-foreground font-medium">
              Grade thresholds lowered 5 points
            </span>{" "}
            (C-range overcrowding after blacklist/decentralization changes).
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.0 ──────────── */}
      <VersionCard
        version="v5.0"
        title="GovernanceQuality + universal dependency scoring"
        date="Feb 28"
        accent="border-l-amber-500"
      >
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">
            Decentralization: 3-tier &rarr; 6-tier GovernanceQuality
          </h3>
          <p>
            The blunt 3-level governance type (decentralized / centralized-dependent /
            centralized) replaced by a 6-tier GovernanceQuality scale, inferred
            from governance type when not explicitly set.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">
            Dependency Risk: universal, not CeFi-only
          </h3>
          <p>
            All coins with upstream dependencies are now scored &mdash; not just
            centralized-dependent ones. Self-backed scores vary by governance
            type: decentralized 90, centralized-dependent 75, centralized 95.
            Dependencies auto-derived from reserve composition data.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">
            Chain infrastructure restructured
          </h3>
          <p>
            New two-axis model: ChainTier &times; DeploymentModel multiplier.
            Threshold-based penalty applied to the Decentralization dimension.
          </p>
        </div>
        <WeightRow
          values={["multiplier", "30%", "\u2014", "20%", "15%", "25%"]}
        />
      </VersionCard>

      {/* ──────────── v4 ──────────── */}
      <VersionCard
        version="v4.1"
        title="Liquidity weight increase + reclassifications"
        date="Feb 27"
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
        version="v4.0"
        title="Peg stability becomes a multiplier"
        date="Feb 27"
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
          final = base &times; (PSI / 100) ^ 0.20
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4 font-medium text-foreground">PSI</th>
                <th className="py-2 pr-4 font-medium text-foreground">
                  Multiplier
                </th>
                <th className="py-2 font-medium text-foreground">Impact</th>
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
        version="v3.3"
        title="Reserve-derived collateral quality"
        date="Feb 27"
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
                <th className="py-2 pr-4 font-medium text-foreground">
                  Reserve risk tier
                </th>
                <th className="py-2 font-medium text-foreground">Score</th>
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
        version="v3.2"
        title="Dependency type ceilings"
        date="Feb 27"
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
        version="v3.0"
        title="Resilience 4-factor model"
        date="Feb 26"
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
                <th className="py-2 pr-4 font-medium text-foreground">
                  Sub-factor
                </th>
                <th className="py-2 font-medium text-foreground">
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
        version="v2.0"
        title="Remove Safety dimension"
        date="Feb 26"
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
              Active-depeg cap and +3 bonus removed from peg stability (PSI
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
        version="v1.0"
        title="Initial implementation"
        date="Feb 25"
        accent="border-l-zinc-500"
      >
        <p>Six weighted dimensions:</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4 font-medium text-foreground">
                  Dimension
                </th>
                <th className="py-2 pr-4 font-medium text-foreground">
                  Weight
                </th>
                <th className="py-2 font-medium text-foreground">Approach</th>
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

      {/* ──────────── Summary tables ──────────── */}
      <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
        <CardHeader>
          <CardTitle as="h2">Quick Reference</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Weight evolution</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Version
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Peg
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Liquidity
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Safety
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Resilience
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Decentralization
                    </th>
                    <th className="py-2 font-medium text-foreground">
                      Dep Risk
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[
                    ["v1.0", "25%", "25%", "20%", "15%", "10%", "5%"],
                    ["v1.0 patch", "25%", "25%", "20%", "10%", "5%", "15%"],
                    ["v2.0", "25%", "25%", "removed", "15%", "10%", "25%"],
                    ["v3.0", "25%", "20%", "\u2014", "20%", "10%", "25%"],
                    ["v3.3", "25%", "20%", "\u2014", "20%", "15%", "25%"],
                    [
                      "v4.0",
                      "multiplier",
                      "25%",
                      "\u2014",
                      "25%",
                      "10%",
                      "30%",
                    ],
                    [
                      "v4.1",
                      "multiplier",
                      "30%",
                      "\u2014",
                      "20%",
                      "15%",
                      "25%",
                    ],
                    [
                      "v5.0\u20135.4",
                      "multiplier",
                      "30%",
                      "\u2014",
                      "20%",
                      "15%",
                      "25%",
                    ],
                  ].map(([v, ...rest]) => (
                    <tr key={v}>
                      <td className="py-2 pr-4 text-foreground font-medium">
                        {v}
                      </td>
                      {rest.map((val, i) => (
                        <td key={i} className="py-2 pr-4 last:pr-0">
                          {val}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">
              Grade threshold evolution
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">
                      Grade
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      v1.0
                    </th>
                    <th className="py-2 pr-4 font-medium text-foreground">
                      v4.0 (&minus;5)
                    </th>
                    <th className="py-2 font-medium text-foreground">
                      v5.1 (&minus;5)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[
                    ["A+", "97", "92", "87"],
                    ["A", "93", "88", "83"],
                    ["A\u2212", "90", "85", "80"],
                    ["B+", "85", "80", "75"],
                    ["B", "80", "75", "70"],
                    ["B\u2212", "75", "70", "65"],
                    ["C+", "70", "65", "60"],
                    ["C", "65", "60", "55"],
                    ["C\u2212", "60", "55", "50"],
                    ["D", "50", "45", "40"],
                    ["F", "0", "0", "0"],
                  ].map(([grade, v1, v4, v5]) => (
                    <tr key={grade}>
                      <td className="py-2 pr-4 text-foreground font-medium">
                        {grade}
                      </td>
                      <td className="py-2 pr-4">{v1}</td>
                      <td className="py-2 pr-4">{v4}</td>
                      <td className="py-2 text-foreground font-medium">
                        {v5}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
