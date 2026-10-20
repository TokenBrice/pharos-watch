import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import {
  BACKING_DIVERSITY_WEIGHT, CHAIN_ENVIRONMENT_SCORES, CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT, PEG_COVERAGE_COMPOSITE_MIN, PEG_STABILITY_WEIGHT, QUALITY_WEIGHT,
} from "@shared/lib/chains/health";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { ContentTable, type ContentTableColumn, type ContentTableRow } from "@/components/table/content-table";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { CHAIN_HEALTH_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_SECTION_ACCENT_CLASSES, CHAIN_HEALTH_TEXT_CLASSES } from "@shared/lib/classification";

const PEG_COVERAGE_COMPOSITE_MIN_PCT = Math.round(PEG_COVERAGE_COMPOSITE_MIN * 100);
/** Most the composite can move if the unobserved share (at most 1 − minimum coverage) were fully off peg. */
const MAX_UNOBSERVED_COMPOSITE_SHIFT = Math.round((1 - PEG_COVERAGE_COMPOSITE_MIN) * PEG_STABILITY_WEIGHT * 100);

const CHAIN_HEALTH_FACTORS = [
  { id: "quality", label: "Quality", weight: QUALITY_WEIGHT, meaning: <>
    Supply-weighted average of Pharos Safety Scores for stablecoins on the chain. Not-rated supply is
    excluded and the average renormalizes over rated supply. Returns null if rated supply &lt; 50% of total.
  </> },
  { id: "chainEnvironment", label: "Chain Environment", weight: CHAIN_ENVIRONMENT_WEIGHT, meaning: <>
    Rates the chain&rsquo;s own infrastructure quality with L2BEAT first for matched scaling projects, using
    stage plus Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure.
    Unmatched chains fall back to the Pharos resilience tier model.
  </> },
  { id: "concentration", label: "Concentration", weight: CONCENTRATION_WEIGHT, meaning: <>
    100&nbsp;&times;&nbsp;(1&nbsp;&minus;&nbsp;HHI) where HHI&nbsp;=&nbsp;&Sigma;(market share)&sup2;. A
    single stablecoin scores 0; perfectly even N coins score 100&times;(1&minus;1/N).
  </> },
  { id: "pegStability", label: "Peg Stability", weight: PEG_STABILITY_WEIGHT, meaning: <>
    Supply-weighted average of observed per-coin peg proximity: max(0, 100&nbsp;&minus;&nbsp;deviationBps/5).
    Missing prices or peg references receive no imputed score. Zero observed supply makes this factor NR;
    partial coverage shows the observed-only factor and full-positive-supply coverage. The composite is
    published when peg coverage is complete or at least {PEG_COVERAGE_COMPOSITE_MIN_PCT}% of chain supply,
    and stays NR below that share; an unobserved share that small can move the composite by at most{" "}
    {MAX_UNOBSERVED_COMPOSITE_SHIFT} point, and it remains disclosed beside the score.
  </> },
  { id: "backingDiversity", label: "Backing Diversity", weight: BACKING_DIVERSITY_WEIGHT, meaning: <>
    Normalized Shannon entropy across the two active backing types (RWA-backed and crypto-backed). 0 for
    monoculture, 100 for an even split.
  </> },
];
const CHAIN_HEALTH_FORMULA = `healthScore =\n${CHAIN_HEALTH_FACTORS.map(({ id, weight }, index) =>
  `    ${index === 0 ? " " : "+"} ${weight.toFixed(2)} × ${id}`).join("\n")}`;
