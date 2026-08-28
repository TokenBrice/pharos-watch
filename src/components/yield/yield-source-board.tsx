"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import type { YieldSourceBoardModel, YieldSourceBoardRiskDriverCount } from "@/lib/yield-source-board-model";
import { SourceQualityBars, type YieldSourceBoardFilters } from "@/components/yield/yield-source-board-quality";
import { SourceLaneRow } from "@/components/yield/yield-source-board-lane";
import { AnomalyDisclosure, SourceSwitchDisclosure } from "@/components/yield/yield-source-board-disclosures";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
  activeFilters?: YieldSourceBoardFilters;
  onFilterChange?: (key: string, value: string) => void;
}

const LANE_DIGEST_COUNT = 5;
type DisclosureKey = "switches" | "anomalies";

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function SourceRiskDriverChips({ drivers }: { drivers: readonly YieldSourceBoardRiskDriverCount[] }) {
  if (drivers.length === 0) {
    return <p className="text-xs text-muted-foreground">No populated source-risk drivers in the visible rows.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2" aria-label="Top source-risk drivers">
      {drivers.map((driver) => (
        <Tooltip key={driver.key}>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              aria-label={`${driver.label}: ${pluralize(driver.count, "row")}`}
              className={cn("pharos-focus-ring inline-flex cursor-help items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium", SEVERITY_TONE_CLASS.watch.pill)}
            >
              <span>{driver.label}</span>
              <span className="pharos-numeric text-[10px] opacity-75">{driver.count}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-xs">
            <span className="font-medium">{pluralize(driver.count, "visible row")}</span>
            <span className="block text-background/75">{driver.description}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function DisclosureToggle({ label, description, open, controls, toneClass, onClick }: {
  label: string;
  description: string;
  open: boolean;
  controls: string;
  toneClass: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={controls}
      title={description}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        toneClass,
      )}
    >
      <span>{label}</span>
      <ChevronDown aria-hidden="true" className={cn("h-3 w-3 transition-transform", open ? "rotate-180" : "rotate-0")} />
    </button>
  );
}

export function YieldSourceBoard({ model, activeFilters, onFilterChange }: YieldSourceBoardProps) {
  const disclosureId = useId();
  const ledgerId = useId();
  const [openDisclosure, setOpenDisclosure] = useState<DisclosureKey | null>(null);
  const [showAllLanes, setShowAllLanes] = useState(false);
  if (model.representedSourceCount === 0) return null;

  const topLanes = model.groups.slice(0, LANE_DIGEST_COUNT);
  const extraLanes = model.groups.slice(LANE_DIGEST_COUNT);
  const extraLaneCount = extraLanes.length;
  const hasDisclosureBadges = model.sourceSwitchCount > 0 || model.anomalyCount > 0;
  const toggleDisclosure = (key: DisclosureKey) => setOpenDisclosure((current) => current === key ? null : key);

  return (
    <TooltipProvider>
      <section aria-labelledby="yield-source-board-heading" className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header space-y-5">
          <div className="space-y-1">
            <p className="pharos-kicker">Yield Sources</p>
            <h2 id="yield-source-board-heading" className="text-lg font-semibold tracking-tight text-foreground">
              Source mix in the current view
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Data families behind the visible rows. Counts every chosen source plus retained alternates.
            </p>
          </div>
          <SourceQualityBars model={model} activeFilters={activeFilters} onFilterChange={onFilterChange} />
          <div className="border-t border-border/50 pt-5">
            <SourceRiskDriverChips drivers={model.topSourceRiskDrivers} />
          </div>
          {hasDisclosureBadges ? (
            <div className="space-y-3 border-t border-border/50 pt-5">
              <div className="flex flex-wrap gap-2">
                {model.sourceSwitchCount > 0 ? (
                  <DisclosureToggle
                    label={pluralize(model.sourceSwitchCount, "source changed", "sources changed")}
                    description="A source changed when the selected source differs from the prior published snapshot. Click for the audit list."
                    open={openDisclosure === "switches"}
                    controls={disclosureId}
                    toneClass={cn(SEVERITY_TONE_CLASS.sky.pill, "hover:bg-sky-500/15")}
                    onClick={() => toggleDisclosure("switches")}
                  />
                ) : null}
                {model.anomalyCount > 0 ? (
                  <DisclosureToggle
                    label={`${pluralize(model.anomalyCount, "chosen source")} with anomalies`}
                    description="Anomalies flag source-observation quality issues such as low venue TVL or APY that diverges from recent history. Click for the audit list."
                    open={openDisclosure === "anomalies"}
                    controls={disclosureId}
                    toneClass={cn(SEVERITY_TONE_CLASS.watch.pill, "hover:bg-amber-500/15")}
                    onClick={() => toggleDisclosure("anomalies")}
                  />
                ) : null}
              </div>
              <div
                id={disclosureId}
                aria-hidden={openDisclosure === null}
                inert={openDisclosure === null}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
                  openDisclosure ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2">
                    {openDisclosure === "switches" ? <SourceSwitchDisclosure details={model.sourceSwitchDetails} /> : null}
                    {openDisclosure === "anomalies" ? <AnomalyDisclosure details={model.anomalyDetails} /> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <ul className="divide-y divide-border/60" aria-label="Yield source lanes">
          {topLanes.map((group) => <SourceLaneRow key={group.key} group={group} />)}
        </ul>
        {extraLaneCount > 0 ? (
          <>
            <div
              id={ledgerId}
              aria-hidden={!showAllLanes}
              inert={!showAllLanes}
              className={cn(
                "grid transition-[grid-template-rows] duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
                showAllLanes ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="overflow-hidden">
                <ul className="divide-y divide-border/60 border-t border-border/60" aria-label="Additional yield source lanes">
                  {extraLanes.map((group) => <SourceLaneRow key={group.key} group={group} />)}
                </ul>
              </div>
            </div>
            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => setShowAllLanes((value) => !value)}
                aria-expanded={showAllLanes}
                aria-controls={ledgerId}
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <span>{showAllLanes ? "Collapse ledger" : `Show full ledger (${extraLaneCount} more ${extraLaneCount === 1 ? "lane" : "lanes"})`}</span>
                <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", showAllLanes ? "rotate-180" : "rotate-0")} />
              </button>
            </div>
          </>
        ) : null}
      </section>
    </TooltipProvider>
  );
}
