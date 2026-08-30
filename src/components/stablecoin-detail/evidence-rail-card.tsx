import type * as React from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { RailCard } from "@/components/stablecoin-detail/rail-card";

export interface EvidenceRailCardProps {
  title: string;
  ariaLabel?: string;
  frameless?: boolean;
  anchorTwin?: string;
  badge?: { label: string; className: string };
  evidence: React.ComponentProps<typeof EvidenceFooter>;
  children: ReactNode;
}

export function EvidenceRailCard({
  title, ariaLabel = title, frameless, anchorTwin, badge, evidence, children,
}: EvidenceRailCardProps) {
  return (
    <RailCard
      frameless={frameless}
      title={title}
      ariaLabel={ariaLabel}
      anchorTwin={anchorTwin}
      trailing={badge ? <Badge variant="outline" className={badge.className}>{badge.label}</Badge> : undefined}
    >
      <div className="space-y-3 px-4 pb-4">
        {children}
        <EvidenceFooter {...evidence} />
      </div>
    </RailCard>
  );
}
