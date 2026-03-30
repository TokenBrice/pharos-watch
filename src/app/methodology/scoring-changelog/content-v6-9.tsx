import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV69Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.9")}
      accent="border-l-amber-500"
    >
      <p>
        Blacklistability attribution now separates mutable-contract risk from collateral-inherited freeze risk.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared blacklistability resolution no longer treats <code className="text-xs bg-muted px-1 py-0.5 rounded">centralized-dependent</code>{" "}
          governance as enough evidence for <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> on its own.
        </li>
        <li>
          Reserve-heavy downstream freeze exposure now surfaces as <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code>, which is distinct from mutable-contract risk.
        </li>
        <li>
          Inherited status now requires majority reserve exposure and can use curated reserve-slice <code className="text-xs bg-muted px-1 py-0.5 rounded">blacklistable</code>{" "}
          markers in addition to upstream stablecoin links.
        </li>
      </ul>
    </VersionCard>
  );
}
