import type { ReactNode } from "react";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { ChangelogTable, WeightRow, changelogTableClassNames } from "./content-shared";

export const scoringChangelogV5Details: Record<string, ReactNode> = {
  "5.9": (
    <>
      <p>
        Three DeFi-classified coins were corrected after live reserve review showed majority centralized custody
        exposure.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">meUSD</span>,{" "}
          <span className="text-foreground font-medium">ALUSD</span>, and{" "}
          <span className="text-foreground font-medium">BtcUSD</span> were reclassified from decentralized to
          centralized-dependent.
        </li>
        <li>
          ALUSD&apos;s earlier v4.1 correction was explicitly reversed after reserve review showed majority direct
          USDC/USDT exposure.
        </li>
        <li>meUSD and BtcUSD were corrected after live reserves confirmed custodial BTC-variant backing.</li>
      </ul>
    </>
  ),
  "5.8": (
    <>
      <p>
        Collateral quality scoring now consumes{" "}
        <span className="text-foreground font-medium">live reserve snapshots</span> when available, using hourly data
        from <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_composition</code> instead of curated
        metadata.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Coins with <code className="text-xs bg-muted px-1 py-0.5 rounded">liveReservesConfig</code> use fresh
          (&lt;48h) live snapshots for collateral quality instead of curated metadata.
        </li>
        <li>Delta alert fires when live-derived score diverges from curated by &gt;15 points.</li>
        <li>Dependency inference remains on curated data (live slices lack coinId links).</li>
      </ul>
    </>
  ),
  "5.7": (
    <>
      <p>
        Direct <span className="text-foreground font-medium">ETH</span> and canonical
        <span className="text-foreground font-medium"> WETH</span> reserve slices now share the same
        <span className="text-foreground font-medium"> very-low</span> risk tier.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Updated the shared direct-asset reserve map used by live reserve adapters so `WETH` no longer falls into the
          generic wrapped-asset bucket.
        </li>
        <li>
          Aligned curated reserve metadata and live config overrides for coins that expose plain `WETH` or `ETH` slices.
        </li>
        <li>
          Left mixed strategy buckets unchanged. Delta-neutral ETH exposures, bridged ETH buckets, and mixed BTC/ETH
          slices still use their existing manually-modeled risk tiers.
        </li>
      </ul>
    </>
  ),
  "5.6": (
    <>
      <p>
        The Safety Score liquidity dimension now evaluates
        <span className="text-foreground font-medium"> exit liquidity</span>, not just raw DEX depth.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Added a new <span className="text-foreground font-medium">redemption backstop dataset</span>
          for redeemable assets, covering onchain collateral redemptions, stable basket redemptions, queue-based
          liquid-buffer systems, and issuer redemption rails.
        </li>
        <li>
          The report-card Liquidity dimension now uses an
          <span className="text-foreground font-medium"> effective exit score</span>: DEX liquidity remains the floor,
          while redemption quality can improve the dimension without redefining the standalone DEX liquidity score.
        </li>
        <li>
          Added route-family caps so queue-based and offchain issuer systems cannot look unrealistically liquid even
          when redemption exists.
        </li>
      </ul>
    </>
  ),
  "5.5": (
    <>
      <p>
        Three fixes to the peg score formula that prevent young coins with chronic depegs from scoring artificially
        high:
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">Tracking window capped at coin age</span> &mdash; uses the
          coin&apos;s earliest supply snapshot instead of always defaulting to a 4-year window. A 30-day-old coin is now
          scored over 30 days, not 1,461.
        </li>
        <li>
          <span className="text-foreground font-medium">Severity magnitude floor</span> &mdash; every depeg event
          carries a minimum penalty of (peakBps&nbsp;/&nbsp;2000)&nbsp;&times;&nbsp;recencyWeight, regardless of
          duration. Hundreds of brief high-magnitude depegs now accumulate real cost.
        </li>
        <li>
          <span className="text-foreground font-medium">Active depeg penalty steepened</span> &mdash; floor raised from
          2 to 5, divisor changed from 200 to 50. A 500&nbsp;bps ongoing depeg now costs 10 points (was 2.5).
        </li>
      </ul>
    </>
  ),
  "5.4": (
    <>
      <p>
        When the Liquidity dimension is NR (no DEX data), the overall score now receives a{" "}
        <span className="text-foreground font-medium">10% penalty</span> instead of silently redistributing the weight
        to other dimensions.
      </p>
      <div className="rounded-lg border p-3 pharos-numeric text-xs bg-muted">final = score &times; 0.9</div>
      <p>
        As DEX pipeline coverage matures, absence of liquidity data is increasingly suspect and should not inflate
        grades.
      </p>
    </>
  ),
  "5.3": (
    <>
      <p>
        Chain infrastructure was scored in <span className="text-foreground font-medium">both</span> Resilience (as a
        25% sub-factor) and Decentralization (as a penalty) &mdash; double-counting chain risk.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Chain infra now scored <span className="text-foreground font-medium">exclusively in Decentralization</span>
        </li>
        <li>
          Resilience becomes a 3-factor model (each &frac13;): Collateral Quality, Custody Model, Blacklist Capability
        </li>
      </ul>
    </>
  ),
  "5.2": (
    <>
      <p>
        New highest GovernanceQuality tier:{" "}
        <span className="text-foreground font-medium">immutable-code &rarr; 100</span>. For protocols with no admin
        keys, no upgrade path, no DAO attack surface (e.g. LUSD, BOLD). Exempt from chain infrastructure penalty.
      </p>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Full GovernanceQuality tiers</h3>
        <ChangelogTable
          ariaLabel="Safety Score v5 GovernanceQuality tiers"
          tableId="scoring-v5-governance-quality-tiers"
          testId="scoring-v5-governance-quality-tiers-table"
        >
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className={changelogTableClassNames.head}>
                Tier
              </TableHead>
              <TableHead scope="col" className={changelogTableClassNames.head}>
                Score
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ["immutable-code", "100"],
              ["dao-governance", "85"],
              ["multisig", "55"],
              ["regulated-entity", "40"],
              ["single-entity", "20"],
              ["wrapper", "10"],
            ].map(([tier, score]) => (
              <TableRow key={tier}>
                <TableCell className={changelogTableClassNames.rowHeader}>{tier}</TableCell>
                <TableCell className={changelogTableClassNames.cell}>{score}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ChangelogTable>
      </div>
    </>
  ),
  "5.1": (
    <>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">Blacklist scoring softened</span>: blacklistable 0&rarr;33,
          possible 50&rarr;66, not-blacklistable 100 (unchanged). Non-zero floor for blacklistable tokens.
        </li>
        <li>
          <span className="text-foreground font-medium">regulated-entity tier</span> added (score 40). Auto-promoted
          from single-entity when: jurisdiction regulator + license set, and proof of reserves via independent audit.
          Exempt from chain infra penalty.
        </li>
        <li>
          <span className="text-foreground font-medium">Grade thresholds lowered 5 points</span> (C-range overcrowding
          after blacklist/decentralization changes).
        </li>
      </ul>
    </>
  ),
  "5.0": (
    <>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Decentralization: 3-tier &rarr; 6-tier GovernanceQuality</h3>
        <p>
          The blunt 3-level governance type (decentralized / centralized-dependent / centralized) replaced by a 6-tier
          GovernanceQuality scale, inferred from governance type when not explicitly set.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Dependency Risk: universal, not CeFi-only</h3>
        <p>
          All coins with upstream dependencies are now scored &mdash; not just centralized-dependent ones. Self-backed
          scores vary by governance type: decentralized 90, centralized-dependent 75, centralized 95. Dependencies
          auto-derived from reserve composition data.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Chain infrastructure restructured</h3>
        <p>
          New two-axis model: ChainTier &times; DeploymentModel multiplier. Threshold-based penalty applied to the
          Decentralization dimension.
        </p>
      </div>
      <WeightRow values={["multiplier", "30%", "\u2014", "20%", "15%", "25%"]} />
    </>
  ),
};
