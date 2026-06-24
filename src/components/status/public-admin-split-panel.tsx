import type { HealthResponse, StatusResponse } from "@shared/types";
import { PublicSignalCard } from "@/components/status/public-signal-card";
import { SummaryBadge } from "@/components/status/page-primitives";
import { getImpactedPublicSurfaces } from "@/lib/status/public-status";
import { getStatusTone } from "@/lib/status-dashboard-model";

interface PublicAdminSplitPanelProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  browserProbeSummary: {
    sampleCount: number;
    passCount: number;
    failCount: number;
    status: "healthy" | "degraded" | "stale";
  } | null;
}

export function PublicAdminSplitPanel({ data, healthData, browserProbeSummary }: PublicAdminSplitPanelProps) {
  const publicImpacts = healthData ? getImpactedPublicSurfaces(healthData) : [];
  const adminBlockers = [...data.causes.overall, ...data.causes.availability, ...data.causes.dataQuality].filter(
    (cause) => cause.severity !== "info",
  );
  const publicTone = getStatusTone(healthData?.status ?? "healthy");
  const adminTone = getStatusTone(data.overallStatus);
  const userVisibleSummary =
    healthData == null
      ? "Public health has not loaded in this browser session."
      : publicImpacts.length > 0
        ? `${publicImpacts.length} public surface${publicImpacts.length === 1 ? "" : "s"} may be visibly affected.`
        : "No public health surface is currently reporting user-visible impact.";

  return (
    <PublicSignalCard
      variant="panel"
      title="Public vs operator impact"
      description="Separates what users can feel from what the operator dashboard is still watching."
      badges={
        <>
          <SummaryBadge
            label="Public"
            value={healthData?.status ?? "—"}
            className={healthData ? publicTone.badgeClassName : undefined}
          />
          <SummaryBadge label="Admin" value={adminTone.label} className={adminTone.badgeClassName} />
          <SummaryBadge label="Admin blockers" value={String(adminBlockers.length)} />
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-background/45 p-3">
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">User-visible</div>
          <p className="mt-1 text-sm leading-relaxed text-foreground">{userVisibleSummary}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/45 p-3">
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Operator state</div>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {data.overallStatus === "healthy"
              ? "Admin state is healthy."
              : `${adminTone.label}: ${adminBlockers.length} blocker${adminBlockers.length === 1 ? "" : "s"} and ${data.summary.degradedCrons} degraded cron lane${data.summary.degradedCrons === 1 ? "" : "s"}.`}
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/45 p-3">
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Browser probes</div>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {browserProbeSummary
              ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount} passing; ${browserProbeSummary.failCount} failing from this session.`
              : "No browser probe sample is loaded yet."}
          </p>
        </div>
      </div>
    </PublicSignalCard>
  );
}
