import type { PharosVilleWorld } from "../systems/world-types";

const compactUsd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

const percent = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
});

export interface AccessibilityLedgerProps {
  world: PharosVilleWorld;
  headingId?: string;
}

export function AccessibilityLedger({
  world,
  headingId = "pharosville-accessibility-ledger-title",
}: AccessibilityLedgerProps) {
  const staleSources = freshnessEntries(world)
    .filter((entry) => entry.stale)
    .map((entry) => entry.label);

  return (
    <section className="sr-only" aria-labelledby={headingId} data-testid="pharosville-accessibility-ledger">
      <h2 id={headingId}>PharosVille accessibility ledger</h2>
      <p>
        Generated at{" "}
        <time dateTime={new Date(world.generatedAt).toISOString()}>{new Date(world.generatedAt).toISOString()}</time>.
        {staleSources.length > 0
          ? ` Stale source groups: ${staleSources.join(", ")}.`
          : " All source groups are current."}
      </p>

      <dl>
        <div>
          <dt>Route mode</dt>
          <dd>{world.routeMode}</dd>
        </div>
        <div>
          <dt>Map size</dt>
          <dd>
            {world.map.width} by {world.map.height} tiles, {percent.format(world.map.waterRatio)} water.
          </dd>
        </div>
        <div>
          <dt>Lighthouse</dt>
          <dd>
            {world.lighthouse.label}: PSI {world.lighthouse.score ?? "unavailable"}, band{" "}
            {world.lighthouse.psiBand ?? "unavailable"}.
          </dd>
        </div>
      </dl>

      <h3>Docks</h3>
      <ol>
        {world.docks.map((dock) => (
          <li key={dock.id}>
            {dock.label}: {compactUsd.format(dock.totalUsd)} stablecoin supply, {dock.stablecoinCount} stablecoins,
            health {dock.healthBand ?? "unavailable"}.
          </li>
        ))}
      </ol>

      <h3>Ships</h3>
      <ol>
        {world.ships.map((ship) => (
          <li key={ship.id}>
            {ship.label} ({ship.symbol}): {compactUsd.format(ship.marketCapUsd)} market cap, placed at{" "}
            {ship.riskPlacement}; evidence {ship.placementEvidence.sourceFields.join(", ") || "unavailable"}.
          </li>
        ))}
      </ol>

      <h3>Ship clusters</h3>
      <ol>
        {world.shipClusters.map((cluster) => (
          <li key={cluster.id}>
            {cluster.label}: {cluster.count} ships, {compactUsd.format(cluster.totalUsd)} total market cap, placed at{" "}
            {cluster.riskPlacement}. Members:{" "}
            {cluster.ships.map((ship) => `${ship.label} (${ship.symbol}) ${compactUsd.format(ship.marketCapUsd)}`).join("; ")}.
          </li>
        ))}
      </ol>

      <h3>Cemetery</h3>
      <ol>
        {world.graves.map((grave) => (
          <li key={grave.id}>
            {grave.entry.name} ({grave.entry.symbol}): {grave.entry.causeOfDeath}, {grave.entry.deathDate}.
          </li>
        ))}
      </ol>

      <h3>Visual cues</h3>
      <ol>
        {world.visualCues.map((cue) => (
          <li key={cue.id}>
            {cue.visual}: answers {cue.questionAnswered}; DOM equivalent {cue.domEquivalent}; failure state{" "}
            {cue.failureState}.
          </li>
        ))}
      </ol>
    </section>
  );
}

function freshnessEntries(world: PharosVilleWorld) {
  return [
    { label: "Stablecoins", stale: world.freshness.stablecoinsStale === true },
    { label: "Chains", stale: world.freshness.chainsStale === true },
    { label: "PSI", stale: world.freshness.stabilityStale === true },
    { label: "Peg summary", stale: world.freshness.pegSummaryStale === true },
    { label: "Stress signals", stale: world.freshness.stressStale === true },
    { label: "Report cards", stale: world.freshness.reportCardsStale === true },
  ];
}
