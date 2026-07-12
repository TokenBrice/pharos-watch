import type { ReactNode } from "react";

export const scoringChangelogV8Details: Record<string, ReactNode> = {
  "8.14": (
    <>
      <p>
        Dependency derivation now rejects self-links and represents each tracked variant as one serial wrapper claim on
        its parent, so displaying a parent&apos;s reserve book does not count that backing a second time.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Frax self-holdings remain visible in reserve composition but no longer create a FRAX-to-FRAX graph edge.</li>
        <li>
          Static metadata, adapter output, stored live snapshots, the canonical resolver, and graph emission all enforce
          the same self-link and target-validity invariants.
        </li>
        <li>
          Raw inputs now include dependency source, fallback reason, mapped live weight, and live snapshot provenance.
        </li>
        <li>The fixed-input all-card replay found two score changes and no grade or NR transitions.</li>
      </ul>
    </>
  ),
  "8.13": (
    <>
      <p>
        Dependency Risk now falls back to curated reserve links or manual dependencies when a score-grade live reserve
        snapshot contains no mapped tracked-asset links at all.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Partial live mappings stay authoritative: unmapped live reserve remainder still counts as self-backed or
          non-stablecoin exposure instead of reviving older curated percentages.
        </li>
        <li>
          The fallback applies only to the all-unmapped live case, where treating the whole snapshot as self-backed can
          erase known upstream stablecoin dependencies.
        </li>
        <li>
          Raw inputs keep <code className="text-xs">dependencyFromLive</code> true only for live-derived or explicitly
          live-unmapped dependency sets; curated/manual fallback dependencies report false.
        </li>
      </ul>
    </>
  ),
  "8.12": (
    <>
      <p>
        Reviewed bridge-route profiles now feed Decentralization through a penalty-only blend after CDP oracle scoring
        and before Mint Authority:{" "}
        <span className="pharos-numeric">min(current, 0.80 x current + 0.20 x bridge route score)</span>.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs">bridgeRouteRisk</code> profiles record route tier, summary, provenance, confidence,
          protocol evidence, and sources.
        </li>
        <li>
          Missing bridge-route reviews remain neutral, and strong issuer-native or canonical routes never lift a score.
        </li>
        <li>
          L2BEAT Interop data powers an advisory review queue, but live report-card scoring consumes only curated Pharos
          metadata.
        </li>
      </ul>
    </>
  ),
  "8.11": (
    <>
      <p>
        Oracle-risk reviews now carry provenance and optional branch rows. When a CDP profile has branch-level oracle
        tiers, the Decentralization blend uses the weakest branch/profile score so multi-collateral systems are scored
        against their weakest verified price-feed path.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs">oracleRisk</code> profiles can include reviewed date, reviewer, confidence, source
          links, and per-branch collateral/chains context.
        </li>
        <li>
          Report-card payloads now expose an oracle setup presentation object, including inherited parent exposure for
          wrappers and savings variants.
        </li>
        <li>
          A warning-only coverage check and calibration report support the full CDP oracle-profile backfill and later
          review of the 25% blend weight.
        </li>
      </ul>
    </>
  ),
  "8.1": (
    <>
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
    </>
  ),
  "8.0": (
    <>
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
    </>
  ),
};
