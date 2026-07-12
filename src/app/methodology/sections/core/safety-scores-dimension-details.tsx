import Link from "next/link";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { METHODOLOGY_LINK_CLASS } from "../../methodology-shared";
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
        <TableFrame
          chrome="content"
          density="compact"
          tableId="methodology-safety-resilience-scoring"
          testId="methodology-safety-resilience-scoring-table"
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left">
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Sub-factor
              </TableHead>
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                What it measures
              </TableHead>
              <TableHead scope="col" className="py-2 text-foreground">
                Scoring
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Collateral Quality</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Reserve composition risk</TableCell>
              <TableCell className="py-2 whitespace-normal">
                Weighted avg of curated reserve slices: Very&nbsp;Low&nbsp;(100), Low&nbsp;(75), Medium&nbsp;(50),
                High&nbsp;(25), Very&nbsp;High&nbsp;(5). Falls back to enum scoring for coins without curated reserves.
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Custody Model</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Who controls the economic backing?</TableCell>
              <TableCell className="py-2 whitespace-normal">
                Fully&nbsp;on&#8209;chain&nbsp;(100), Top&#8209;tier&nbsp;custodian&nbsp;(80),
                Regulated&nbsp;custodian&nbsp;(55), Unregulated&nbsp;custodian&nbsp;(30),
                Sanctioned&nbsp;custodian&nbsp;(5), CEX&nbsp;/&nbsp;off&#8209;exchange&nbsp;custody&nbsp;(0)
              </TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
        <p>
          Tokenized RWA collateral is scored by the ultimate reserve or legal custody layer, not only by the
          smart-contract location of a wrapper token.
        </p>
        <CollateralQualityMethodologyCopy />
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Decentralization Scoring</h3>
        <p>
          Base score from governance quality tier, then a chain-risk penalty for protocols on less decentralized chains
          &mdash; governance decentralization is undermined when the underlying chain has centralisation concerns
          &mdash; followed by a branch-aware CDP-only oracle setup blend (v8.11), reviewed bridge-route blend (v8.12),
          and the penalty-only Mint Authority blend (v8.0):
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground">Immutable code</span> &mdash; 100 (no admin keys, no upgrade path &mdash;
            e.g.&nbsp;LUSD, BOLD). Exempt from chain-risk penalty
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
            <span className="text-foreground">Wrapper</span> &mdash; inherits tracked parent Decentralization with a
            wrapper-kind haircut; unresolved wrappers fall back to 10
          </li>
        </ul>
        <p className="text-xs">
          Resolvable wrappers use the wrapped asset&apos;s chain-adjusted, pre-blend Decentralization score: savings
          wrappers subtract 3, strategy-vault and risk-absorption wrappers subtract 5, and bond-maturity wrappers
          subtract 8. For example, yBOLD and sBOLD inherit from BOLD, while sfrxUSD inherits from frxUSD.
        </p>
        <p className="font-medium text-foreground mt-2">CDP oracle setup blend (v8.11):</p>
        <p>
          Crypto-backed CDP stablecoins can carry reviewed <code className="text-xs">oracleRisk</code> metadata. When
          present, the score applies{" "}
          <span className="pharos-numeric">min(score, round(score &times; 0.75 + oracle &times; 0.25))</span> after
          governance and chain infrastructure. Robust setups never lift a score; weak, single-source, laggy, or opaque
          feeds can drag it down. Missing oracle reviews and non-CDP assets are unchanged. The current tier scores are
          oracleless/internal&nbsp;100, redundant failover&nbsp;95, medianized delay&nbsp;85, standard external&nbsp;75,
          single-source/laggy&nbsp;45, and opaque/unknown&nbsp;20.
        </p>
        <p className="text-xs">
          Since v8.11, reviews can include provenance plus branch rows for collateral markets or chains. If branch rows
          are present, the weakest branch/profile tier supplies the oracle score. Wrappers and savings variants display
          inherited parent oracle exposure without adding a separate wrapper-side oracle penalty.
        </p>
        <p className="font-medium text-foreground mt-2">Bridge route blend (v8.12):</p>
        <p>
          Reviewed <code className="text-xs">bridgeRouteRisk</code> metadata can capture issuer-native, canonical,
          external bridge, lockbox, liquidity, or intent routes. When present, the score applies{" "}
          <span className="pharos-numeric">min(score, round(score &times; 0.80 + bridge &times; 0.20))</span> after
          oracle scoring and before Mint Authority. Strong issuer-native or canonical routes never lift a score; missing
          reviews stay neutral; weak external lock/mint, liquidity/intent, or opaque routes can drag it down.
        </p>
        <p className="text-xs">
          Current tier scores are single-chain/native&nbsp;100, issuer burn/mint&nbsp;90, canonical bridge&nbsp;85,
          issuer lock/mint&nbsp;80, external validated network&nbsp;65, liquidity/intent route&nbsp;55, external
          lock/mint&nbsp;40, and opaque/unknown&nbsp;20. L2BEAT Interop is used as static review evidence, not as a live
          scoring dependency.
        </p>
        <p className="font-medium text-foreground mt-2">Mint Authority blend (v8.0):</p>
        <p>
          A rated Mint Authority Score applies as the final stage:{" "}
          <span className="pharos-numeric">min(score, round(score &times; 0.65 + MAS &times; 0.35))</span>. The blend
          only drags the dimension down &mdash; a weak privileged-mint path undermines a decentralization claim, while a
          strong one never lifts it. Coins without a rated Mint Authority Score are unchanged, wrappers take the drag
          once on their inherited pre-blend score (capped at the parent&apos;s blended score), and a{" "}
          <span className="text-foreground">Mint authority</span> detail row appears when the drag binds.
        </p>
        <p className="font-medium text-foreground mt-2">
          Chain-risk penalty (DAO and multisig governance &mdash; exempt for immutable-code, wrapper, regulated-entity,
          single-entity):
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>Combined score &ge;80 &mdash; no penalty</li>
          <li>Combined score &ge;60 &mdash; &minus;10</li>
          <li>Combined score &ge;40 &mdash; &minus;25</li>
          <li>Combined score &ge;20 &mdash; &minus;40</li>
          <li>Combined score &lt;20 &mdash; &minus;60</li>
        </ul>
        <p className="text-xs">
          Example: hyUSD (DAO governance, Solana, combined score 45) = 85 &minus; 25 ={" "}
          <span className="text-foreground">60</span>. USDB (multisig, Blast L2, combined score 66) = 55 &minus; 10 ={" "}
          <span className="text-foreground">45</span>.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
        <p>
          Dependency scoring runs after upstream report cards are available and uses a topological order across the
          active dependency graph, so transitive stablecoin exposure is scored from upstreams before downstream coins
          are finalized.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground">Self-backed coins</span> &mdash; score by governance baseline:
            decentralized&nbsp;90, centralized-dependent&nbsp;75, centralized&nbsp;95
          </li>
          <li>
            <span className="text-foreground">With mapped dependencies</span> &mdash; blended score: each
            upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion (non-stablecoin
            collateral) scores vary by governance type (decentralized&nbsp;90, centralized-dependent&nbsp;75,
            centralized&nbsp;95). A &minus;10 penalty applies if any upstream dependency scores below 75
          </li>
          <li>
            <span className="text-foreground">Unavailable upstream scores</span> &mdash; falls back to 70 when all
            dependency scores are unavailable; partially unavailable upstream weights are scored at 70 instead of being
            treated as self-backed
          </li>
          <li>
            <span className="text-foreground">Variants and self-holdings</span> &mdash; a tracked variant has one serial
            wrapper dependency on its parent. Mirrored parent reserves do not add parallel weight, and a coin&apos;s own
            treasury-held token remains reserve evidence without becoming a self-dependency
          </li>
        </ul>
        <p className="mt-2">
          <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is
          classified as <em>wrapper</em>, <em>mechanism</em>, or <em>collateral</em> (default). Legacy wrappers (e.g.,
          syrupUSDC &rarr; USDC) are capped at <code className="text-xs">upstream &minus; 3</code>. Tracked
          parent-linked variants keep the same wrapper edge but use family-specific ceilings: savings &minus;3,
          strategy-vault &minus;5, risk-absorption &minus;5, bond-maturity &minus;8. Mechanism dependencies (e.g., DAI
          &rarr; USDC via{" "}
          <Link href="/learn/mechanisms/cdp/" className={METHODOLOGY_LINK_CLASS}>
            PSM
          </Link>
          ) are essential to the peg &mdash; score is capped at the upstream&apos;s score. Collateral dependencies use
          the blended formula with no ceiling.
        </p>
        <p className="text-xs">
          Self-backed scores vary by governance type: centralized-dependent coins score 75 (systemic coupling risk),
          decentralized coins 90, and centralized coins 95. Centralized-dependent coins score lower because their peg
          mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Grade Thresholds</h3>
        <TableFrame
          chrome="content"
          density="compact"
          tableId="methodology-safety-grade-thresholds"
          testId="methodology-safety-grade-thresholds-table"
          tableClassName="w-auto"
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left">
              <TableHead scope="col" className="py-2 pr-8 text-foreground">
                Grade
              </TableHead>
              <TableHead scope="col" className="py-2 text-foreground">
                Score Range
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">A+</TableCell>
              <TableCell className="py-1.5">87&ndash;100</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">A</TableCell>
              <TableCell className="py-1.5">83&ndash;86</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">A&minus;</TableCell>
              <TableCell className="py-1.5">80&ndash;82</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">B+</TableCell>
              <TableCell className="py-1.5">75&ndash;79</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">B</TableCell>
              <TableCell className="py-1.5">70&ndash;74</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">B&minus;</TableCell>
              <TableCell className="py-1.5">65&ndash;69</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">C+</TableCell>
              <TableCell className="py-1.5">60&ndash;64</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">C</TableCell>
              <TableCell className="py-1.5">55&ndash;59</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">C&minus;</TableCell>
              <TableCell className="py-1.5">50&ndash;54</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">D</TableCell>
              <TableCell className="py-1.5">40&ndash;49</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">F</TableCell>
              <TableCell className="py-1.5">0&ndash;39</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-1.5 pr-8 text-foreground">NR</TableCell>
              <TableCell className="py-1.5">Not enough data</TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
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
            Peg stability acts as a multiplier, not a base dimension &mdash; maintaining a peg is table stakes, not a
            differentiator
          </li>
          <li>Cemetery (defunct) coins receive a permanent F</li>
          <li>Decentralization score is structural, not a value judgment</li>
          <li>
            Blacklist capability is reported descriptively only and does not affect the Resilience score. Explicit
            mutable-contract overrides still surface as &ldquo;possible&rdquo;. Reserve-side stablecoins, custodied
            wrappers, issuer-seizable tokenized collateral, custody/CEX rails, and tracked parent-asset exposures now
            resolve to &ldquo;inherited&rdquo; blacklist risk instead of sharing the &ldquo;possible&rdquo; bucket.
          </li>
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Dependency Ceilings</h3>
        <p>
          When a stablecoin depends on another (wrapper, mechanism, or collateral relationship), its dependency risk
          score is capped relative to its upstream:
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <strong>Wrapper dependency:</strong> legacy wrappers and tracked savings variants cap at upstream score
            minus 3; strategy-vault/risk-absorption variants cap at minus 5; bond-maturity variants cap at minus 8
          </li>
          <li>
            <strong>Mechanism dependency:</strong> capped at upstream score
          </li>
          <li>
            <strong>Collateral dependency:</strong> blended into dependency risk dimension via weighted average
          </li>
        </ul>
        <p>
          If any upstream dependency scores below 75, a 10-point penalty is applied. These ceilings prevent a wrapped
          token from outscoring its underlying asset.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Limitations</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because nobody
            trades them
          </li>
          <li>Decentralization is structural, not a value judgment</li>
          <li>
            Dependency inputs come from score-grade live reserve slices when available, then curated reserve links, then
            manual dependency metadata; unmapped collateral relationships may still be missed
          </li>
        </ul>
      </div>
    </>
  );
}
