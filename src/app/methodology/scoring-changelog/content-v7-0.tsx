import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV695Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.95")}
      accent="border-l-amber-500"
    >
      <p>
        Direct inherited freeze risk now counts two reserve-side collateral classes that were previously
        under-attributed: custodied BTC wrappers and issuer-seizable tokenized collateral.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code>{" "}
          now treats centralized-custody BTC wrappers such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">WBTC</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">cbBTC</code> as{" "}
          <span className="text-foreground font-medium">direct</span> inherited freeze exposure rather
          than only weak possible clues.
        </li>
        <li>
          Issuer-seizable tokenized collateral such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PAXG</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">XAUT</code>, and reviewed tokenized
          share symbols such as <code className="text-xs bg-muted px-1 py-0.5 rounded">BOSS</code>{" "}
          now counts toward the same direct inherited threshold.
        </li>
        <li>
          Coins whose reserve mix crosses the majority threshold because of these assets now resolve to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code>.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV694Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.94")}
      accent="border-l-amber-500"
    >
      <p>
        NAV wrappers that explicitly wrap a stablecoin now inherit peg risk from the referenced base
        asset instead of getting an automatic neutral peg multiplier.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Configured NAV wrappers can now reuse a referenced base stablecoin&apos;s{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore</code> in Safety Score
          report-card scoring.
        </li>
        <li>
          Pure fund-share NAV tokens with no configured peg reference still keep{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore = NR</code> and the neutral
          multiplier treatment.
        </li>
        <li>
          This specifically closes the loophole where a wrapped stablecoin NAV structure could avoid the
          stronger v6.93 peg penalty even when the underlying base stablecoin had clear peg risk.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV693Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.93")}
      accent="border-l-amber-500"
    >
      <p>
        Peg stability now has more weight in the final grade, and severe live depegs can hard-cap the
        score regardless of otherwise strong base dimensions.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PEG_MULTIPLIER_EXPONENT</code>{" "}
          increased from <code className="text-xs bg-muted px-1 py-0.5 rounded">0.20</code> to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">0.40</code>.
        </li>
        <li>
          Active depegs at or above{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">1000 bps</code> now cap the overall
          score at D, and active depegs at or above{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">2500 bps</code> cap it at F.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">activeDepegBps</code> is now exposed
          in report-card raw inputs so the frontend and stressed-grade recomputation paths apply the same
          cap logic.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV692Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.92")}
      accent="border-l-amber-500"
    >
      <p>
        LUSD now uses direct Liquity v1 system-collateral reads instead of the generic proof-style
        liveness probe, so clean snapshots qualify as independent live reserve evidence.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The dedicated <code className="text-xs bg-muted px-1 py-0.5 rounded">liquity-v1</code>{" "}
          adapter reads <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemColl()</code>{" "}
          and <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemDebt()</code>{" "}
          from the official Ethereum <code className="text-xs bg-muted px-1 py-0.5 rounded">TroveManager</code>.
        </li>
        <li>
          LUSD reserve snapshots remain a single-bucket 100% ETH view, but the adapter is now registered
          as <code className="text-xs bg-muted px-1 py-0.5 rounded">independent</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>.
        </li>
        <li>
          This promotes LUSD&apos;s clean authoritative reserve snapshots into collateral-quality live
          passthrough without relaxing the generic gate for other{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">single-asset</code> probes.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV691Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.91")}
      accent="border-l-amber-500"
    >
      <p>
        Blacklistability attribution now treats reserve-side freeze clues as first-class signals instead of
        only trusting explicit slice flags and resolved upstream coin IDs.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code>{" "}
          now resolves to <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> when
          curated or live reserve labels imply blacklistable stablecoins, wrappers, or CEX/custody rails
          below the majority threshold.
        </li>
        <li>
          Majority <span className="text-foreground font-medium">direct</span> reserve exposure still
          resolves to <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code>; the new
          heuristics are there to prevent reserve-side exposure from incorrectly falling through to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">no</code>.
        </li>
        <li>
          Live reserve enrichment and curated reserve evaluation now share the same direct clue detection
          for named stablecoin baskets and explicit custody/CEX descriptors.
        </li>
        <li>
          This does not relax the collateral passthrough gate:{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">static-validated</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>, and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=unverified</code>{" "}
          reserve feeds remain detail-visible only.
        </li>
      </ul>
    </VersionCard>
  );
}
