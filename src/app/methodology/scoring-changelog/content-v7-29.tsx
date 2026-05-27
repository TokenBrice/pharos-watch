import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV729Entry() {
  return (
    <VersionCard entry={getScoringEntry("7.29")}>
      <p>fxSAVE redemption scoring now uses live ERC-4626 capacity instead of a heuristic strategy-buffer estimate.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>Fresh clean snapshots read idle fxSP capacity from the current on-chain reserve-sync output.</li>
        <li>Clean live capacity can reach medium confidence and feed Liquidity / Exit.</li>
        <li>Missing or degraded live telemetry leaves the route unrated rather than applying the old 20% heuristic.</li>
      </ul>
    </VersionCard>
  );
}
