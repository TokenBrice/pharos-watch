"use client";

import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { TELEGRAM_METRIC_SEMANTICS, pluralizeCount } from "@shared/lib/telegram-metrics";
import type { HealthResponse } from "@shared/types";
import { StatusSection, StatusSummaryBadge } from "@/components/status/page-primitives";
import { PublicSignalCard } from "@/components/status/public-signal-card";
import {
  getImpactedPublicSurfaces,
  getPublicMintBurnStatus,
} from "@/lib/status/public-status";
import { formatTimestampSeconds } from "@/lib/status-dashboard-model";

interface PublicServiceSummarySectionProps {
  healthData: HealthResponse;
}

export function PublicServiceSummarySection({
  healthData,
}: PublicServiceSummarySectionProps) {
  const mintBurnStatus = getPublicMintBurnStatus(healthData.mintBurn.sync);
  const blacklistStatus = getBlacklistGapStatus({
    missingRatio: healthData.blacklist.missingRatio,
    recentMissingAmounts: healthData.blacklist.recentMissingAmounts,
  });
  const blacklistWindowHours = Math.max(1, Math.round(healthData.blacklist.recentWindowSec / 3600));
  const telegramSummary = healthData.telegramSummary ?? null;
  const impactedPublicSurfaces = getImpactedPublicSurfaces(healthData);

  return (
    <StatusSection
      id="overview"
      kicker="Service Health"
      title="Public service summary"
      summary={
        <>
          <StatusSummaryBadge label="Status" status={healthData.status} />
          {blacklistStatus !== "healthy" && (
            <StatusSummaryBadge
              label="Blacklist Gaps"
              value={String(healthData.blacklist.missingAmounts)}
              status={blacklistStatus}
            />
          )}
          {healthData.mintBurn.majorStaleCount > 0 && (
            <StatusSummaryBadge
              label="Major Mint/Burn Stale"
              value={String(healthData.mintBurn.majorStaleCount)}
              status="degraded"
            />
          )}
          {telegramSummary && (telegramSummary.pendingDeliveries ?? 0) > 0 && (
            <StatusSummaryBadge
              label="Alert Queue"
              value={String(telegramSummary.pendingDeliveries)}
              status="degraded"
            />
          )}
          {telegramSummary?.safetyAlertsSuppressed && (
            <StatusSummaryBadge
              label="Safety Alerts"
              value={telegramSummary.safetyAlertSourceState ?? "suppressed"}
              status="degraded"
            />
          )}
        </>
      }
    >
      <div className="grid gap-5 xl:grid-cols-2">
        <PublicSignalCard
          title="Mint/Burn Sync"
          badges={
            mintBurnStatus !== "healthy" || healthData.mintBurn.majorStaleCount > 0 ? (
              <div className="flex flex-wrap gap-2">
                {mintBurnStatus !== "healthy" && (
                  <StatusSummaryBadge label="Writer" value={mintBurnStatus} status={mintBurnStatus} />
                )}
                {healthData.mintBurn.majorStaleCount > 0 && (
                  <StatusSummaryBadge
                    label="Major Stale"
                    value={String(healthData.mintBurn.majorStaleCount)}
                    status="degraded"
                  />
                )}
              </div>
            ) : undefined
          }
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            {healthData.mintBurn.sync.warning
              ?? "Critical mint/burn lanes are within their expected freshness and run-health windows."}
          </p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="border-t border-border/60 pt-3">
              <div className="pharos-kicker">Last Successful Sync</div>
              <div className="mt-1.5 pharos-numeric text-sm text-foreground">
                {formatTimestampSeconds(healthData.mintBurn.sync.lastSuccessfulSyncAt)}
              </div>
            </div>
            {healthData.mintBurn.latestHourlyTs != null ? (
              <div className="border-t border-border/60 pt-3">
                <div className="pharos-kicker">Latest Hourly Rollup</div>
                <div className="mt-1.5 pharos-numeric text-sm text-foreground">
                  {formatTimestampSeconds(healthData.mintBurn.latestHourlyTs)}
                </div>
              </div>
            ) : null}
          </div>
          {healthData.mintBurn.staleMajorSymbols.length > 0 ? (
            <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              Impacted majors: {healthData.mintBurn.staleMajorSymbols.join(", ")}
            </div>
          ) : null}
        </PublicSignalCard>

        <PublicSignalCard
          title="Blacklist Ingestion"
          badges={
            blacklistStatus !== "healthy" ? (
              <div className="flex flex-wrap gap-2">
                <StatusSummaryBadge
                  label="Missing Amounts"
                  value={String(healthData.blacklist.missingAmounts)}
                  status={blacklistStatus}
                />
              </div>
            ) : undefined
          }
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            Missing blacklist amounts surface here because they directly affect public data quality and downstream risk calculations.
          </p>
          <div className="border-t border-border/60 pt-3">
            <div className="pharos-kicker">Public Health Interpretation</div>
            <div className="mt-1.5 leading-relaxed text-foreground">
              {healthData.blacklist.missingAmounts > 0
                ? blacklistStatus === "healthy"
                  ? `${healthData.blacklist.missingAmounts} blacklist event(s) are still missing amounts, but they are below the public warning threshold${healthData.blacklist.recentMissingAmounts > 0 ? ` (${healthData.blacklist.recentMissingAmounts} recent in the last ${blacklistWindowHours}h)` : ""}.`
                  : healthData.blacklist.recentMissingAmounts > 0
                    ? `${healthData.blacklist.recentMissingAmounts} recent blacklist event(s) in the last ${blacklistWindowHours}h are still missing amounts.`
                    : `${healthData.blacklist.missingAmounts} blacklist event(s) are still missing amounts, but no new gaps were recorded in the last ${blacklistWindowHours}h.`
                : "No current blacklist amount gaps are affecting the public health signal."}
            </div>
            {healthData.blacklist.missingAmounts > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Missing ratio {(healthData.blacklist.missingRatio * 100).toFixed(2)}% of {healthData.blacklist.totalEvents} tracked events.
              </div>
            ) : null}
          </div>
        </PublicSignalCard>
      </div>

      {telegramSummary && (
        <PublicSignalCard
          title="Telegram Bot Health"
          badges={
            (telegramSummary.pendingDeliveries ?? 0) > 0
            || telegramSummary.safetyAlertsSuppressed
            || (telegramSummary.lastDispatchStatus && telegramSummary.lastDispatchStatus !== "ok") ? (
              <div className="flex flex-wrap gap-2">
                {(telegramSummary.pendingDeliveries ?? 0) > 0 && (
                  <StatusSummaryBadge
                    label="Pending"
                    value={String(telegramSummary.pendingDeliveries)}
                    status="degraded"
                  />
                )}
                {telegramSummary.safetyAlertsSuppressed && (
                  <StatusSummaryBadge
                    label="Safety Alerts"
                    value={telegramSummary.safetyAlertSourceState ?? "suppressed"}
                    status="degraded"
                  />
                )}
                {telegramSummary.lastDispatchStatus && telegramSummary.lastDispatchStatus !== "ok" && (
                  <StatusSummaryBadge
                    label="Last Dispatch"
                    value={telegramSummary.lastDispatchStatus}
                    status="stale"
                  />
                )}
              </div>
            ) : undefined
          }
        >
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="border-t border-border/60 pt-3">
              <div className="pharos-kicker" title={TELEGRAM_METRIC_SEMANTICS.registeredChats.description}>
                {TELEGRAM_METRIC_SEMANTICS.registeredChats.label}
              </div>
              <div className="mt-1.5 pharos-numeric text-sm text-foreground">
                {telegramSummary.totalChats} {pluralizeCount(telegramSummary.totalChats, "chat")} registered
              </div>
            </div>
            <div className="border-t border-border/60 pt-3">
              <div className="pharos-kicker">Last Dispatch</div>
              <div className="mt-1.5 pharos-numeric text-sm text-foreground">
                {telegramSummary.lastDispatchAt
                  ? formatTimestampSeconds(telegramSummary.lastDispatchAt)
                  : "No dispatch recorded"}
              </div>
            </div>
          </div>
          {(telegramSummary.pendingDeliveries ?? 0) > 0 && (
            <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {telegramSummary.pendingDeliveries} {pluralizeCount(telegramSummary.pendingDeliveries ?? 0, "alert")} pending delivery
            </div>
          )}
          {telegramSummary.safetyAlertsSuppressed && (
            <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              Safety alerts are paused because the live report-card source is {telegramSummary.safetyAlertSourceState ?? "unavailable"}
              {telegramSummary.safetyAlertSourceAgeSeconds != null
                ? ` (${telegramSummary.safetyAlertSourceAgeSeconds}s old)`
                : ""}.
            </div>
          )}
        </PublicSignalCard>
      )}

      <PublicSignalCard
        title="Impacted public surfaces"
        badges={
          impactedPublicSurfaces.length > 0 ? (
            <StatusSummaryBadge
              label="Impacted Surfaces"
              value={String(impactedPublicSurfaces.length)}
              status="degraded"
            />
          ) : undefined
        }
      >
        {impactedPublicSurfaces.length > 0 ? (
          <div className="grid gap-x-6 gap-y-3 lg:grid-cols-2">
            {impactedPublicSurfaces.map((surface) => (
              <div key={surface.id} className="border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">{surface.title}</div>
                  <StatusSummaryBadge label="Impact" value={surface.tone} status={surface.tone} />
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{surface.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="border-t border-border/60 pt-3 text-sm leading-relaxed text-muted-foreground">
            No current public surface impact flags are active beyond the hero summary.
          </div>
        )}
      </PublicSignalCard>
    </StatusSection>
  );
}
