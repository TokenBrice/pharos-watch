"use client";

import type { DependencyScenarioArtifact, DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { DEPENDENCY_SCENARIO_KIND_LABELS, DEPENDENCY_SCENARIO_DIMENSION_LABELS } from "@shared/lib/classification";
import { DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC } from "@shared/types/dependency-scenarios";

type Scenario = DependencyScenarioArtifact["scenarios"][number];
export interface DependencyScenarioSelection {
  scenario: Scenario | null;
  current: boolean;
  showNumbers: boolean;
  state: string;
  generation: string | null;
  ageSec: number | null;
}

export function selectDependencyScenario(response: DependencyScenariosResponse | undefined, roots: readonly string[], selectedId: string, publicationId: string, failed: boolean, nowSec = Date.now() / 1000): DependencyScenarioSelection {
  const artifact = response?.artifact;
  const candidates = artifact?.scenarios.filter(row => roots.includes(row.rootId)) ?? [];
  const scenario = candidates.find(row => row.id === selectedId) ?? candidates[0] ?? null;
  const ageSec = artifact ? Math.max(response?.freshness.ageSec ?? 0, 0, nowSec - artifact.computedAtSec) : null;
  const generation = artifact?.sourcePublicationGenerationId ?? null;
  if (failed || !artifact || !response || response.freshness.status === "unavailable" || !response.freshness.acceptedPublicationGenerationId || artifact.computedAtSec > nowSec) {
    return { scenario, current: false, showNumbers: false, state: `Modeled results unavailable. ${failed ? "Read failed." : response?.freshness.reason ?? "Artifact not available."}`, generation, ageSec };
  }
  if (response.freshness.status === "stale" || ageSec! > DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC) {
    return { scenario, current: false, showNumbers: false, state: `Modeled results stale. ${response.freshness.reason ?? "Artifact exceeds its freshness budget."} Numbers are withheld.`, generation, ageSec };
  }
  const earlier = response.freshness.status === "earlier-generation";
  const displayedGenerationDiffers = generation !== publicationId;
  const minutes = Math.floor(ageSec! / 60);
  const state = earlier
    ? `Modeled on publication ${generation}, ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago; the current publication is newer`
    : displayedGenerationDiffers ? `The displayed map publication differs from the modeled publication ${generation}` : "";
  return { scenario, current: !earlier && !displayedGenerationDiffers, showNumbers: true, state, generation, ageSec };
}

function scenarioLabel(scenario: Scenario): string {
  const spec = scenario.shock;
  switch (spec.kind) {
    case "score-limit": return `${DEPENDENCY_SCENARIO_KIND_LABELS[spec.kind]} (${DEPENDENCY_SCENARIO_DIMENSION_LABELS[spec.dimension]}, ${spec.limit})`;
    case "depeg": return `${DEPENDENCY_SCENARIO_KIND_LABELS[spec.kind]} (${spec.activeDepegBps} bps, ${spec.template})`;
    case "mint-control-compromise": return DEPENDENCY_SCENARIO_KIND_LABELS[spec.kind];
  }
}

export function DependencyScenarioChange({ selection, assetId }: { selection: DependencyScenarioSelection; assetId: string }) {
  if (!selection.showNumbers) return <span>{selection.state.startsWith("Modeled results stale") ? "Modeled stale" : "Modeled unavailable"}</span>;
  const failure = selection.scenario?.failures.find(row => row.assetId === assetId);
  if (failure) return <span>Modeled unavailable ({failure.code})</span>;
  const row = selection.scenario?.results.find(row => row.assetId === assetId);
  if (!row) return <span>No modeled change stored</span>;
  if (row.modeledGrade === "NR" || row.modeledScore === null) return <span>Modeled NR · change unavailable</span>;
  return <span>Modeled {row.modeledGrade} · {row.deltaScore === null ? "change unavailable" : `${row.deltaScore > 0 ? "+" : ""}${row.deltaScore.toFixed(2)} points`}</span>;
}

export function DependencyScenarioView({ response, roots, selection, selectedId, onSelect, label }: {
  response: DependencyScenariosResponse | undefined; roots: readonly string[]; selection: DependencyScenarioSelection;
  selectedId: string; onSelect: (id: string) => void; label: (id: string) => string;
}) {
  const candidates = response?.artifact?.scenarios.filter(row => roots.includes(row.rootId)) ?? [];
  return <section aria-label="Modeled Safety Score results" className="space-y-2 rounded border border-border p-3">
    <h4 className="font-semibold">Published → modeled grade</h4>
    {!selection.current && <p role="status" className="text-sm">{selection.state}</p>}
    {selection.generation && <p className="break-all text-xs text-muted-foreground">Modeled with the production Safety Score evaluator on publication {selection.generation}; not a forecast</p>}
    <p className="text-xs text-muted-foreground">Artifact age {selection.ageSec === null ? "unavailable" : `${Math.floor(selection.ageSec / 60)} minutes`} · freshness budget {DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC / 3600} hours</p>
    {candidates.length > 0 ? <>
      <label className="block text-sm">Scenario type <select className="min-h-11 max-w-full rounded border border-border bg-background px-2" value={selection.scenario?.id ?? selectedId} onChange={event => onSelect(event.target.value)}>{candidates.map(row => <option key={row.id} value={row.id}>{label(row.rootId)}: {scenarioLabel(row)}</option>)}</select></label>
      <h5 className="text-sm font-medium">Stated assumptions</h5>
      <ul className="list-inside list-disc text-sm">{selection.scenario?.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
      <p className="text-xs text-muted-foreground">Modeled results include role dependencies. The exposure table uses mapped collateral and wrapper relationships only. Stored rows include changed coins and the upstream root; missing rows are not numeric estimates.</p>
      {selection.showNumbers && <table className="w-full text-left text-sm"><caption className="sr-only">Published and modeled grades for stored scenario rows</caption><thead><tr><th className="p-2">Coin</th><th className="p-2">Published → modeled grade</th><th className="p-2">Modeled Safety Score change</th></tr></thead><tbody>{selection.scenario?.results.map(row => <tr className="border-t border-border" key={row.assetId}><td className="p-2">{label(row.assetId)}{row.assetId === selection.scenario?.rootId ? " (upstream root)" : ""}</td><td className="p-2">{row.publishedGrade} → {row.modeledScore === null ? "NR" : row.modeledGrade}</td><td className="p-2"><DependencyScenarioChange selection={selection} assetId={row.assetId} /></td></tr>)}</tbody></table>}
      {selection.showNumbers && selection.scenario?.failures.map(failure => <p key={failure.assetId} className="text-sm">{label(failure.assetId)}: modeled result unavailable ({failure.code})</p>)}
    </> : selection.showNumbers && <p className="text-sm">No modeled artifact rows for the selected upstream coins.</p>}
  </section>;
}
