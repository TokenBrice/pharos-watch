"use client";

import Link from "next/link";
import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatElapsedSeconds } from "@shared/lib/format";
import { OPERATOR_VERDICT_TONE } from "@shared/lib/classification";
import type { StatusCause } from "@shared/types";
import { ResourcePressureSchema } from "@shared/types/status/cron";
import { CronInFlightProgress } from "@/components/status/cron-in-flight-progress";
import { summarizeCronMetadata } from "@/components/status/cron-metadata-summary";
import { VerdictPill } from "@/components/status/page-primitives";
import { copyText } from "@/lib/clipboard";
import { useStatusCronDetail } from "@/hooks/admin-api-hooks";
import {
  formatCronRunTiming,
  getCronCauses,
  getCronNextExpected,
  getCronRunbooks,
  getCronTailCommand,
  type CronWorkbenchRow,
} from "@/lib/cron-workbench-model";
import { getActionsForCronJob, getRecommendedActionsForCause } from "@/lib/status/action-recommendations";
import { CRON_DETAIL_ID, formatLastGood, formatTimestamp } from "./cron-lane-format";
import { CronRunHistoryPanel, StaleArtifactEvidence } from "./cron-run-history";

function ResourcePressureEvidence({
  metadata,
  label,
  attempt,
  readError,
}: {
  metadata: Record<string, unknown> | undefined;
  label: string;
  attempt: string;
  readError?: string;
}) {
  const parsed = ResourcePressureSchema.safeParse(metadata?.resourcePressure);
  if (readError || !parsed.success) {
    return (
      <section aria-label={label} className="mt-4 border-t border-border/55 pt-3 text-xs">
        <h4 className="font-medium text-foreground">{label}</h4>
        <p className="mt-2 text-muted-foreground">
          Resource evidence unavailable for {attempt}: {readError ?? "missing or invalid resource block"}.
        </p>
      </section>
    );
  }
  const pressure = parsed.data;
  const bytes = (value: number | null) => value == null ? "Unavailable" : `${value.toLocaleString()} bytes`;
  const evidence = [
    ["Phase / observed", `${pressure.phase} · ${formatTimestamp(pressure.observedAt)}`],
    ["Body / cache / entry caps", `${bytes(pressure.bodyCapBytes)} / ${bytes(pressure.cacheCapBytes)} / ${bytes(pressure.cacheEntryCapBytes)}`],
    ["Concurrent decodes", pressure.maxConcurrentDecodes ?? "Unavailable"],
    ["Input / catalog admission", `${bytes(pressure.inputCapBytes)} / ${pressure.catalogMaxAssets ?? "Unavailable"} assets`],
    ["Intake", `${bytes(pressure.intakeBytes)} · ${pressure.intakeBasis}`],
    ["Estimated cache retention", `${bytes(pressure.cacheBytes)} · ${pressure.cacheBasis}`],
    ["Input / catalog measured", `${bytes(pressure.inputBytes)} / ${pressure.catalogAssets ?? "Unavailable"} assets`],
    ["Rejected bodies", pressure.rejectedBodies ?? "Unavailable"],
    ["Guard", pressure.guard],
    ["Platform evidence", pressure.platformOutcome == null ? "Unavailable (not inferred)" : `${pressure.platformOutcome} · ${pressure.platformOutcomeSource}`],
    ["Heap unavailable", pressure.heapUnavailableReason],
  ] as const;
  return (
    <section aria-label={label} className="mt-4 border-t border-border/55 pt-3 text-xs">
      <h4 className="font-medium text-foreground">{label}</h4>
      <dl className="mt-2 space-y-2">
        {evidence.map(([term, value]) => (
          <div key={term} className="min-w-0">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="mt-0.5 break-words font-mono tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CopyTailCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground" title={command}>
          {command}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => setCopied((await copyText(command)).ok ? "copied" : "failed")}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </Button>
      </div>
      <span role="status" className="text-xs text-muted-foreground">
        {copied === "copied" ? "Copied." : copied === "failed" ? "Copy failed; select the command instead." : ""}
      </span>
    </div>
  );
}

function getCronActions(row: CronWorkbenchRow, causes: readonly StatusCause[]) {
  const fromCauses = getCronCauses(row.job, causes).flatMap((cause) => getRecommendedActionsForCause(cause));
  const fromCron = getActionsForCronJob(row.job);
  return [...new Map([...fromCauses, ...fromCron].map((action) => [action.path, action])).values()];
}

export function CronDetailPanel({
  row,
  causes = [],
  nowSeconds,
  detailEnabled,
}: {
  row: CronWorkbenchRow;
  causes?: readonly StatusCause[];
  nowSeconds: number;
  detailEnabled: boolean;
}) {
  const lastRun = row.cron.runs[0];
  const lastRunTiming = lastRun ? formatCronRunTiming(lastRun) : null;
  // Full run/progress metadata is fetched for the opened job only.
  const detailQuery = useStatusCronDetail(row.job, { enabled: detailEnabled });
  const detail = detailEnabled && detailQuery.data?.job === row.job ? detailQuery.data : undefined;
  const detailLatestRun = detail?.cron.telemetryUnknown ? undefined : detail?.cron.runs[0];
  const detailInFlight = detail?.sectionErrors.cronProgress || detail?.sectionErrors.cronLeases
    ? null
    : detail?.cron.inFlight ?? null;
  const detailErrors = detail ? Object.values(detail.sectionErrors) : [];
  const metadataSummary = summarizeCronMetadata(row.job, detailLatestRun?.metadata, lastRun?.degradedReason);
  const next = getCronNextExpected(row.cron, nowSeconds, row.job);
  const jobCauses = getCronCauses(row.job, causes);
  const runbooks = getCronRunbooks(row, causes);
  const actions = getCronActions(row, causes);
  const historyHref = jobCauses[0] ? `/admin/history/?cause=${encodeURIComponent(jobCauses[0].code)}` : "/admin/history/";

  return (
    <aside
      id={CRON_DETAIL_ID}
      aria-label={`Details for ${row.display.label}`}
      className="min-w-0 scroll-mt-[var(--ops-sticky-offset)] rounded-xl border border-border/60 bg-background/45 p-4 2xl:sticky 2xl:top-[calc(var(--ops-sticky-offset)+0.75rem)] 2xl:max-h-[calc(100vh-var(--ops-sticky-offset)-1.5rem)] 2xl:self-start 2xl:overflow-y-auto 2xl:overscroll-contain"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-foreground">{row.display.label}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.job}</p>
        </div>
        <VerdictPill verdict={row.verdict} />
      </div>

      <section aria-label="Why this state" className="mt-4 space-y-1.5 text-xs">
        <h4 className="font-semibold text-foreground">Why this state</h4>
        <p className={cn("text-sm", row.verdict === "ok" ? "text-foreground" : OPERATOR_VERDICT_TONE[row.verdict].text)}>
          {row.verdictReason.sentence}
        </p>
        <p className="text-muted-foreground">
          Reason <code className="font-mono text-foreground">{row.verdictReason.code}</code> · raw status{" "}
          <code className="font-mono text-foreground">{row.rawStatus ?? "none"}</code>
        </p>
        <p className="text-muted-foreground">{next.budget} Next opportunity: {next.label}.</p>
        <p className="text-muted-foreground">
          {row.impactLabel} · {row.group.title} · {row.display.triggerMode === "isolated" ? "isolated" : "shared"} trigger
          {row.display.schedule ? (
            <>
              {" "}· <code className="font-mono">{row.display.schedule}</code>
            </>
          ) : null}
        </p>
        <p className="text-muted-foreground">Last success: {formatLastGood(row, nowSeconds)}</p>
        {lastRunTiming?.note ? <p className="text-muted-foreground">{lastRunTiming.note}</p> : null}
        {jobCauses.map((cause) => (
          <p key={cause.code} className="text-muted-foreground">
            Status cause <code className="font-mono text-foreground">{cause.code}</code>: {cause.message}
          </p>
        ))}
      </section>

      <section aria-label="Actions" className="mt-4 space-y-2 border-t border-border/55 pt-3 text-xs">
        <h4 className="font-semibold text-foreground">Actions</h4>
        <ul className="space-y-1.5">
          {runbooks.map((runbook) => (
            <li key={runbook.href}>
              <a
                href={runbook.href}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-2"
              >
                {runbook.label}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </li>
          ))}
          {actions.map((action) => (
            <li key={action.path}>
              <Link href="/admin/actions/" className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-2">
                {action.label}
              </Link>{" "}
              <span className="text-muted-foreground">in Actions ({action.risk})</span>
            </li>
          ))}
          <li>
            <Link href={historyHref} className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-2">
              View status history
            </Link>
          </li>
        </ul>
        <CopyTailCommand command={getCronTailCommand(row.job)} />
      </section>

      {row.cron.inFlight ? (
        <section
          className={cn(
            "mt-4 rounded-md border p-3 text-xs",
            row.cron.inFlight.stale
              ? "border-state-danger-solid/25 bg-state-danger-solid/5 text-state-danger-strong"
              : "border-state-info-solid/25 bg-state-info-solid/5 text-state-info-strong",
          )}
          aria-label={row.cron.inFlight.stale ? "Stale running progress" : "Current running progress"}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{row.cron.inFlight.stale ? "Stale heartbeat" : "Running now"}</span>
            <span>started {formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.inFlight.startedAt))} ago</span>
            <span>heartbeat {formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.inFlight.updatedAt))} ago</span>
          </div>
          <dl className="mt-2 grid min-w-0 grid-cols-2 gap-2">
            <div className="min-w-0">
              <dt>Stage</dt>
              <dd className="break-all font-mono font-medium">{row.cron.inFlight.stage ?? "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt>Lease owner</dt>
              <dd className="break-all font-mono font-medium">{row.cron.inFlight.leaseOwner ?? "Unknown"}</dd>
            </div>
          </dl>
          {row.cron.inFlight.itemsDone != null && row.cron.inFlight.itemsTotal != null ? (
            <div className="mt-2">
              <CronInFlightProgress
                itemsDone={row.cron.inFlight.itemsDone}
                itemsTotal={row.cron.inFlight.itemsTotal}
                stale={row.cron.inFlight.stale}
              />
            </div>
          ) : null}
          {row.cron.inFlight.message ? <div className="mt-2 break-words">{row.cron.inFlight.message}</div> : null}
          {detailInFlight?.metadata && Object.keys(detailInFlight.metadata).length > 0 ? (
            <details className="mt-3 text-xs">
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md">
                Full progress metadata
              </summary>
              <pre className="mt-2 max-h-40 max-w-full overflow-auto rounded-md bg-background/60 p-2 text-xs text-foreground">
                {JSON.stringify(detailInFlight.metadata, null, 2)}
              </pre>
            </details>
          ) : null}
        </section>
      ) : null}

      <StaleArtifactEvidence artifacts={row.cron.staleArtifacts ?? []} />

      {row.cron.confirmedOutputAt != null ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Last confirmed output {formatElapsedSeconds(Math.max(0, nowSeconds - row.cron.confirmedOutputAt))} ago
          ({formatTimestamp(row.cron.confirmedOutputAt)}).
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          No confirmed output in the bounded history read; this is not proof the job never published.
        </p>
      )}

      {(detailLatestRun?.error ?? lastRun?.error) ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-state-danger-strong">
            Latest run error
          </summary>
          <pre className="mt-2 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
            {detailLatestRun?.error ?? lastRun?.error}
          </pre>
        </details>
      ) : null}

      {metadataSummary.length > 0 ? (
        <div className="mt-4 border-y border-border/55 py-3 text-xs text-muted-foreground">
          {metadataSummary.map((line) => (
            <div key={line} className="break-words">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {!detailEnabled ? (
        <p className="mt-4 border-t border-border/55 pt-3 text-xs text-muted-foreground">
          Select this job to load run history, metadata and resource evidence. Resource evidence not requested.
        </p>
      ) : detailQuery.isError && !detail ? (
        <p role="alert" className="mt-4 border-t border-border/55 pt-3 text-xs text-state-danger-strong">
          Job detail unavailable: {detailQuery.error.message}. Run history, metadata and resource evidence are unavailable.
        </p>
      ) : !detail ? (
        <p role="status" className="mt-4 border-t border-border/55 pt-3 text-xs text-muted-foreground">
          Loading run history and metadata… Resource evidence is loading.
        </p>
      ) : (
        <>
          {detailQuery.isError ? (
            <p role="alert" className="mt-4 text-xs text-state-warn-strong">
              Job detail refresh unavailable: {detailQuery.error.message}. Retained run history, metadata and resource evidence are shown.
            </p>
          ) : null}
          {detailErrors.map((error) => (
            <p key={error.code} role="alert" className="mt-4 text-xs text-state-warn-strong">{error.message}</p>
          ))}
          <CronRunHistoryPanel runs={detail.cron.runs} />
        </>
      )}

      {detail ? (
        <>
          {detailInFlight || row.cron.inFlight || detail.sectionErrors.cronProgress || detail.sectionErrors.cronLeases ? (
            <ResourcePressureEvidence
              metadata={detailInFlight?.metadata}
              label="Current progress resource evidence"
              attempt={detailInFlight ? `current attempt started ${formatTimestamp(detailInFlight.startedAt)}` : "the current attempt"}
              readError={detail.sectionErrors.cronProgress?.message ?? detail.sectionErrors.cronLeases?.message}
            />
          ) : null}
          <ResourcePressureEvidence
            metadata={detailLatestRun?.metadata}
            label="Last terminal resource evidence"
            attempt={detailLatestRun ? `terminal attempt started ${formatTimestamp(detailLatestRun.startedAt)}` : "the last terminal attempt in the bounded detail read"}
            readError={detail.cron.telemetryUnknown ? detail.cron.telemetryUnknownReason ?? "cron history read failed" : undefined}
          />
        </>
      ) : null}

      {detailLatestRun?.metadata && Object.keys(detailLatestRun.metadata).length > 0 ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
            Full run metadata
          </summary>
          <pre className="mt-2 max-h-56 max-w-full overflow-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(detailLatestRun.metadata, null, 2)}
          </pre>
        </details>
      ) : null}

      {row.cron.latestEvent ? (
        <details className="mt-4 text-xs">
          <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-muted-foreground">
            Latest cron event
          </summary>
          <div className="mt-2 min-w-0 border-y border-border/55 py-2">
            <div className="font-medium text-foreground">{row.cron.latestEvent.message}</div>
            <div className="mt-1 break-all font-mono text-muted-foreground">
              {row.cron.latestEvent.eventType} · {row.cron.latestEvent.severity} ·{" "}
              {formatTimestamp(row.cron.latestEvent.recordedAt)}
            </div>
          </div>
        </details>
      ) : null}
    </aside>
  );
}
