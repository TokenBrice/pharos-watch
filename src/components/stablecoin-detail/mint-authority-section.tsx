"use client";

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import type {
  MintAuthorityDetailControlViewModel,
  MintAuthorityDetailViewModel,
} from "@/lib/stablecoin-detail-view-model";
import { cn } from "@/lib/utils";

function DetailBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground", className)}
    >
      {children}
    </Badge>
  );
}

function ControlMeta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </span>
  );
}

function MintAuthorityControlRow({ control }: { control: MintAuthorityDetailControlViewModel }) {
  return (
    <li className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{control.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {control.roleLabel} / {control.authorityTypeLabel}
          </p>
        </div>
        <span className="max-w-full truncate rounded-md border border-border/60 bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {control.locationLabel}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        <ControlMeta label="Mint" value={control.directMintAbilityLabel} />
        <ControlMeta label="Safe" value={control.thresholdLabel} />
        <ControlMeta label="Delay" value={control.timelockLabel} />
        <ControlMeta label="Modules" value={control.modulesOrGuardsLabel} />
      </div>
      {control.capDescription ? <p className="mt-2 text-xs text-muted-foreground">{control.capDescription}</p> : null}
    </li>
  );
}

export function MintAuthoritySection({ profile }: { profile?: MintAuthorityDetailViewModel | null }) {
  const isReviewed = profile?.status === "reviewed";

  return (
    <Card id="mint-authority" className="rounded-xl">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DetailSectionTitle>Mint Authority</DetailSectionTitle>
          <DetailBadge className="bg-background/60">descriptive, not scored</DetailBadge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isReviewed ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">
              Mint authority review: <span className="text-muted-foreground">Not reviewed by Pharos</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pharos has not published a mint authority review for this stablecoin yet. Unknown does not mean no
              privileged mint authority.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              <DetailBadge>{profile.mintPathLabel}</DetailBadge>
              <DetailBadge>{profile.authorityPostureLabel}</DetailBadge>
              <DetailBadge>Confidence: {profile.confidenceLabel}</DetailBadge>
              {profile.inheritedFrom ? <DetailBadge>Inherited from {profile.inheritedFrom}</DetailBadge> : null}
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>

            {profile.controls.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Primary controls
                </p>
                <ul className="space-y-2">
                  {profile.controls.map((control) => (
                    <MintAuthorityControlRow key={control.key} control={control} />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No primary control rows are published in the compact review summary.
              </div>
            )}

            {profile.sources.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Evidence sources
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                  {profile.sources.map((source) => (
                    <a
                      key={`${source.label}:${source.url}`}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                    >
                      {source.label}
                      <ExternalLink aria-hidden className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
