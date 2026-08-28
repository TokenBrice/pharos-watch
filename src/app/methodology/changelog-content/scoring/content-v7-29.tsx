import type { ReactNode } from "react";

export const scoringChangelogV729Details: Record<string, ReactNode> = {
  "7.291": (
    <>
      <p>
        Safety Score scoring is unchanged, but degraded report-card inputs no longer create durable grade-history
        transitions and the compact score cache now exposes input-staleness metadata to dependent consumers.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Daily grade-history writes are suppressed when stale DEX liquidity or redemption-backstop inputs built the
          report-card snapshot.
        </li>
        <li>
          The history cron records degraded conditions in cron metadata instead of persisting stale-input transitions.
        </li>
        <li>
          The compact report-card cache now carries degraded-input metadata for Chain Health and other lightweight
          consumers.
        </li>
      </ul>
    </>
  ),
  "7.29": (
    <>
      <p>fxSAVE redemption scoring now uses live ERC-4626 capacity instead of a heuristic strategy-buffer estimate.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>Fresh clean snapshots read idle fxSP capacity from the current on-chain reserve-sync output.</li>
        <li>Clean live capacity can reach medium confidence and feed Liquidity / Exit.</li>
        <li>Missing or degraded live telemetry leaves the route unrated rather than applying the old 20% heuristic.</li>
      </ul>
    </>
  ),
};
