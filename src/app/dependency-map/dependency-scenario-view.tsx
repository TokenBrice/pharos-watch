"use client";

import type { DependencyScenarioArtifact, DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { DEPENDENCY_SCENARIO_KIND_LABELS, DEPENDENCY_SCENARIO_DIMENSION_LABELS } from "@shared/lib/classification";
import { DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC } from "@shared/types/dependency-scenarios";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";
import { cn } from "@/lib/utils";
import { isClientTokenizedFundId } from "@shared/lib/stablecoins/aggregate-client-registry";
import type { ReportCardGrade } from "@shared/types/report-card-grade";

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

function deltaChipTone(deltaScore: number | null): string {
  if (deltaScore == null || deltaScore === 0) return "border-border/70 bg-muted/40 text-muted-foreground";
  return deltaScore < 0
    ? "border-state-danger/30 bg-state-danger-subtle text-state-danger"
    : "border-state-positive/30 bg-state-positive-subtle text-state-positive";
}

export function DependencyScenarioChange({ selection, assetId }: { selection: DependencyScenarioSelection; assetId: string }) {
  if (!selection.showNumbers) return <span className="text-xs text-muted-foreground">{selection.state.startsWith("Modeled results stale") ? "Modeled stale" : "Modeled unavailable"}</span>;
  const failure = selection.scenario?.failures.find(row => row.assetId === assetId);
  if (failure) return <span className="text-xs text-muted-foreground">Modeled unavailable ({failure.code})</span>;
  const row = selection.scenario?.results.find(row => row.assetId === assetId);
  if (!row) return <span className="text-xs text-muted-foreground">No modeled change stored</span>;
  const partial = describePartialEvidence({ ratingStatus: row.modeledRatingStatus, partialEvidence: row.modeledPartialEvidence, pillars: row.modeledPillars });
  if (row.modeledRatingStatus === "pipeline-gap") {
    return (
      <span className="inline-flex rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
        Modeled Pipeline gap · {row.modeledPartialEvidence?.excludedPillars.length === 3 ? "all pillars unavailable" : "fewer than two pillars available"} · change unavailable{partial && ` · ${partial.gaps.map(formatPartialEvidenceGap).join(" · ")}`}
      </span>
    );
  }
  if (isClientTokenizedFundId(assetId)) {
    return (
      <span
        className="inline-flex rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
        title="Tokenized fund — not graded on Safety Score"
      >
        Not graded · tokenized fund
      </span>
    );
  }
  if (row.modeledRatingStatus === "not-rated") {
    return (
      <span className="inline-flex rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
        Modeled NR · change unavailable
      </span>
    );
  }
  return (
    <span
      title={partial?.summary}
      className={cn(
        "pharos-numeric inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
        deltaChipTone(row.deltaScore),
      )}
    >
      Modeled {row.modeledGrade} · {row.deltaScore === null ? "change unavailable" : `${row.deltaScore > 0 ? "+" : ""}${row.deltaScore.toFixed(2)} points`}{partial && ` · ${partial.gaps.map(formatPartialEvidenceGap).join(" · ")}`}
    </span>
  );
}

export function DependencyScenarioView({ response, roots, selection, selectedId, onSelect, label, logos }: {
  response: DependencyScenariosResponse | undefined;
  roots: readonly string[];
  selection: DependencyScenarioSelection;
  selectedId: string;
  onSelect: (id: string) => void;
  label: (id: string) => string;
  logos?: Record<string, string>;
}) {
  const candidates = response?.artifact?.scenarios.filter(row => roots.includes(row.rootId)) ?? [];
  return (
    <section aria-label="Modeled Safety Score results" className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-3.5">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-foreground">Published → modeled grade</h4>
        {!selection.current && <p role="status" className="text-xs text-state-warn">{selection.state}</p>}
      </div>

      {candidates.length > 0 ? (
        <>
          <label className="block text-xs font-medium text-muted-foreground">
            Scenario type{" "}
            <select
              className="mt-1 block min-h-11 max-w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground sm:min-h-9"
              value={selection.scenario?.id ?? selectedId}
              onChange={event => onSelect(event.target.value)}
            >
              {candidates.map(row => <option key={row.id} value={row.id}>{label(row.rootId)}: {scenarioLabel(row)}</option>)}
            </select>
          </label>
          <div className="space-y-1">
            <h5 className="pharos-label">Stated assumptions</h5>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {selection.scenario?.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            Modeled results include role dependencies. The exposure table uses mapped collateral and wrapper relationships only. Stored rows include changed coins and the upstream root; missing rows are not numeric estimates.
          </p>
          {selection.showNumbers && (
            <TableFrame caption="Published and modeled grades for stored scenario rows" captionClassName="sr-only" tableClassName="w-full text-left text-sm">
              <TableHeader>
                <TableRow rowIntent="static">
                  <TableHead className="p-2">Coin</TableHead>
                  <TableHead className="p-2">Published → modeled grade</TableHead>
                  <TableHead className="p-2">Modeled Safety Score change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{selection.scenario?.results.map(row => {
                const isFund = isClientTokenizedFundId(row.assetId);
                const publishedPipelineGap = row.publishedRatingStatus === "pipeline-gap";
                const modeledPipelineGap = row.modeledRatingStatus === "pipeline-gap";
                const partial = isFund && !publishedPipelineGap
                  ? null
                  : describePartialEvidence({ ratingStatus: row.publishedRatingStatus, partialEvidence: row.publishedPartialEvidence, pillars: row.publishedPillars });
                const publishedText = publishedPipelineGap ? "Pipeline gap" : isFund ? "Not graded" : row.publishedGrade;
                const modeledText = modeledPipelineGap ? "Pipeline gap" : isFund ? "Not graded" : row.modeledGrade;
                const publishedGrade: ReportCardGrade | null = publishedPipelineGap || isFund ? null : row.publishedGrade;
                const modeledGrade: ReportCardGrade | null = modeledPipelineGap || isFund ? null : row.modeledGrade;
                return (
                  <TableRow rowIntent="static" className="border-t border-border" key={row.assetId}>
                    <TableCell className="p-2">
                      <div className="flex items-center gap-2">
                        <StablecoinLogo src={logos?.[row.assetId]} name={label(row.assetId)} size={20} />
                        <span className="font-medium text-foreground">
                          {label(row.assetId)}{row.assetId === selection.scenario?.rootId ? " (upstream root)" : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="p-2">
                      {isFund && !publishedPipelineGap && !modeledPipelineGap ? (
                        <span
                          className="inline-flex rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                          title="Tokenized fund — not graded on Safety Score"
                        >
                          Not graded
                        </span>
                      ) : (
                        <>
                          <span className="sr-only">{publishedText} → {modeledText}</span>
                          <span aria-hidden="true" className="inline-flex items-center gap-1.5">
                            {isFund && !publishedPipelineGap ? (
                              <span className="inline-flex rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                Not graded
                              </span>
                            ) : (
                              <SafetyGradeBadge grade={publishedGrade} size="xs" />
                            )}
                            <span className="text-xs text-muted-foreground">→</span>
                            {isFund && !modeledPipelineGap ? (
                              <span className="inline-flex rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                Not graded
                              </span>
                            ) : (
                              <SafetyGradeBadge grade={modeledGrade} size="xs" />
                            )}
                          </span>
                        </>
                      )}
                      {partial && (
                        <span className="block text-xs text-muted-foreground" title={partial.summary}>
                          Published: {partial.gaps.map(formatPartialEvidenceGap).join(" · ")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="p-2"><DependencyScenarioChange selection={selection} assetId={row.assetId} /></TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </TableFrame>
          )}
          {selection.showNumbers && selection.scenario?.failures.map(failure => <p key={failure.assetId} className="text-sm">{label(failure.assetId)}: modeled result unavailable ({failure.code})</p>)}
        </>
      ) : selection.showNumbers && <p className="text-sm text-muted-foreground">No modeled artifact rows for the selected upstream coins.</p>}

      <details className="border-t border-border/50 pt-1.5 text-xs text-muted-foreground">
        <summary className="pharos-focus-ring cursor-pointer rounded-sm py-1 font-medium text-muted-foreground hover:text-foreground">
          Scenario provenance &amp; freshness
        </summary>
        <div className="mt-1 space-y-0.5">
          {selection.generation && <p className="break-all">Modeled with the production Safety Score evaluator on publication {selection.generation}; not a forecast</p>}
          <p>Artifact age {selection.ageSec === null ? "unavailable" : `${Math.floor(selection.ageSec / 60)} minutes`} · freshness budget {DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC / 3600} hours</p>
        </div>
      </details>
    </section>
  );
}