const FACTOR_ROWS: ContentTableRow[] = CHAIN_HEALTH_FACTORS.map(({ id, label, weight, meaning }) => ({
  id, className: "align-top", cells: { factor: label, weight: `${weight * 100}%`, meaning },
}));
const L2BEAT_ROWS: ContentTableRow[] = [
  { id: "stage", cells: { component: "Stage", mapping: "Stage 2 = 100, Stage 1 = 80, Stage 0 = 55, not applicable or under review = 50" }, className: "align-top" },
  { id: "risk-fields", cells: { component: "Risk fields", mapping: "Sequencer Failure, State Validation, Data Availability, Exit Window, Proposer Failure" }, className: "align-top" },
  { id: "risk-sentiment", cells: { component: "Risk sentiment", mapping: "Good = 100, warning = 60, bad = 20, neutral or under review = 50" }, className: "align-top" },
];
const TIER_ROWS: ContentTableRow[] = [
  { id: "tier-1", cells: { tier: "Tier 1", score: CHAIN_ENVIRONMENT_SCORES[1], criteria: "Highly decentralized, battle-tested, censorship-resistant L1", examples: "Ethereum" }, className: "align-top" },
  { id: "tier-2", cells: { tier: "Tier 2", score: CHAIN_ENVIRONMENT_SCORES[2], criteria: "Established chains with moderate centralization (default for unlisted chains)", examples: "Solana, BSC, Tron, Avalanche" }, className: "align-top" },
  { id: "tier-3", cells: { tier: "Tier 3", score: CHAIN_ENVIRONMENT_SCORES[3], criteria: "Unproven, known centralization issues, or compromised security", examples: "PulseChain, Harmony, BitTorrent" }, className: "align-top" },
];
const HEALTH_BAND_ROWS: ContentTableRow[] = [
  { id: "robust", cells: { band: "Robust", range: "80–100", interpretation: "Strong, diversified stablecoin ecosystem on quality infrastructure" }, cellClassNames: { band: CHAIN_HEALTH_TEXT_CLASSES.robust } },
  { id: "healthy", cells: { band: "Healthy", range: "60–79", interpretation: "Good ecosystem with room for improvement" }, cellClassNames: { band: CHAIN_HEALTH_TEXT_CLASSES.healthy } },
  { id: "mixed", cells: { band: "Mixed", range: "40–59", interpretation: "Moderate concerns — concentration, quality gaps, or chain risk" }, cellClassNames: { band: CHAIN_HEALTH_TEXT_CLASSES.mixed } },
  { id: "fragile", cells: { band: "Fragile", range: "20–39", interpretation: "Significant ecosystem weaknesses" }, cellClassNames: { band: CHAIN_HEALTH_TEXT_CLASSES.fragile } },
  { id: "concentrated", cells: { band: "Concentrated", range: "0–19", interpretation: "Minimal diversity or critically weak infrastructure" }, cellClassNames: { band: CHAIN_HEALTH_TEXT_CLASSES.concentrated } },
];
const FACTOR_COLUMNS: ContentTableColumn[] = [
  { id: "factor", header: "Factor", cellClassName: "font-medium" },
  { id: "weight", header: "Weight" },
  { id: "meaning", header: "What it measures" },
];
const L2BEAT_COLUMNS: ContentTableColumn[] = [
  { id: "component", header: "Component", cellClassName: "font-medium" },
  { id: "mapping", header: "Mapping" },
];
const TIER_COLUMNS: ContentTableColumn[] = [
  { id: "tier", header: "Tier", cellClassName: "font-medium" },
  { id: "score", header: "Score", cellClassName: "pharos-numeric" },
  { id: "criteria", header: "Criteria" },
  { id: "examples", header: "Examples" },
];
const HEALTH_BAND_COLUMNS: ContentTableColumn[] = [
  { id: "band", header: "Band", cellClassName: "font-medium" },
  { id: "range", header: "Score Range", cellClassName: "pharos-numeric" },
  { id: "interpretation", header: "Interpretation" },
];
for (const columns of [FACTOR_COLUMNS, L2BEAT_COLUMNS, TIER_COLUMNS, HEALTH_BAND_COLUMNS]) {
  for (const column of columns) {
    column.headerClassName = "h-auto whitespace-normal px-4 py-2 text-xs text-muted-foreground";
    column.cellClassName = `whitespace-normal px-4 py-2 text-foreground ${column.cellClassName ?? ""}`;
  }
}

