import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { formatElapsedSeconds } from "@shared/lib/format";
import { hasReserveScoreInputHold } from "@shared/lib/status-thresholds";
import { getStatusTone } from "@/lib/status-dashboard-model";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { CountValue, Timestamp } from "@/components/status/page-primitives";

interface ReserveSyncHealthCardProps {
  health: StatusResponse["reserveComposition"];
  nowSeconds: number;
}

function CountTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <CountValue value={value} tone={tone} className="block font-mono text-lg" />
    </div>
  );
}

function formatPersistentStaleIndependentFeeds(
  coins: NonNullable<StatusResponse["reserveComposition"]["persistentlyStaleIndependentCoins"]>,
): string {
  const examples = coins
    .slice(0, 3)
    .map((coin) => coin.stablecoinId)
    .join(", ");
  const suffix = coins.length > 3 ? `, +${coins.length - 3} more` : "";
  return examples ? `${coins.length} (${examples}${suffix})` : String(coins.length);
}

function formatRatioPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ReserveSyncHealthCard({ health, nowSeconds }: ReserveSyncHealthCardProps) {
  if (health.status === "unavailable") {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h3" className="text-base">Live reserve sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="font-medium text-muted-foreground">Unavailable</div>
          <p>Reserve composition could not be read. Cohort size, coverage, and sync health are unknown.</p>
          <div className="font-mono text-xs text-muted-foreground">{health.reason}</div>
        </CardContent>
      </Card>
    );
  }
  // One definition of the healthy/degraded/stale badge palette: this used to be
  // a byte-identical re-implementation of `STATUS_TONE[...].badgeClassName`.
  const statusTone = getStatusTone(health.status).badgeClassName;
  const scoreInputHold = hasReserveScoreInputHold(health);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">Live reserve sync</CardTitle>
          <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", statusTone)}>
            {health.status}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {scoreInputHold ? (
          <div className={cn("rounded-lg border p-3 text-xs leading-relaxed text-state-warn-strong", SEVERITY_TONE_CLASS.watch.banner)}>
            <div className="text-sm font-medium text-state-warn-ink">
              Report-card inputs are conservative
            </div>
            <p className="mt-1">
              Safety scoring only trusts score-grade reserve evidence. While this lane is degraded or deferred, affected
              report cards can show lower reserve scores until a clean run completes.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
              <span>{formatRatioPct(health.freshCoverageRatio)} fresh</span>
              <span>{formatRatioPct(health.authoritativeFreshCoverageRatio)} score-grade</span>
              {health.deferredCoins > 0 ? <span>{health.deferredCoins} deferred</span> : null}
              {health.nextCursorStablecoinId ? <span>resume {health.nextCursorStablecoinId}</span> : null}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-8">
          <CountTile label="Configured" value={health.configuredCoins} />
          <CountTile label="Fresh" value={health.freshCoins} tone="text-state-positive" />
          <CountTile label="Error" value={health.errorCoins} tone="text-state-danger" />
          <CountTile label="Corrupt" value={health.corruptCoins} tone="text-state-danger" />
          <CountTile label="Degraded" value={health.degradedCoins} tone="text-state-warn" />
          <CountTile label="Stale" value={health.staleCoins} tone="text-state-warn" />
          <CountTile label="Missing" value={health.missingCoins} tone="text-state-danger" />
          <CountTile label="Deferred" value={health.deferredCoins} tone="text-state-warn" />
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            Last success:{" "}
            <Timestamp epochSec={health.lastSuccessAt} nowSec={nowSeconds} fallback="no successful live sync yet" />
          </div>
          <div>
            Oldest fresh snapshot age:{" "}
            {health.oldestFreshAgeSec != null ? formatElapsedSeconds(health.oldestFreshAgeSec) : "—"}
          </div>
          <div>
            Health-cohort coverage: {formatRatioPct(health.freshCoverageRatio)} fresh,{" "}
            {formatRatioPct(health.authoritativeFreshCoverageRatio)} authoritative
          </div>
          <div>Raw evidence coverage: {formatRatioPct(health.configuredCoins > 0 ? health.freshCoins / health.configuredCoins : 0)} fresh across {health.configuredCoins} configured feeds.</div>
          <div>Health cohort: {health.healthConfiguredCoins ?? health.configuredCoins} feeds; {health.acknowledgedFeedIds?.length ?? 0} reviewed exclusions. Exclusions do not admit evidence for scoring.</div>
          {health.expiredFeedReviewIds?.length ? <div>Expired reviews (gates re-armed): {health.expiredFeedReviewIds.join(", ")}</div> : null}
          {health.invalidFeedReviewIds?.length ? <div>Invalid reviews (gates re-armed): {health.invalidFeedReviewIds.join(", ")}</div> : null}
          {health.acknowledgedFeeds?.length ? (
            <details>
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md">
                Notes: {health.acknowledgedFeeds.length} reviewed exclusion {health.acknowledgedFeeds.length === 1 ? "note" : "notes"}
              </summary>
              <ul className="mt-1 space-y-2 border-l-2 border-border/60 pl-3">
                {health.acknowledgedFeeds.map((review) => (
                  <li key={review.stablecoinId}>
                    <span className="font-mono text-foreground">{review.stablecoinId}</span>: {review.reason} Review expires{" "}
                    {new Date(review.expiresAt * 1000).toISOString().slice(0, 10)}.
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {health.nextCursorStablecoinId && <div>Next deferred cursor: {health.nextCursorStablecoinId}</div>}
          <div>
            Queue pressure:{" "}
            {health.runBudgetTruncated
              ? (
                <>
                  run budget truncated
                  {health.deferredAt ? (
                    <>
                      {" "}
                      <Timestamp epochSec={health.deferredAt} nowSec={nowSeconds} />
                    </>
                  ) : null}
                </>
              )
              : "run budget clear"}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-xs font-medium text-foreground">Fresh Evidence Mix</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div>
              <div className="text-muted-foreground">Independent eligible</div>
              <CountValue value={health.independentFreshEligible} tone="text-state-positive" className="block font-mono text-base" />
            </div>
            <div>
              <div className="text-muted-foreground">Independent unverified</div>
              <CountValue value={health.independentFreshUnverified} tone="text-state-warn" className="block font-mono text-base" />
            </div>
            <div>
              <div className="text-muted-foreground">Static validated</div>
              <CountValue value={health.staticValidatedFresh} className="block font-mono text-base" />
            </div>
            <div>
              <div className="text-muted-foreground">Weak probe</div>
              <CountValue value={health.weakProbeFresh} className="block font-mono text-base" />
            </div>
            <div>
              <div className="text-muted-foreground">Write-timeout uncertain</div>
              <CountValue value={health.writeTimeoutUncertain} tone="text-state-danger" className="block font-mono text-base" />
            </div>
          </div>
          {health.persistentlyStaleIndependentCoins.length > 0 ? (
            <div className="text-xs text-state-warn-bright">
              Persistently stale independent feeds:{" "}
              {formatPersistentStaleIndependentFeeds(health.persistentlyStaleIndependentCoins)}
            </div>
          ) : null}
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-xs font-medium text-foreground">30-day Adapter Reliability</div>
          {health.adapterReliabilityAvailability?.status === "unavailable" ? (
            <div className="space-y-1 text-xs">
              <div className="font-medium text-muted-foreground">Unavailable</div>
              <p>Adapter reliability history could not be read; attempt counts are unknown.</p>
              <div className="font-mono text-muted-foreground">{health.adapterReliabilityAvailability.reason}</div>
            </div>
          ) : health.adapterReliability.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              {health.adapterReliabilityAvailability == null
                ? "Unknown: this payload does not report whether reliability history was read."
                : health.configuredCoins === 0
                  ? "No live reserve adapters are configured."
                  : "No adapter attempts recorded in the last 30 days."}
            </div>
          ) : (
            <TableFrame
              tableId="reserve-adapter-reliability"
              chrome="content"
              density="compact"
              tableProps={{ "aria-label": "30-day adapter reliability" }}
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Adapter</TableHead>
                  <TableHead scope="col" className="text-right">Attempts</TableHead>
                  <TableHead scope="col" className="text-right">OK</TableHead>
                  <TableHead scope="col" className="text-right">Degr.</TableHead>
                  <TableHead scope="col" className="text-right" title="Degraded only by structural warnings (counted as success)">By design</TableHead>
                  <TableHead scope="col" className="text-right">Error</TableHead>
                  <TableHead scope="col" className="text-right">Skip</TableHead>
                  <TableHead scope="col" className="text-right">Success</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.adapterReliability.map((row) => (
                  <TableRow key={row.adapterKey}>
                    <TableCell className="font-mono">{row.adapterKey}</TableCell>
                    <TableCell className="text-right font-mono">{row.attempts}</TableCell>
                    <TableCell className="text-right font-mono"><CountValue value={row.ok} /></TableCell>
                    <TableCell className="text-right font-mono"><CountValue value={row.degraded} tone="text-state-warn" /></TableCell>
                    <TableCell className="text-right font-mono">
                      {row.degradedByDesign != null ? <CountValue value={row.degradedByDesign} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono"><CountValue value={row.error} tone="text-state-danger" /></TableCell>
                    <TableCell className="text-right font-mono"><CountValue value={row.skipped} /></TableCell>
                    <TableCell className="text-right font-mono">
                      {row.successRate != null ? formatRatioPct(row.successRate) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
