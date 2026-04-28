import type { PharosVilleFreshness, PharosVilleWorld } from "../systems/world-types";

const freshnessLabels: Record<keyof PharosVilleFreshness, string> = {
  stablecoinsStale: "Stablecoins",
  chainsStale: "Chains",
  stabilityStale: "PSI",
  pegSummaryStale: "Peg summary",
  stressStale: "Stress signals",
  reportCardsStale: "Report cards",
};

export interface QueryStatusBannerProps {
  world: PharosVilleWorld;
  headingId?: string;
}

export function QueryStatusBanner({ world, headingId = "pharosville-query-status-title" }: QueryStatusBannerProps) {
  const staleSources = Object.entries(world.freshness)
    .filter((entry): entry is [keyof PharosVilleFreshness, true] => entry[1] === true)
    .map(([key]) => freshnessLabels[key]);

  return (
    <section
      role={world.routeMode === "error" ? "alert" : "status"}
      aria-live={world.routeMode === "error" ? "assertive" : "polite"}
      aria-labelledby={headingId}
      data-testid="pharosville-query-status-banner"
    >
      <h2 id={headingId}>Data status</h2>
      <p>{statusMessage(world.routeMode, staleSources)}</p>
      {staleSources.length > 0 && (
        <ul>
          {staleSources.map((source) => (
            <li key={source}>{source} data is stale.</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusMessage(routeMode: PharosVilleWorld["routeMode"], staleSources: string[]): string {
  if (routeMode === "loading") return "PharosVille data is loading.";
  if (routeMode === "desktop-only") return "PharosVille is available on desktop-sized screens.";
  if (routeMode === "error") return "PharosVille data could not be loaded.";
  if (staleSources.length > 0) return "PharosVille is using stale source data for part of the map.";
  return "PharosVille source data is current.";
}
