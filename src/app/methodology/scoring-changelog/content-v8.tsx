import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV81Entry() {
  return (
    <VersionCard entry={getScoringEntry("8.1")}>
      <p>
        Crypto-backed CDP stablecoins can now carry a reviewed oracle-risk profile. When one is present,
        Decentralization applies a penalty-only oracle setup blend —{" "}
        <span className="pharos-numeric">min(current, 0.75 × current + 0.25 × oracle score)</span> — because
        liquidations and redemptions depend on the collateral price-feed path.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The blend applies only to explicit <code className="text-xs">oracleRisk</code> profiles on crypto-backed CDP
          assets; missing reviews and non-CDP assets are unchanged.
        </li>
        <li>
          The oracle step runs after governance and chain infrastructure, before the existing Mint Authority blend.
          Immutable-code CDPs are not exempt because oracle feeds remain an external dependency.
        </li>
        <li>
          Initial reviewed profiles cover USDS as a medianized delayed oracle system and BOLD as redundant feeds with
          failover. Other CDPs stay unchanged until reviewed oracle metadata is curated.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV80Entry() {
  return (
    <VersionCard entry={getScoringEntry("8.0")}>
      <p>
        The Mint Authority Score becomes a Safety Score input: the Decentralization dimension now applies a penalty-only
        blend — <span className="pharos-numeric">min(current, 0.65 × current + 0.35 × MAS)</span> — so a weak
        privileged-mint path can drag the dimension down, while a strong one never lifts it.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The blend runs after the governance baseline, wrapper inheritance, and the chain-infrastructure penalty; a
          &quot;Mint authority&quot; detail row appears on the report card when the drag binds.
        </li>
        <li>
          Coins without a rated Mint Authority Score are unchanged — a missing or unresolved review never penalizes.
        </li>
        <li>
          No separate confidence gate: the Mint Authority confidence caps (verified 100 / probable 90 / manual-review
          85) already encode evidence quality inside the score.
        </li>
        <li>
          111 of 368 scoreable active coins move down, none up; the biggest drops are mint-incident and unbounded-mint
          protocols, while issuers whose governance scores already reflect their mint topology are unchanged.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV8Entries() {
  return (
    <>
      <ScoringChangelogV81Entry />
      <ScoringChangelogV80Entry />
    </>
  );
}
