import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export const CONTENT_MARKDOWN = `## Chain Health Score

Chain Health Score evaluates how healthy each chain's stablecoin stack is. It combines stablecoin supply, diversification, safety-grade mix, dependency concentration, issuer concentration, and stress signals.

The score is computed from current stablecoin and report-card data rather than a separate opaque dataset. A chain with large supply but one dominant issuer, weak collateral quality, or broad stress can score below a smaller but more diversified chain.

Chain Health is intended as market-structure context: it helps users understand whether a chain's stablecoin liquidity is deep, resilient, and diversified enough to support activity during stress.
`;

export function ChainHealthMethodologySection() {
  return (
          <MethodologySectionShell
            id="chain-health-score"
            title="Chain Health Score"
            versionLabel={CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}
            changelogPath={CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when factor weights, tier assignments, or sub-factor formulas change."
            accentClassName="border-l-teal-500"
            badgeClassName="border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400"
            changelogClassName="hover:text-teal-700 dark:hover:text-teal-400"
          >
              <p>
                The Chain Health Score is a 0&ndash;100 composite that rates each blockchain&rsquo;s stablecoin ecosystem
                across five weighted factors. It answers: <em>how healthy, diverse, and resilient is the stablecoin mix on
                this chain?</em>
              </p>

              <p className="text-xs text-muted-foreground">
                See also:{" "}
                <a href="#liquidity-methodology" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">Liquidity Score</a>
              </p>

              <MethodologyFacts
                facts={[
                  { label: "Score range", value: "0–100 (null when safety-score coverage < 50%)" },
                  { label: "Refresh cadence", value: "15-minute stablecoins cache cadence; `/api/chains` freshness budget is 1800 seconds" },
                  { label: "Dependencies", value: "DefiLlama supply, Pharos Safety Scores, peg rates" },
                ]}
              />

              <MethodologyDetails summary="Formula & Weights" primary>
                <p className="text-foreground font-medium">Composite formula</p>
                <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
    {`healthScore =
      0.30 × quality
    + 0.20 × chainEnvironment
    + 0.20 × concentration
    + 0.20 × pegStability
    + 0.10 × backingDiversity`}
                </pre>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-2 pr-4">Factor</th>
                        <th scope="col" className="py-2 pr-4">Weight</th>
                        <th scope="col" className="py-2">What it measures</th>
                      </tr>
                    </thead>
                    <tbody className="text-foreground">
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Quality</td>
                        <td className="py-2 pr-4">30%</td>
                        <td className="py-2">Supply-weighted average of Pharos Safety Scores for stablecoins on the chain. Unrated coins default to 40. Returns null if rated supply &lt; 50% of total.</td>
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Chain Environment</td>
                        <td className="py-2 pr-4">20%</td>
                        <td className="py-2">
                          Rates the chain&rsquo;s own infrastructure quality, decentralization, and censorship resistance
                          via a resilience tier: <strong>Tier&nbsp;1</strong>&nbsp;(100) for battle-tested, highly
                          decentralized L1s; <strong>Tier&nbsp;2</strong>&nbsp;(60) for established chains with moderate
                          centralization; <strong>Tier&nbsp;3</strong>&nbsp;(20) for unproven or problematic chains.
                        </td>
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Concentration</td>
                        <td className="py-2 pr-4">20%</td>
                        <td className="py-2">100&nbsp;&times;&nbsp;(1&nbsp;&minus;&nbsp;HHI) where HHI&nbsp;=&nbsp;&Sigma;(market share)&sup2;. A single stablecoin scores 0; perfectly even N coins score 100&times;(1&minus;1/N).</td>
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Peg Stability</td>
                        <td className="py-2 pr-4">20%</td>
                        <td className="py-2">Supply-weighted average of per-coin peg proximity: 100&nbsp;&minus;&nbsp;deviationBps/5. Coins without a price get a neutral 50.</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-medium">Backing Diversity</td>
                        <td className="py-2 pr-4">10%</td>
                        <td className="py-2">Normalized Shannon entropy across the two active backing types (RWA-backed and crypto-backed). 0 for monoculture, 100 for an even split.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </MethodologyDetails>

              <MethodologyDetails summary="Chain Resilience Tiers">
                <p>
                  The same stablecoin can have different security properties on different chains.
                  A fully on-chain, censorship-resistant stablecoin on Ethereum mainnet may lose those guarantees
                  on an L2 with a centralized sequencer. The chain environment factor captures this.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-2 pr-4">Tier</th>
                        <th scope="col" className="py-2 pr-4">Score</th>
                        <th scope="col" className="py-2 pr-4">Criteria</th>
                        <th scope="col" className="py-2">Examples</th>
                      </tr>
                    </thead>
                    <tbody className="text-foreground">
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Tier 1</td>
                        <td className="py-2 pr-4 font-mono">100</td>
                        <td className="py-2 pr-4">Highly decentralized, battle-tested, censorship-resistant L1</td>
                        <td className="py-2">Ethereum</td>
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-2 pr-4 font-medium">Tier 2</td>
                        <td className="py-2 pr-4 font-mono">60</td>
                        <td className="py-2 pr-4">Established chains with moderate centralization (default for unlisted chains)</td>
                        <td className="py-2">Solana, BSC, Arbitrum, Tron, Base, Polygon</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4 font-medium">Tier 3</td>
                        <td className="py-2 pr-4 font-mono">20</td>
                        <td className="py-2 pr-4">Unproven, known centralization issues, or compromised security</td>
                        <td className="py-2">PulseChain, Harmony, BitTorrent</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </MethodologyDetails>

              <MethodologyDetails summary="Health Bands">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-2 pr-4">Band</th>
                        <th scope="col" className="py-2 pr-4">Score Range</th>
                        <th scope="col" className="py-2">Interpretation</th>
                      </tr>
                    </thead>
                    <tbody className="text-foreground">
                      <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-emerald-600 dark:text-emerald-400">Robust</td><td className="py-2 pr-4 font-mono">80&ndash;100</td><td className="py-2">Strong, diversified stablecoin ecosystem on quality infrastructure</td></tr>
                      <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-sky-600 dark:text-sky-400">Healthy</td><td className="py-2 pr-4 font-mono">60&ndash;79</td><td className="py-2">Good ecosystem with room for improvement</td></tr>
                      <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-amber-600 dark:text-amber-400">Mixed</td><td className="py-2 pr-4 font-mono">40&ndash;59</td><td className="py-2">Moderate concerns &mdash; concentration, quality gaps, or chain risk</td></tr>
                      <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-orange-600 dark:text-orange-400">Fragile</td><td className="py-2 pr-4 font-mono">20&ndash;39</td><td className="py-2">Significant ecosystem weaknesses</td></tr>
                      <tr><td className="py-2 pr-4 font-medium text-red-600 dark:text-red-400">Concentrated</td><td className="py-2 pr-4 font-mono">0&ndash;19</td><td className="py-2">Minimal diversity or critically weak infrastructure</td></tr>
                    </tbody>
                  </table>
                </div>
              </MethodologyDetails>

              <WorkedExample summary="Worked example: Ethereum vs PulseChain">
                <p className="text-foreground font-medium">Ethereum (Tier 1)</p>
                <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
    {`quality      = 72  (supply-weighted safety scores across ~190 coins)
    environment  = 100 (tier 1 — gold standard for decentralization)
    concentration= 66  (USDT ~48%, USDC ~33% → HHI ≈ 0.34)
    pegStability = 98  (most coins very close to peg)
    diversity    = 35  (overwhelmingly RWA-backed)

    health = 0.30×72 + 0.20×100 + 0.20×66 + 0.20×98 + 0.10×35
           = 21.6 + 20 + 13.2 + 19.6 + 3.5 = 77.9 → 78 (healthy)`}
                </pre>
                <p className="text-foreground font-medium mt-4">PulseChain (Tier 3)</p>
                <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
    {`quality      = 72  (DAI + unrated coins defaulting to 40)
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
