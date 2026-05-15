import { CollateralQualityMethodologyCopy } from "../core-sections-fragments";

export function SafetyScoresDimensionDetails() {
  return (
    <>
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
                <td className="py-2 pr-4">Who controls the economic backing?</td>
                <td className="py-2">
                  Fully&nbsp;on&#8209;chain&nbsp;(100), Top&#8209;tier&nbsp;custodian&nbsp;(80),
                  Regulated&nbsp;custodian&nbsp;(55), Unregulated&nbsp;custodian&nbsp;(30),
                  Sanctioned&nbsp;custodian&nbsp;(5), CEX&nbsp;/&nbsp;off&#8209;exchange&nbsp;custody&nbsp;(0)
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>Tokenized RWA collateral is scored by the ultimate reserve or legal custody layer, not only by the smart-contract location of a wrapper token.</p>
        <CollateralQualityMethodologyCopy />
      </div>

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
            <span className="text-foreground">Wrapper</span> &mdash; inherits tracked parent Decentralization
            with a wrapper-kind haircut; unresolved wrappers fall back to 10
          </li>
        </ul>
        <p className="text-xs">
          Resolvable wrappers use the wrapped asset&apos;s already chain-adjusted Decentralization score: savings wrappers
          subtract 3, strategy-vault and risk-absorption wrappers subtract 5, and bond-maturity wrappers subtract 8.
          For example, yBOLD and sBOLD inherit from BOLD, while sfrxUSD inherits from frxUSD.
        </p>
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

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
        <p>
          Dependency scoring runs after upstream report cards are available and uses a topological order across the active dependency graph, so transitive stablecoin exposure is scored from upstreams before downstream coins are finalized.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground">Self-backed coins</span> &mdash; score by governance baseline: decentralized&nbsp;90, centralized-dependent&nbsp;75, centralized&nbsp;95
          </li>
          <li>
            <span className="text-foreground">With mapped dependencies</span> &mdash; blended score: each
            upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion
            (non-stablecoin collateral) scores vary by governance type (decentralized&nbsp;90,
            centralized-dependent&nbsp;75, centralized&nbsp;95). A &minus;10 penalty applies if any upstream
            dependency scores below 75
          </li>
          <li>
            <span className="text-foreground">Unavailable upstream scores</span> &mdash; falls back to 70 when
            all dependency scores are unavailable; partially unavailable upstream weights are scored at 70
            instead of being treated as self-backed
          </li>
        </ul>
        <p className="mt-2">
          <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is
          classified as <em>wrapper</em>, <em>mechanism</em>, or <em>collateral</em> (default). Legacy wrappers
          (e.g., syrupUSDC &rarr; USDC) are capped at <code className="text-xs">upstream &minus; 3</code>.
          Tracked parent-linked variants keep the same wrapper edge but use family-specific ceilings:
          savings &minus;3, strategy-vault &minus;5, risk-absorption &minus;5, bond-maturity &minus;8. Mechanism dependencies
          (e.g., DAI &rarr; USDC via PSM) are essential to the peg &mdash; score is capped at the
          upstream&apos;s score. Collateral dependencies use the blended formula with no ceiling.
        </p>
        <p className="text-xs">
          Self-backed scores vary by governance type: centralized-dependent coins score 75 (systemic coupling
          risk), decentralized coins 90, and centralized coins 95. Centralized-dependent coins score lower because
          their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
        </p>
      </div>

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
            Explicit mutable-contract overrides still surface as &ldquo;possible&rdquo;. Reserve-side
            stablecoins, custodied wrappers, issuer-seizable tokenized collateral, custody/CEX rails, and
            tracked parent-asset exposures now resolve to &ldquo;inherited&rdquo; blacklist risk instead of
            sharing the &ldquo;possible&rdquo; bucket.
          </li>
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Dependency Ceilings</h3>
        <p>
          When a stablecoin depends on another (wrapper, mechanism, or collateral relationship), its dependency
          risk score is capped relative to its upstream:
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li><strong>Wrapper dependency:</strong> legacy wrappers and tracked savings variants cap at upstream score minus 3; strategy-vault/risk-absorption variants cap at minus 5; bond-maturity variants cap at minus 8</li>
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

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Limitations</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because
            nobody trades them
          </li>
          <li>Decentralization is structural, not a value judgment</li>
          <li>Dependency inputs come from score-grade live reserve slices when available, then curated reserve links, then manual dependency metadata; unmapped collateral relationships may still be missed</li>
        </ul>
      </div>
    </>
  );
}
