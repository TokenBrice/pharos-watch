import {
  SAFETY_SCORE_CHANGELOG_NAV_VERSIONS,
  SAFETY_SCORE_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/safety-score-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const PAGE_PATH = SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH;

/* ── tiny helpers ────────────────────────────────────────────────── */

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function scoringAnchorId(version: string) {
  return `scoring-${version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
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
  const anchorId = scoringAnchorId(version);

  return (
    <Card id={anchorId} className={`scroll-mt-28 rounded-xl border-l-[3px] ${accent}`}>
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

const route = createMethodologyChangelogRoute({
  path: PAGE_PATH,
  metadataTitle: "Safety Scores Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos safety scoring methodology, from v1.0 through ${SAFETY_SCORE_VERSION_LABEL}. Every weight change, new dimension, and structural decision documented.`,
  breadcrumbName: "Scoring Changelog",
  title: "Safety Scores Changelog",
  lead: (
    <>
      Full version history of the grading methodology &mdash; every weight
      change, new dimension, and structural decision from v1.0 to {SAFETY_SCORE_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-amber-500",
  sections: SAFETY_SCORE_CHANGELOG_NAV_VERSIONS.map((version) => ({
    id: scoringAnchorId(version),
    label: version,
  })),
  renderContent: () => (
    <>
      {/* ──────────── v6.6 ──────────── */}
      <VersionCard
        version="v6.6"
        title="Timestamp-backed live reserve scoring gate"
        date="Mar 24, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but collateral-quality live reserve passthrough now
          requires stronger freshness evidence before a live feed can override curated collateral scoring.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Independent live reserve feeds still need a{" "}
            <span className="text-foreground font-medium">fresh authoritative snapshot</span>{" "}
            whose latest <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_sync_state.last_status</code>{" "}
            is <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code>.
          </li>
          <li>
            In addition, collateral passthrough now requires scoring-eligible freshness evidence:
            either a verified timestamp path or a{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode</code>{" "}
            of <code className="text-xs bg-muted px-1 py-0.5 rounded">verified</code> or{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">not-applicable</code>.
          </li>
          <li>
            Feeds marked <code className="text-xs bg-muted px-1 py-0.5 rounded">unverified</code>{" "}
            remain available on reserve detail/status surfaces, but they no longer override curated
            collateral quality in report-card scoring.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.5 ──────────── */}
      <VersionCard
        version="v6.5"
        title="Clean independent live reserve passthrough"
        date="Mar 22, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but the collateral-quality live reserve
          passthrough is now stricter about evidence quality and warning-bearing feeds.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Live collateral passthrough now requires a{" "}
            <span className="text-foreground font-medium">fresh authoritative snapshot</span>{" "}
            whose latest <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_sync_state.last_status</code>{" "}
            is <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code>.
          </li>
          <li>
            The live reserve adapter registry now separates reserve shape{" "}
            (<code className="text-xs bg-muted px-1 py-0.5 rounded">sourceModel</code>) from
            evidence strength (<code className="text-xs bg-muted px-1 py-0.5 rounded">evidenceClass</code>).
          </li>
          <li>
            <code className="text-xs bg-muted px-1 py-0.5 rounded">single-asset</code> and{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">tether</code> style feeds are
            now treated as <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>{" "}
            evidence, so they remain visible on reserve detail/status surfaces but no longer
            override curated collateral scoring.
          </li>
          <li>
            Source-age and material unknown-exposure warnings now degrade reserve sync health
            and automatically keep those snapshots out of collateral passthrough.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.4 ──────────── */}
      <VersionCard
        version="v6.4"
        title="Live Liquity redemption fee telemetry"
        date="Mar 22, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but Liquity-style formula routes can now
          use current on-chain redemption fees when live reserve telemetry is available.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground font-medium">LUSD</span> and{" "}
            <span className="text-foreground font-medium">BOLD</span> now reuse live reserve
            sync metadata for current redemption fee bps instead of always sitting in the
            generic reviewed-formula bucket.
          </li>
          <li>
            These routes remain labeled as{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">formula</code> fee models
            and <code className="text-xs bg-muted px-1 py-0.5 rounded">eventual-only</code>{" "}
            capacity routes, so Pharos does not present them as having an immediate redeemable
            buffer.
          </li>
          <li>
            If live fee telemetry is unavailable, the liquidity dimension falls back to the
            prior reviewed-formula treatment.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.3 ──────────── */}
      <VersionCard
        version="v6.3"
        title="Documented-bound Liquity redemption confidence"
        date="Mar 22, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but a narrow class of immutable on-chain
          redemption routes now counts as stronger exit evidence than heuristic capacity models.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground font-medium">LUSD</span> and{" "}
            <span className="text-foreground font-medium">BOLD</span> now use{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">documented-bound</code>{" "}
            eventual redemption capacity instead of generic heuristic{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">supply-full</code> modeling.
          </li>
          <li>
            These routes still present as{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">eventual-only</code>, so
            Pharos does not treat full current supply as an immediate redeemable buffer.
          </li>
          <li>
            Liquity-style <code className="text-xs bg-muted px-1 py-0.5 rounded">min 50 bps + baseRate</code>{" "}
            fees remain reviewed formula inputs rather than fixed-fee assumptions.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.2 ──────────── */}
      <VersionCard
        version="v6.2"
        title="Independent live reserve contract tightening"
        date="Mar 22, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but the collateral-quality live reserve
          passthrough is now stricter about which hourly reserve feeds qualify.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Live collateral passthrough now requires a
            <span className="text-foreground font-medium"> fresh authoritative snapshot</span>:
            the reserve row must be non-empty and matched to the coin&apos;s latest successful
            sync state.
          </li>
          <li>
            Only <code className="text-xs bg-muted px-1 py-0.5 rounded">dynamic-mix</code> and{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">single-bucket</code> feeds
            count as independent live collateral inputs.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">validated-static</code> feeds
            stay visible on reserve detail/status surfaces but no longer override curated
            collateral scoring.
          </li>
          <li>
            Single-bucket live feeds now participate in collateral drift and fallback tracking;
            the old implicit <code className="text-xs bg-muted px-1 py-0.5 rounded">&gt;= 2 slices</code>{" "}
            gate is no longer the scoring contract.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.1 ──────────── */}
      <VersionCard
        version="v6.1"
        title="Redemption confidence gating and capacity semantics"
        date="Mar 22, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Safety Score structure is unchanged, but the Liquidity dimension is now
          stricter about what redemption evidence can improve it.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Low-confidence redemption routes remain visible in detail surfaces,
            but they no longer uplift the Safety Score liquidity dimension.
          </li>
          <li>
            When the reused DEX liquidity snapshot is stale, it is no longer
            blended into <code className="text-xs bg-muted px-1 py-0.5 rounded">effectiveExitScore</code>.
          </li>
          <li>
            Redemption detail output now distinguishes immediate redeemable
            capacity from eventual issuer/protocol redeemability.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v6.0 ──────────── */}
      <VersionCard
        version="v6.0"
        title="Custody model tiers, mature-alt-l1, 2-factor Resilience"
        date="Mar 21, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Four structural changes landed together in the safety methodology:
          a wider custody model, a new chain tier for Solana and BNB Chain,
          a simpler 2-factor Resilience score, and a steeper 5-band chain
          penalty.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Custody model expanded from 3 to 6 tiers: onchain, institutional-top,
            institutional-regulated, institutional-unregulated,
            institutional-sanctioned, and cex.
          </li>
          <li>
            Added <span className="text-foreground font-medium">mature-alt-l1</span> for Solana
            and BNB Chain with score 45.
          </li>
          <li>
            Resilience became <code className="text-xs bg-muted px-1 py-0.5 rounded">(collateral + custody) / 2</code>;
            blacklist capability is now descriptive only.
          </li>
          <li>
            Chain-risk penalty moved to 5 bands, and wrapper governance became
            exempt from that penalty.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.9 ──────────── */}
      <VersionCard
        version="v5.9"
        title="Classification corrections: centralized-custody DeFi coins"
        date="Mar 20, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Three DeFi-classified coins were corrected after live reserve review
          showed majority centralized custody exposure.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground font-medium">meUSD</span>, <span className="text-foreground font-medium">ALUSD</span>, and{" "}
            <span className="text-foreground font-medium">BtcUSD</span> were reclassified from
            decentralized to centralized-dependent.
          </li>
          <li>
            ALUSD&apos;s earlier v4.1 correction was explicitly reversed after
            reserve review showed majority direct USDC/USDT exposure.
          </li>
          <li>
            meUSD and BtcUSD were corrected after live reserves confirmed
            custodial BTC-variant backing.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.8 ──────────── */}
      <VersionCard
        version="v5.8"
        title="Live reserve passthrough for collateral quality"
        date="Mar 14, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Collateral quality scoring now consumes{" "}
          <span className="text-foreground font-medium">live reserve snapshots</span> when
          available, using hourly data from <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_composition</code>{" "}
          instead of curated metadata.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Coins with <code className="text-xs bg-muted px-1 py-0.5 rounded">liveReservesConfig</code> use
            fresh (&lt;48h) live snapshots for collateral quality instead of curated metadata.
          </li>
          <li>
            Delta alert fires when live-derived score diverges from curated by &gt;15 points.
          </li>
          <li>
            Dependency inference remains on curated data (live slices lack coinId links).
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.7 ──────────── */}
      <VersionCard
        version="v5.7"
        title="Canonical ETH wrapper reserve alignment"
        date="Mar 13, 2026"
        accent="border-l-amber-500"
      >
        <p>
          Direct <span className="text-foreground font-medium">ETH</span> and canonical
          <span className="text-foreground font-medium"> WETH</span> reserve slices now share the same
          <span className="text-foreground font-medium"> very-low</span> risk tier.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Updated the shared direct-asset reserve map used by live reserve adapters so `WETH` no longer falls into
            the generic wrapped-asset bucket.
          </li>
          <li>
            Aligned curated reserve metadata and live config overrides for coins that expose plain `WETH` or `ETH`
            slices.
          </li>
          <li>
            Left mixed strategy buckets unchanged. Delta-neutral ETH exposures, bridged ETH buckets, and mixed
            BTC/ETH slices still use their existing manually-modeled risk tiers.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.6 ──────────── */}
      <VersionCard
        version="v5.6"
        title="Exit-liquidity integration"
        date="Mar 12, 2026"
        accent="border-l-amber-500"
      >
        <p>
          The Safety Score liquidity dimension now evaluates
          <span className="text-foreground font-medium"> exit liquidity</span>,
          not just raw DEX depth.
        </p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Added a new <span className="text-foreground font-medium">redemption backstop dataset</span>
            for redeemable assets, covering onchain collateral redemptions, stable basket redemptions,
            queue-based liquid-buffer systems, and issuer redemption rails.
          </li>
          <li>
            The report-card Liquidity dimension now uses an
            <span className="text-foreground font-medium"> effective exit score</span>:
            DEX liquidity remains the floor, while redemption quality can improve the dimension
            without redefining the standalone DEX liquidity score.
          </li>
          <li>
            Added route-family caps so queue-based and offchain issuer systems cannot look
            unrealistically liquid even when redemption exists.
          </li>
        </ul>
      </VersionCard>

      {/* ──────────── v5.5 ──────────── */}
      <VersionCard
        version="v5.5"
        title="Peg score fairness for young coins"
        date="Mar 1, 2026"
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
        date="Feb 28, 2026"
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
        date="Feb 28, 2026"
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
        date="Feb 28, 2026"
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
        date="Feb 28, 2026"
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
        date="Feb 28, 2026"
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
        date="Feb 27, 2026"
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
        date="Feb 27, 2026"
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
                <th className="py-2 pr-4 font-medium text-foreground">pegScore</th>
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
        date="Feb 27, 2026"
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
        date="Feb 27, 2026"
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
        date="Feb 26, 2026"
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
        date="Feb 26, 2026"
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
        version="v1.0"
        title="Initial implementation"
        date="Feb 25, 2026"
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
                      `v5.0\u2013${SAFETY_SCORE_VERSION_LABEL.replace(/^v/, "")}`,
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
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
