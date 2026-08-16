import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { CHAIN_HEALTH_SECTION_CONTENT } from "@/lib/methodology-content";
export function ChainHealthMethodologySection() {
  return (
    <MethodologySectionShell
      id={CHAIN_HEALTH_SECTION_CONTENT.id}
      title={CHAIN_HEALTH_SECTION_CONTENT.title}
      versionBadge={{ label: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL }}
      changelogPath={CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when factor weights, tier assignments, or sub-factor formulas change."
      changelogClassName="hover:text-teal-700 dark:hover:text-teal-400"
    >
      <p>
        The Chain Health Score is a 0&ndash;100 composite that rates each blockchain&rsquo;s stablecoin ecosystem across
        five weighted factors. It answers:{" "}
        <em>how healthy, diverse, and resilient is the stablecoin mix on this chain?</em>
      </p>

      <p>
        Only a fresh, accepted V9 publication contributes Safety quality. Missing, held, stale, or invalid V9 leaves
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
          { label: "Score range", value: "0–100 (null when safety-score coverage < 50%)" },
          {
            label: "Refresh cadence",
            value: "15-minute stablecoins cache cadence; `/api/chains` freshness budget is 1800 seconds",
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
          {`healthScore =
      0.30 × quality
    + 0.20 × chainEnvironment
    + 0.20 × concentration
    + 0.20 × pegStability
    + 0.10 × backingDiversity`}
        </pre>

        <TableFrame
          chrome="content"
          density="compact"
          tableId="chain-health-factor-weights"
          testId="chain-health-factor-weights-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "Chain Health factor weights" }}
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Factor
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Weight
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                What it measures
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground">
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Quality</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">30%</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Supply-weighted average of Pharos Safety Scores for stablecoins on the chain. Not-rated supply is
                excluded and the average renormalizes over rated supply. Returns null if rated supply &lt; 50% of total.
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Chain Environment</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">20%</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Rates the chain&rsquo;s own infrastructure quality with L2BEAT first for matched scaling projects, using
                stage plus Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure.
                Unmatched chains fall back to the Pharos resilience tier model.
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Concentration</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">20%</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                100&nbsp;&times;&nbsp;(1&nbsp;&minus;&nbsp;HHI) where HHI&nbsp;=&nbsp;&Sigma;(market share)&sup2;. A
                single stablecoin scores 0; perfectly even N coins score 100&times;(1&minus;1/N).
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Peg Stability</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">20%</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Supply-weighted average of per-coin peg proximity: 100&nbsp;&minus;&nbsp;deviationBps/5. Coins without a
                price get a neutral 50.
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Backing Diversity</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">10%</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Normalized Shannon entropy across the two active backing types (RWA-backed and crypto-backed). 0 for
                monoculture, 100 for an even split.
              </TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
      </MethodologyDetails>

      <MethodologyDetails summary="Chain Environment Sources">
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
        <TableFrame
          chrome="content"
          density="compact"
          tableId="chain-health-l2beat-risk-fields"
          testId="chain-health-l2beat-risk-fields-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "L2BEAT chain environment inputs" }}
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Component
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Mapping
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground">
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Stage</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Stage 2 = 100, Stage 1 = 80, Stage 0 = 55, not applicable or under review = 50
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Risk fields</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Sequencer Failure, State Validation, Data Availability, Exit Window, Proposer Failure
              </TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Risk sentiment</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Good = 100, warning = 60, bad = 20, neutral or under review = 50
              </TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
        <p>Chains without a matched L2BEAT snapshot continue to use the fallback tiers below.</p>
        <TableFrame
          chrome="content"
          density="compact"
          tableId="chain-health-resilience-tiers"
          testId="chain-health-resilience-tiers-table"
          tableClassName="min-w-[640px]"
          tableProps={{ "aria-label": "Chain resilience tiers" }}
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Tier
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Score
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Criteria
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Examples
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground">
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Tier 1</TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">100</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Highly decentralized, battle-tested, censorship-resistant L1
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2">Ethereum</TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Tier 2</TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">60</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Established chains with moderate centralization (default for unlisted chains)
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2">Solana, BSC, Tron, Avalanche</TableCell>
            </TableRow>
            <TableRow className="align-top">
              <TableCell className="whitespace-normal px-4 py-2 font-medium">Tier 3</TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">20</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Unproven, known centralization issues, or compromised security
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2">PulseChain, Harmony, BitTorrent</TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
      </MethodologyDetails>

      <MethodologyDetails summary="Health Bands">
        <TableFrame
          chrome="content"
          density="compact"
          tableId="chain-health-bands"
          testId="chain-health-bands-table"
          tableClassName="min-w-[520px]"
          tableProps={{ "aria-label": "Chain Health bands" }}
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Band
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Score Range
              </TableHead>
              <TableHead scope="col" className="h-auto whitespace-normal px-4 py-2">
                Interpretation
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground">
            <TableRow>
              <TableCell className="whitespace-normal px-4 py-2 font-medium text-emerald-600 dark:text-emerald-400">
                Robust
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">80&ndash;100</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Strong, diversified stablecoin ecosystem on quality infrastructure
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="whitespace-normal px-4 py-2 font-medium text-sky-600 dark:text-sky-400">
                Healthy
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">60&ndash;79</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">Good ecosystem with room for improvement</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="whitespace-normal px-4 py-2 font-medium text-amber-600 dark:text-amber-400">
                Mixed
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">40&ndash;59</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Moderate concerns &mdash; concentration, quality gaps, or chain risk
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="whitespace-normal px-4 py-2 font-medium text-orange-600 dark:text-orange-400">
                Fragile
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">20&ndash;39</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">Significant ecosystem weaknesses</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="whitespace-normal px-4 py-2 font-medium text-red-600 dark:text-red-400">
                Concentrated
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2 pharos-numeric">0&ndash;19</TableCell>
              <TableCell className="whitespace-normal px-4 py-2">
                Minimal diversity or critically weak infrastructure
              </TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
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