export function ChainHealthMethodologySection() {
  return (
    <MethodologySectionShell
      id={CHAIN_HEALTH_SECTION_CONTENT.id}
      title={CHAIN_HEALTH_SECTION_CONTENT.title}
      versionBadge={{ label: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL }}
      changelogPath={CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when factor weights, tier assignments, or sub-factor formulas change."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.chainHealth.changelogHover}
    >
      <p>
        The Chain Health Score is a 0&ndash;100 composite that rates each blockchain&rsquo;s stablecoin ecosystem across
        five weighted factors. It answers:{" "}
        <em>how healthy, diverse, and resilient is the stablecoin mix on this chain?</em>
      </p>

      <p>
        Only a fresh, accepted V10 publication contributes Safety quality. Missing, held, stale, or invalid V10 leaves
        quality and the composite NR; Chain Health never falls back to V8 or a stale score map.
      </p>

      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>
          Liquidity Score
        </a>
      </p>

      <MethodologyFacts
        facts={[
          {
            label: "Score range",
            value: `0–100 (NR when safety-score coverage < 50% or peg coverage < ${PEG_COVERAGE_COMPOSITE_MIN_PCT}%)`,
          },
          {
            label: "Refresh cadence",
            value: `${CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec / 60}-minute stablecoins cache cadence; \`/api/chains\` freshness budget is 1800 seconds`,
          },
          {
            label: "Dependencies",
            value: "DefiLlama supply, Pharos Safety Scores, peg rates, L2BEAT chain-risk snapshot",
          },
        ]}
      />

      <MethodologyDetails summary="Formula & Weights" primary>
        <p className="text-foreground font-medium">Composite formula</p>
        <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs pharos-numeric">
          {CHAIN_HEALTH_FORMULA}
        </pre>

        <ContentTable
          tableId="chain-health-factor-weights"
          testId="chain-health-factor-weights-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "Chain Health factor weights" }}
          columns={FACTOR_COLUMNS}
          rows={FACTOR_ROWS}
        />
      </MethodologyDetails>

      <MethodologyDetails summary="Chain environment sources">
        <p>
          The same stablecoin can have different security properties on different chains. A fully on-chain,
          censorship-resistant stablecoin on Ethereum mainnet may lose those guarantees on an L2 with a centralized
          sequencer. The chain environment factor captures this.
        </p>
        <p>
          Matched L2BEAT scaling projects use a static snapshot of L2BEAT stage and risk rows. The environment score
          blends <strong>40%</strong> stage score with <strong>60%</strong> average risk sentiment across the five
          L2BEAT fields. L2BEAT is not fetched live during request handling.
        </p>
        <ContentTable
          tableId="chain-health-l2beat-risk-fields"
          testId="chain-health-l2beat-risk-fields-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "L2BEAT chain environment inputs" }}
          columns={L2BEAT_COLUMNS}
          rows={L2BEAT_ROWS}
        />
        <p>Chains without a matched L2BEAT snapshot continue to use the fallback tiers below.</p>
        <ContentTable
          tableId="chain-health-resilience-tiers"
          testId="chain-health-resilience-tiers-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "Chain resilience tiers" }}
          columns={TIER_COLUMNS}
          rows={TIER_ROWS}
        />
      </MethodologyDetails>

      <MethodologyDetails summary="Health bands">
        <ContentTable
          tableId="chain-health-bands"
          testId="chain-health-bands-table"
          tableClassName="min-w-[520px]"
          tableProps={{ "aria-label": "Chain Health bands" }}
          columns={HEALTH_BAND_COLUMNS}
          rows={HEALTH_BAND_ROWS}
        />
      </MethodologyDetails>

      <WorkedExample summary="Worked example: Ethereum vs PulseChain">
        <p className="text-foreground font-medium">Ethereum (Tier 1)</p>
        <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs pharos-numeric">
          {`quality      = 72  (supply-weighted safety scores across ~190 coins)
    environment  = 100 (tier 1 — gold standard for decentralization)
    concentration= 66  (USDT ~48%, USDC ~33% → HHI ≈ 0.34)
    pegStability = 98  (most coins very close to peg)
    diversity    = 35  (overwhelmingly RWA-backed)

    health = 0.30×72 + 0.20×100 + 0.20×66 + 0.20×98 + 0.10×35
           = 21.6 + 20 + 13.2 + 19.6 + 3.5 = 77.9 → 78 (healthy)`}
        </pre>
        <p className="text-foreground font-medium mt-4">PulseChain (Tier 3)</p>
        <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs pharos-numeric">
          {`quality      = 72  (rated supply only — not-rated coins excluded)
    environment  = 20  (tier 3 — unproven, centralized)
    concentration= 67  (DAI ~39%, rest ~12% each)
    pegStability = 98  (coins on peg)
    diversity    = 61  (mixed backing types)

    health = 0.30×72 + 0.20×20 + 0.20×67 + 0.20×98 + 0.10×61
           = 21.6 + 4 + 13.4 + 19.6 + 6.1 = 64.7 → 65 (healthy)

    → Chain environment alone creates a 16-point gap vs Ethereum.`}
        </pre>
      </WorkedExample>
    </MethodologySectionShell>
  );
}
