import type { ReactNode } from "react";

export const scoringChangelogV69Details: Record<string, ReactNode> = {
  "6.9": (
    <>
      <p>Blacklistability attribution now separates mutable-contract risk from collateral-inherited freeze risk.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared blacklistability resolution no longer treats{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">centralized-dependent</code> governance as enough
          evidence for <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> on its own.
        </li>
        <li>
          Reserve-heavy downstream freeze exposure now surfaces as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code>, which is distinct from
          mutable-contract risk.
        </li>
        <li>
          Inherited status became an explicit upstream-freeze category that can use curated reserve-slice{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">blacklistable</code> markers in addition to upstream
          stablecoin links; v7.13 later removed the reserve-weight gate.
        </li>
      </ul>
    </>
  ),
};
