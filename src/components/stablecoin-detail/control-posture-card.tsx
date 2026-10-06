"use client";

import { Braces, Building2, KeyRound, Landmark, Layers3, UserRound, type LucideIcon } from "lucide-react";
import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import type { ControlPostureView } from "@/lib/control-posture";
import { cn } from "@/lib/utils";
import { CONTROL_POSTURE_STYLES } from "@shared/lib/classification";
import type { GovernanceQuality } from "@shared/types";

const CONTROL_POSTURE_ICONS: Record<GovernanceQuality, LucideIcon> = {
  "immutable-code": Braces,
  "dao-governance": Landmark,
  multisig: KeyRound,
  "regulated-entity": Building2,
  "single-entity": UserRound,
  wrapper: Layers3,
};

const SECONDARY_CHIP_CLASS =
  "inline-flex items-center rounded-md border border-border/60 px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground";

/**
 * One categorical value, drawn as one: the posture chip plus its taxonomy and
 * scope as quiet secondary chips. The old six-tile map spent a 3x2 grid on a
 * single selected cell.
 */
function ControlPostureChips({ view }: { view: ControlPostureView }) {
  const style = CONTROL_POSTURE_STYLES[view.key];
  const Icon = CONTROL_POSTURE_ICONS[view.key];
  const facts = Object.fromEntries(view.facts.map((fact) => [fact.key, fact.value]));
  return (
    <div
      role="group"
      aria-label={`Control posture: ${style.label}. This is a classification, not a score.`}
      className="flex flex-wrap items-center gap-1.5"
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
          style.activeCellClassName,
        )}
      >
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", style.iconClassName)} />
        {style.label}
      </span>
      {facts.taxonomy ? <span className={SECONDARY_CHIP_CLASS}>{facts.taxonomy}</span> : null}
      {facts.scope ? <span className={SECONDARY_CHIP_CLASS}>{facts.scope}</span> : null}
    </div>
  );
}

export function ControlPostureCard({ view, frameless }: { view?: ControlPostureView | null; frameless?: boolean }) {
  if (!view) return null;

  return <EvidenceRailCard frameless={frameless} title="Control posture" badge={{ label: view.label, className: cn("text-[11px] font-medium", view.badgeClassName) }} evidence={{ topic: "controlPosture" }}>
      <ControlPostureChips view={view} />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Descriptive classification of who holds control; it is not a Safety Score input.
      </p>
      <ModuleDisclosure label="Classification details">
        <div className="space-y-2 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">
          {view.details.map((detail) => <p key={detail}>{detail}</p>)}
        </div>
      </ModuleDisclosure>
    </EvidenceRailCard>;
}
