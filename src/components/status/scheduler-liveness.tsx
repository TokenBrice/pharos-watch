import type { SchedulerLiveness } from "@shared/types/status/public-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ComponentStatePill, Timestamp } from "@/components/status/page-primitives";
import { getAgeBandState } from "@/lib/status/public-status";
import { PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER } from "@shared/lib/public-health";
import { getPublicComponentStateRank } from "@shared/lib/public-status-components";
import type { PublicComponentState } from "@shared/types";

/** Reader labels for schedule keys; unknown keys render as-is rather than inventing a name. */
const LANE_LABELS: Record<string, string> = {
  fiveMinuteReserveRecovery: "Reserve recovery",
  fiveMinuteTelegramAlerts: "Telegram alerts",
  digestTriggerPoll: "Digest trigger poll",
  v9SupplyAttributionOffset: "Background computation lane",
};

type LaneBand = PublicComponentState | "unavailable";

interface LaneReading {
  status: SchedulerLiveness["status"];
  ageSeconds?: number | null;
  warningAfterSec: number;
  staleAfterSec: number;
}

/** Grade a lane on the public component bands so this card agrees with the component list. */
function laneBand(lane: LaneReading | undefined): LaneBand {
  if (!lane || lane.status === "unavailable") return "unavailable";
  if (lane.ageSeconds == null) return lane.status === "healthy" ? "operational" : "degraded";
  return getAgeBandState(lane.ageSeconds, lane.warningAfterSec, lane.staleAfterSec);
}

function worstBand(a: LaneBand, b: LaneBand): LaneBand {
  if (a === "unavailable" || b === "unavailable") return "unavailable";
  return getPublicComponentStateRank(a) >= getPublicComponentStateRank(b) ? a : b;
}

function StatusBadge({ band }: { band: LaneBand }) {
  if (band === "unavailable") {
    return (
      <span className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Unavailable
      </span>
    );
  }
  return <ComponentStatePill state={band} />;
}

function LaneLabel({ scheduleKey }: { scheduleKey: string }) {
  return <span title={scheduleKey}>{LANE_LABELS[scheduleKey] ?? scheduleKey}</span>;
}

function budgetText(ageSeconds: number | null | undefined, warningAfterSec: number, staleAfterSec: number): string {
  const age = ageSeconds != null ? `Last start ${formatElapsedSeconds(ageSeconds)} ago. ` : "Last start unavailable. ";
  return `${age}Delayed after ${formatElapsedSeconds(warningAfterSec)}, degraded after ${formatElapsedSeconds(staleAfterSec)}, outage after ${formatElapsedSeconds(staleAfterSec * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER)}.`;
}

export function SchedulerLivenessCard({ observation }: { observation: SchedulerLiveness | undefined }) {
  const publicStatus = observation?.status ?? "unavailable";
  const heavyStatus = observation?.heavy.status ?? "unavailable";
  const publicBand = laneBand(observation);
  const heavyBand = laneBand(observation?.heavy);
  const status = worstBand(publicBand, heavyBand);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Scheduled delivery</CardTitle>
          <StatusBadge band={status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">When scheduled jobs last started, read at request time.</p>
        <dl className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-foreground">Five-minute jobs</dt>
            <dd className="flex items-center gap-2">
              <Timestamp epochSec={observation?.lastFiveMinuteStartedAt} fallback="Unavailable" />
              <StatusBadge band={publicBand} />
            </dd>
          </div>
          <div>
            <dt className="sr-only">Five-minute budget</dt>
            <dd className="pharos-numeric text-xs text-muted-foreground">
              {observation ? budgetText(observation.ageSeconds, observation.warningAfterSec, observation.staleAfterSec) : "Unavailable"}
            </dd>
          </div>
          {observation?.lanes.map((lane) => (
            <div key={lane.scheduleKey} className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground"><LaneLabel scheduleKey={lane.scheduleKey} /></dt>
              <dd><Timestamp epochSec={lane.lastStartedAt} fallback="No start evidence" /></dd>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <dt className="text-muted-foreground">
              {observation?.heavy.scheduleKey ? <LaneLabel scheduleKey={observation.heavy.scheduleKey} /> : "Background computation lane"}
            </dt>
            <dd className="flex items-center gap-2">
              <Timestamp epochSec={observation?.heavy.lastStartedAt} fallback="No start evidence" />
              <StatusBadge band={heavyBand} />
            </dd>
          </div>
          <div>
            <dt className="sr-only">Background computation budget</dt>
            <dd className="pharos-numeric text-xs text-muted-foreground">
              {observation
                ? budgetText(observation.heavy.ageSeconds, observation.heavy.warningAfterSec, observation.heavy.staleAfterSec)
                : "Unavailable"}
            </dd>
          </div>
        </dl>
        {publicStatus === "unavailable" ? (
          <p>Five-minute delivery evidence is unavailable ({observation?.unavailableReason ?? "Observation not supplied"}). This is not a healthy delivery claim.</p>
        ) : null}
        {heavyStatus === "unavailable" ? (
          <p>Background computation evidence is unavailable ({observation?.heavy.unavailableReason ?? "Observation not supplied"}). This is not a healthy delivery claim.</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          One active five-minute job is enough for the public check; a single quiet job is shown for context only. The
          background computation lane is checked on its own budget. These are point-in-time readings, not a full
          delivery history.
        </p>
        <a className="pharos-focus-ring rounded-sm text-sm underline" href="https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/cron-delivery-stall.md" target="_blank" rel="noopener noreferrer">Delivery-stall runbook</a>
      </CardContent>
    </Card>
  );
}
