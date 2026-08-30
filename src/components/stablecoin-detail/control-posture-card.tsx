"use client";

import { Braces, Building2, KeyRound, Landmark, Layers3, UserRound, type LucideIcon } from "lucide-react";
import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import type { ControlPostureView } from "@/lib/control-posture";
import { cn } from "@/lib/utils";
import { CONTROL_POSTURE_ORDER, CONTROL_POSTURE_STYLES } from "@shared/lib/classification";
import type { GovernanceQuality } from "@shared/types";

const CONTROL_POSTURE_ICONS: Record<GovernanceQuality, LucideIcon> = {
  "immutable-code": Braces,
  "dao-governance": Landmark,
  multisig: KeyRound,
  "regulated-entity": Building2,
  "single-entity": UserRound,
  wrapper: Layers3,
};

function ControlPostureMap({ activeKey }: { activeKey: GovernanceQuality }) {
  return (
    <div
      role="group"
      aria-label={`Control posture classification map. ${CONTROL_POSTURE_STYLES[activeKey].label} selected. This is not a score.`}
      className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60"
    >
      {CONTROL_POSTURE_ORDER.map((key) => {
        const style = CONTROL_POSTURE_STYLES[key];
        const Icon = CONTROL_POSTURE_ICONS[key];
        const active = key === activeKey;
        return (
          <div
            key={key}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 bg-card px-1.5 py-2 text-center text-muted-foreground",
              active && style.activeCellClassName,
            )}
          >
            <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", active && style.iconClassName)} />
            <span className="w-full text-[10px] font-medium uppercase leading-tight tracking-[0.06em]">
              {style.stripLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ControlPostureCard({ view, frameless }: { view?: ControlPostureView | null; frameless?: boolean }) {
  if (!view) return null;

  return <EvidenceRailCard frameless={frameless} title="Control posture" badge={{ label: view.label, className: cn("text-[11px] font-medium", view.badgeClassName) }} evidence={{ topic: "controlPosture", showVersion: false }}>
      <ControlPostureMap activeKey={view.key} />
      <FactGrid aria-label="Control posture facts" items={view.facts} className="grid-cols-2" />
      <p className="text-xs leading-relaxed text-muted-foreground">{view.summary}</p>
      <ModuleDisclosure label="Classification details">
        <div className="space-y-2 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">
          {view.details.map((detail) => <p key={detail}>{detail}</p>)}
        </div>
      </ModuleDisclosure>
    </EvidenceRailCard>;
}
