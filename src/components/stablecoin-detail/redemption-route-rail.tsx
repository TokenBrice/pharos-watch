import { Banknote, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import type { RedemptionAccessModel } from "@shared/types/redemption";

function StationLabel({ children }: { children: string }) {
  return (
    <span className="text-[9px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
      {children}
    </span>
  );
}

function RailArrow({ label }: { label?: string }) {
  return (
    <div className="flex min-w-8 flex-1 flex-col items-center gap-0.5">
      {label ? (
        <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div aria-hidden="true" className="flex w-full items-center">
        <span className="h-px w-full bg-border" />
        <span className="border-y-4 border-l-[5px] border-border border-y-transparent" />
      </div>
    </div>
  );
}

/**
 * The access gate, drawn: restriction is geometry, not adjectives. A
 * permissionless route renders an open (dashed) gate; whitelisted, issuer,
 * and manual routes render it closed, with the bounded access label beneath.
 */
function AccessGate({ accessModel, accessLabel }: { accessModel: RedemptionAccessModel; accessLabel: string }) {
  const open = accessModel === "permissionless-onchain";
  const barClass = open
    ? "border-l border-dashed border-emerald-600/70 dark:border-emerald-400/70"
    : "w-0.5 rounded-full bg-foreground/60";
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5">
      <div aria-hidden="true" className={cn("flex h-6 items-center", open ? "gap-3" : "gap-1")}>
        <span className={cn("h-full", barClass)} />
        <span className={cn("h-full", barClass)} />
      </div>
      <span
        className={cn(
          "max-w-28 truncate text-center text-[9px] font-medium uppercase leading-tight tracking-[0.08em]",
          open ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
        )}
        title={accessLabel}
      >
        {accessLabel}
      </span>
    </div>
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
        <div className="flex flex-col gap-0.5">
          <StationLabel>Holder</StationLabel>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5">
            <UserRound aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">Holder</span>
          </span>
        </div>
        <RailArrow />
        <div className="flex flex-col gap-0.5">
          <StationLabel>Access</StationLabel>
          <AccessGate accessModel={accessModel} accessLabel={accessLabel} />
        </div>
        <RailArrow />
        <div className="flex flex-col gap-0.5">
          <StationLabel>Venue</StationLabel>
          <span className="inline-flex w-fit items-center rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">
            {routeFamilyLabel}
          </span>
        </div>
        <RailArrow label={settlementLabel} />
        <div className="flex flex-col gap-0.5">
          <StationLabel>Output</StationLabel>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5">
            <Banknote aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">
              {outputAssetLabel}
            </span>
          </span>
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
