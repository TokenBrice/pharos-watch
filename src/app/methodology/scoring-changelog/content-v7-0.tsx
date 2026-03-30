import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV70Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.0")}
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
      </ul>
    </VersionCard>
  );
}
