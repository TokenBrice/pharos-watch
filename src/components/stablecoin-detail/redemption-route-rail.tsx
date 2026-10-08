import { Banknote, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { RailArrow, RailStationChip, StationLabel } from "@/components/stablecoin-detail/rail-station";
import { REDEMPTION_ACCESS_PASSPORT_LABELS } from "@/lib/redemption-backstop-labels";
import type { RedemptionAccessModel } from "@shared/types/redemption";

/**
 * The access gate, drawn: restriction is geometry, not adjectives. A
 * permissionless route renders an open (dashed) gate; whitelisted, issuer,
 * and manual routes render it closed, with the bounded access label beneath.
 *
 * It carries the authored-short access vocabulary rather than the full label,
 * which truncated on every bounded route (`ISSUER / INSTITUTIO…`); the full
 * string stays available on hover and in the diagram's `aria-label`.
 *
 * The gate sits inside the same bordered chip the other three stations use.
 * Drawn bare it was the only unboxed station on the rail, and two thin
 * unlabelled bars floating between boxed neighbours read as a rendering
 * artifact rather than as a closed gate (owner feedback 2026-08-11).
 */
function AccessGate({ accessModel, accessLabel }: { accessModel: RedemptionAccessModel; accessLabel: string }) {
  const open = accessModel === "permissionless-onchain";
  const shortLabel = REDEMPTION_ACCESS_PASSPORT_LABELS[accessModel];
  const barClass = open
    ? "border-l border-dashed border-emerald-600/70 dark:border-emerald-400/70"
    : "w-0.5 rounded-full bg-foreground/60";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1.5",
        open ? "border-emerald-600/40 bg-emerald-500/5" : "border-border/60",
      )}
      title={accessLabel}
    >
      <span aria-hidden="true" className={cn("flex h-3 items-center", open ? "gap-1.5" : "gap-0.5")}>
        <span className={cn("h-full", barClass)} />
        <span className={cn("h-full", barClass)} />
      </span>
      <span
        className={cn(
          "font-mono text-[11px] font-semibold uppercase tracking-wide",
          open ? "text-emerald-700 dark:text-emerald-400" : "text-foreground",
        )}
      >
        {shortLabel}
      </span>
    </span>
  );
}

/**
 * The exit rail — the mirror of the mint rail: holder → access gate → venue →
 * output, with settlement annotated on the final leg. Every mark encodes a
 * published field (gate geometry = access model, arrow label = settlement,
 * terminal chip = output asset). Below `sm` the same four facts render as the
 * passport FactGrid — the rail needs more width than a phone column gives.
 */
export function RedemptionRouteRail({
  accessModel,
  accessLabel,
  settlementLabel,
  outputAssetLabel,
  routeFamilyLabel,
}: {
  accessModel: RedemptionAccessModel;
  accessLabel: string;
  settlementLabel: string;
  outputAssetLabel: string;
  routeFamilyLabel: string;
}) {
  return (
    <>
      <div
        role="img"
        aria-label={`Redemption route: holders exit through ${accessLabel} access to ${routeFamilyLabel}, settling ${settlementLabel} into ${outputAssetLabel}.`}
        className="hidden items-center gap-3 sm:flex"
      >
        {/* The kicker already names the station, so the chip carries only the
            glyph; printing "Holder" in both read as a stutter. */}
        <div className="flex shrink-0 flex-col gap-0.5">
          <StationLabel>Holder</StationLabel>
          <span className="inline-flex w-fit items-center rounded-md border border-border/60 px-2.5 py-1.5">
            <span className="flex h-4 items-center">
              <UserRound aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </span>
        </div>
        <RailArrow />
        <div className="flex shrink-0 flex-col gap-0.5">
          <StationLabel>Access</StationLabel>
          <AccessGate accessModel={accessModel} accessLabel={accessLabel} />
        </div>
        <RailArrow />
        <div className="flex min-w-0 flex-col gap-0.5">
          <StationLabel>Venue</StationLabel>
          <RailStationChip title={routeFamilyLabel}>{routeFamilyLabel}</RailStationChip>
        </div>
        {/* The settlement leg never narrows below its label ("1-7 days"
            overran a 45 px gap at 768); the venue and output chips, which
            truncate with a title, give up the width instead. */}
        <div className="flex min-w-fit flex-1">
          <RailArrow label={settlementLabel} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <StationLabel>Output</StationLabel>
          <RailStationChip icon={Banknote} tone="terminal" title={outputAssetLabel}>
            {outputAssetLabel}
          </RailStationChip>
        </div>
      </div>
      <FactGrid
        className="sm:hidden"
        aria-label="Route properties"
        items={[
          { key: "access", label: "Access", value: accessLabel },
          { key: "settlement", label: "Settlement", value: settlementLabel },
          { key: "output", label: "Output", value: outputAssetLabel },
        ]}
      />
    </>
  );
}
