import type { SchedulerLiveness } from "@shared/types/status/public-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStatusTone } from "@/lib/status-dashboard-model";
import { maxPublicStatus } from "@shared/lib/public-health";

const LANE_LABELS: Record<string, string> = {
  fiveMinuteReserveRecovery: "Reserve recovery",
  fiveMinuteTelegramAlerts: "Telegram alerts",
  digestTriggerPoll: "Digest trigger poll",
};

export function SchedulerLivenessCard({ observation }: { observation: SchedulerLiveness | undefined }) {
  const publicStatus = observation?.status ?? "unavailable";
  const heavyStatus = observation?.heavy.status ?? "unavailable";
  const status = publicStatus === "unavailable" || heavyStatus === "unavailable" ? "unavailable"
    : maxPublicStatus(publicStatus, heavyStatus);
  const tone = getStatusTone(status === "unavailable" ? "degraded" : status);
  const heavyTone = getStatusTone(heavyStatus === "unavailable" ? "degraded" : heavyStatus);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Scheduled delivery</CardTitle>
          <span className={`rounded-full border px-2.5 py-1 text-xs ${tone.badgeClassName}`}>{status}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>Actual slot starts, read live at request time. Completion and scheduled clocks are not delivery evidence.</p>
        <dl className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><dt className="text-muted-foreground">Last five-minute delivery</dt><dd className="font-mono">{observation?.lastFiveMinuteStartedAt != null ? new Date(observation.lastFiveMinuteStartedAt * 1000).toISOString() : "Unavailable"} · {publicStatus}</dd></div>
          <div><dt className="text-muted-foreground">Delivery age / budgets</dt><dd className="font-mono">{observation?.ageSeconds != null ? formatElapsedSeconds(observation.ageSeconds) : "Unavailable"}{observation ? ` · warning >${observation.warningAfterSec}s · stale >${observation.staleAfterSec}s` : ""}</dd></div>
          {observation?.lanes.map((lane) => <div key={lane.scheduleKey}><dt className="text-muted-foreground">{LANE_LABELS[lane.scheduleKey] ?? lane.scheduleKey}</dt><dd className="break-all font-mono">{lane.lastStartedAt != null ? new Date(lane.lastStartedAt * 1000).toISOString() : "No start evidence"}</dd></div>)}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <dt className="text-muted-foreground">Heavy Worker delivery</dt>
            <dd><span className={`rounded-full border px-2.5 py-1 text-xs ${heavyTone.badgeClassName}`}>{heavyStatus}</span></dd>
          </div>
          <div><dt className="text-muted-foreground">{observation?.heavy.scheduleKey ?? "Heavy lane unavailable"}</dt><dd className="break-all font-mono">{observation?.heavy.lastStartedAt != null ? new Date(observation.heavy.lastStartedAt * 1000).toISOString() : "No start evidence"}</dd></div>
          <div><dt className="text-muted-foreground">Heavy delivery age / budgets</dt><dd className="font-mono">{observation?.heavy.ageSeconds != null ? formatElapsedSeconds(observation.heavy.ageSeconds) : "Unavailable"}{observation ? ` · warning >${observation.heavy.warningAfterSec}s · stale >${observation.heavy.staleAfterSec}s` : ""}</dd></div>
        </dl>
        {publicStatus === "unavailable" ? <p>Evidence unavailable: {observation?.unavailableReason ?? "Observation not supplied"}. This is not a healthy delivery claim.</p> : null}
        {heavyStatus === "unavailable" ? <p>Heavy evidence unavailable: {observation?.heavy.unavailableReason ?? "Observation not supplied"}. This is not a healthy heavy delivery claim.</p> : null}
        <p className="text-xs text-muted-foreground">One active five-minute lane satisfies the public aggregate gate; individual silent lanes remain diagnostic. Heavy delivery is assessed independently from its registry-owned lane. History is cron-sampled, not a complete delivery incident ledger.</p>
        <a className="text-sm underline focus-visible:outline focus-visible:outline-2" href="https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/cron-delivery-stall.md" target="_blank" rel="noopener noreferrer">Investigate delivery evidence</a>
      </CardContent>
    </Card>
  );
}
