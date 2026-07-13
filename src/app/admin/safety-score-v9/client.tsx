"use client";

import { Fragment, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
} from "lucide-react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { SafetyScoreV9AdminResponse } from "@shared/types/safety-score-v9-admin";
import type { SafetyScoreV9Card } from "@shared/types/safety-score-v9-public";
import {
  SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
  SafetyScoreV9MovementReviewResponseSchema,
  type SafetyScoreV9MovementReviewDisposition,
  type SafetyScoreV9MovementReviewRecord,
} from "@shared/types/safety-score-v9-review";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { LazyDetails } from "@/components/status/lazy-details";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { useSafetyScoreV9Admin } from "@/hooks/use-safety-score-v9-admin";
import { adminMutation } from "@/lib/admin-access";
import { cn } from "@/lib/utils";
import {
  buildSafetyScoreV9WorkspaceModel,
  filterSafetyScoreV9AssetRows,
  formatSafetyScoreV9Delta,
  formatSafetyScoreV9Score,
  formatSafetyScoreV9Timestamp,
  titleCaseSafetyScoreV9Token,
  type SafetyScoreV9AssetRow,
  type SafetyScoreV9WorkspaceModel,
} from "./view-model";

type AvailableResponse = Extract<SafetyScoreV9AdminResponse, { status: "available" }>;
type DiffCard = AvailableResponse["diff"]["cards"][number];

function StatusChip({ tone, children }: { tone: "danger" | "warning" | "success" | "neutral"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full border px-2.5 py-1 text-xs font-semibold",
        tone === "danger" && "border-red-500/35 bg-red-500/10 text-red-800 dark:text-red-300",
        tone === "warning" && "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "success" && "border-green-500/35 bg-green-500/10 text-green-800 dark:text-green-300",
        tone === "neutral" && "border-border bg-muted/35 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 border-b border-border/60 py-3 sm:border-b-0 sm:border-r sm:px-4 sm:first:pl-0 sm:last:border-r-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 pharos-numeric text-lg font-semibold text-foreground">{value}</dd>
      {detail ? (
        <dd className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </dd>
      ) : null}
    </div>
  );
}

function IdentityValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function SectionHeading({
  id,
  title,
  description,
  trailing,
}: {
  id: string;
  title: string;
  description: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/70 pb-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 id={id} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

function PillarScore({ label, pillar }: { label: string; pillar: SafetyScoreV9Card["pillars"]["backing"] }) {
  return (
    <div className="min-w-[4.5rem]">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 pharos-numeric text-sm font-medium text-foreground">
        {formatSafetyScoreV9Score(pillar.score)}
      </div>
    </div>
  );
}

function CardInspection({ card }: { card: SafetyScoreV9Card }) {
  const dependencyCount = card.dependencies.serial.length + card.dependencies.basket.length;
  return (
    <LazyDetails
      className="group/details min-w-[9rem]"
      summary={
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center rounded-md text-xs font-medium text-muted-foreground marker:hidden hover:text-foreground">
          Inspect evidence
        </summary>
      }
    >
      <div className="w-[min(42rem,calc(100vw-3rem))] space-y-4 pb-3 text-xs leading-relaxed text-muted-foreground">
        <dl className="grid gap-x-5 gap-y-3 border-y border-border/60 py-3 sm:grid-cols-2 lg:grid-cols-4">
          <IdentityValue label="Transfer" value={titleCaseSafetyScoreV9Token(card.accessPosture.transfer)} />
          <IdentityValue
            label="Freeze exposure"
            value={titleCaseSafetyScoreV9Token(card.accessPosture.freezeExposure)}
          />
          <IdentityValue label="Primary exit" value={titleCaseSafetyScoreV9Token(card.accessPosture.primaryExit)} />
          <IdentityValue label="Governance" value={titleCaseSafetyScoreV9Token(card.accessPosture.governance)} />
        </dl>

        <div>
          <h4 className="font-medium text-foreground">Evidence posture</h4>
          <p className="mt-1">
            {titleCaseSafetyScoreV9Token(card.evidence.level)} evidence, {card.evidence.freshness} freshness.
            {dependencyCount > 0
              ? ` ${dependencyCount} upstream dependencies are represented.`
              : " No upstream dependency is represented."}
          </p>
        </div>

        {card.nrReasons.length > 0 ? (
          <div>
            <h4 className="font-medium text-foreground">Not-rated reasons</h4>
            <ul className="mt-1 space-y-1">
              {card.nrReasons.map((reason, index) => (
                <li key={`${reason.code}:${reason.field ?? index}`}>
                  <span className="font-mono text-foreground">{reason.code}</span>: {reason.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {card.reasonCodes.length > 0 ? (
          <div>
            <h4 className="font-medium text-foreground">Reason codes</h4>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {card.reasonCodes.map((reason) => (
                <StatusChip key={reason} tone="neutral">
                  {reason}
                </StatusChip>
              ))}
            </div>
          </div>
        ) : null}

        {card.accessPosture.signals.length > 0 ? (
          <div>
            <h4 className="font-medium text-foreground">Access signals</h4>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {card.accessPosture.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </LazyDetails>
  );
}

function AssetTable({ rows }: { rows: readonly SafetyScoreV9AssetRow[] }) {
  return (
    <TableFrame tableId="safety-score-v9-candidate" tableClassName="min-w-[76rem] border-collapse text-left text-xs">
      <TableCaption className="sr-only">Safety Score V9 candidate cards and V8 comparison</TableCaption>
      <TableHeader className="bg-[var(--table-header-bg)] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead scope="col" className="sticky left-0 z-10 bg-[var(--table-header-bg)] px-3 py-2.5">
            Asset
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            V9 grade
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Three pillars
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Weakest
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Binding cap
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Evidence / access
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            V8 → V9
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Review
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Details
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/60">
        {rows.map(({ card, diff }) => (
          <TableRow key={card.id} rowIntent="scan" className="align-top hover:bg-[var(--table-row-hover)]">
            <TableHead
              scope="row"
              className="sticky left-0 z-[1] h-auto bg-background px-3 py-3 font-mono font-semibold text-foreground"
            >
              {card.id}
            </TableHead>
            <TableCell className="px-3 py-3">
              <SafetyGradeBadge
                grade={card.grade}
                score={card.score == null ? null : Math.round(card.score)}
                showScore
                size="xs"
              />
            </TableCell>
            <TableCell className="px-3 py-3">
              <div className="flex gap-3">
                <PillarScore label="Backing" pillar={card.pillars.backing} />
                <PillarScore label="Exit" pillar={card.pillars.exit} />
                <PillarScore label="Control" pillar={card.pillars.control} />
              </div>
            </TableCell>
            <TableCell className="px-3 py-3">
              {card.weakestPillar ? (
                <>
                  <span className="font-medium text-foreground">
                    {titleCaseSafetyScoreV9Token(card.weakestPillar.pillar)}
                  </span>
                  <div className="mt-0.5 pharos-numeric text-muted-foreground">
                    {card.weakestPillar.score.toFixed(1)}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">Unresolved</span>
              )}
            </TableCell>
            <TableCell className="px-3 py-3">
              {card.bindingCap ? (
                <>
                  <span className="font-medium text-foreground">
                    {titleCaseSafetyScoreV9Token(card.bindingCap.kind)}
                  </span>
                  <div className="mt-0.5 pharos-numeric text-muted-foreground">
                    ≤ {card.bindingCap.limit.toFixed(1)}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </TableCell>
            <TableCell className="px-3 py-3 text-muted-foreground">
              <div className="font-medium text-foreground">
                {titleCaseSafetyScoreV9Token(card.evidence.level)} · {card.evidence.freshness}
              </div>
              <div className="mt-1">{titleCaseSafetyScoreV9Token(card.accessPosture.primaryExit)} exit</div>
              <div>{titleCaseSafetyScoreV9Token(card.accessPosture.freezeExposure)} freeze</div>
            </TableCell>
            <TableCell className="px-3 py-3">
              {diff ? (
                <>
                  <div className="pharos-numeric font-medium text-foreground">
                    {diff.v8?.grade ?? "—"} → {diff.v9?.grade ?? "—"}
                  </div>
                  <div className="mt-1 pharos-numeric text-muted-foreground">
                    {formatSafetyScoreV9Delta(diff.scoreDelta)}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">No diff</span>
              )}
            </TableCell>
            <TableCell className="px-3 py-3">
              {diff?.flags.requiresReview ? (
                <StatusChip tone={diff.review.status === "pending" ? "warning" : "success"}>
                  {titleCaseSafetyScoreV9Token(diff.review.status)}
                </StatusChip>
              ) : (
                <StatusChip tone="neutral">Not required</StatusChip>
              )}
            </TableCell>
            <TableCell className="px-3 py-1">
              <CardInspection card={card} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  );
}

function ReviewFlags({ card }: { card: DiffCard }) {
  const flags = [
    card.flags.inputMissing && "Input missing",
    card.flags.gradeOrNrTransition && "Grade / NR transition",
    card.flags.bindingCapChanged && "Binding cap changed",
    card.flags.absoluteScoreDeltaAtLeast5 && "Score delta ≥ 5",
    card.flags.topCutoffScoreDeltaAtLeast2 && "Top-cutoff delta ≥ 2",
    ...card.flags.downstreamThresholdCrossingIds.map((id) => `Threshold: ${id}`),
  ].filter((flag): flag is string => Boolean(flag));
  return <span>{flags.join(" · ") || "Manual review"}</span>;
}

const REVIEW_DISPOSITIONS: ReadonlyArray<{
  value: SafetyScoreV9MovementReviewDisposition;
  label: string;
}> = [
  { value: "intended-methodology-change", label: "Intended methodology change" },
  { value: "evidence-correction", label: "Evidence correction" },
  { value: "producer-data-gap", label: "Producer or data gap" },
  { value: "defect", label: "Defect" },
];

function ReviewClassificationForm({
  card,
  sourceDiffReportDigest,
  onRecorded,
}: {
  card: DiffCard;
  sourceDiffReportDigest: string;
  onRecorded: (review: SafetyScoreV9MovementReviewRecord) => Promise<void>;
}) {
  const [disposition, setDisposition] = useState<SafetyScoreV9MovementReviewDisposition>("intended-methodology-change");
  const [reviewerId, setReviewerId] = useState("");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const resetIntent = () => {
    idempotencyKeyRef.current = null;
    setRecorded(false);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (card.review.key === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      idempotencyKeyRef.current ??=
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `v9-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await adminMutation(API_PATHS.adminSafetyScoreV9Review(), {
        idempotencyKey: idempotencyKeyRef.current,
        body: {
          schemaVersion: SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
          reviewKey: card.review.key,
          assetId: card.id,
          sourceDiffReportDigest,
          disposition,
          reviewerId,
          rationale,
        },
      });
      const response = SafetyScoreV9MovementReviewResponseSchema.parse(result.data);
      setRecorded(true);
      await onRecorded(response.review);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Movement review could not be recorded");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 border-t border-border/60 pt-3 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(12rem,0.8fr)_minmax(18rem,1.4fr)_auto] lg:items-end"
    >
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Disposition
        <select
          value={disposition}
          onChange={(event) => {
            resetIntent();
            setDisposition(event.target.value as SafetyScoreV9MovementReviewDisposition);
          }}
          className="pharos-focus-ring min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground"
        >
          {REVIEW_DISPOSITIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Reviewer
        <input
          value={reviewerId}
          onChange={(event) => {
            resetIntent();
            setReviewerId(event.target.value);
          }}
          required
          maxLength={160}
          autoComplete="username"
          className="pharos-focus-ring min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Rationale
        <textarea
          value={rationale}
          onChange={(event) => {
            resetIntent();
            setRationale(event.target.value);
          }}
          required
          maxLength={2_000}
          rows={2}
          className="pharos-focus-ring min-h-11 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || reviewerId.trim().length === 0 || rationale.trim().length === 0}
        className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-sm font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? (
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : recorded ? (
          <CheckCircle2 className="size-4" aria-hidden="true" />
        ) : (
          <Save className="size-4" aria-hidden="true" />
        )}
        {submitting ? "Recording" : recorded ? "Recorded" : "Record review"}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300 lg:col-span-4">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ReviewTable({
  rows,
  recordsByKey,
  sourceDiffReportDigest,
  onRecorded,
}: {
  rows: readonly DiffCard[];
  recordsByKey: ReadonlyMap<string, SafetyScoreV9MovementReviewRecord>;
  sourceDiffReportDigest: string;
  onRecorded: (review: SafetyScoreV9MovementReviewRecord) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <p className="border-y border-border/60 py-5 text-sm text-muted-foreground">
        No material V8-to-V9 movement currently requires review.
      </p>
    );
  }
  return (
    <TableFrame tableId="safety-score-v9-movement-review" tableClassName="min-w-[64rem] text-left text-xs">
      <TableCaption className="sr-only">V8 to V9 movements requiring review</TableCaption>
      <TableHeader className="bg-[var(--table-header-bg)] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead scope="col" className="px-3 py-2.5">
            Asset
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Movement
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Trigger
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Supply impact
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Disposition
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/60">
        {rows.map((card) => {
          const record = card.review.key === null ? null : (recordsByKey.get(card.review.key) ?? null);
          return (
            <Fragment key={card.id}>
              <TableRow rowIntent="scan" className="hover:bg-[var(--table-row-hover)]">
                <TableHead scope="row" className="h-auto px-3 py-3 font-mono font-semibold text-foreground">
                  {card.id}
                </TableHead>
                <TableCell className="px-3 py-3 pharos-numeric text-foreground">
                  {card.v8?.grade ?? "—"} → {card.v9?.grade ?? "—"}{" "}
                  <span className="ml-2 text-muted-foreground">({formatSafetyScoreV9Delta(card.scoreDelta)})</span>
                </TableCell>
                <TableCell className="max-w-md whitespace-normal px-3 py-3 text-muted-foreground">
                  <ReviewFlags card={card} />
                </TableCell>
                <TableCell className="px-3 py-3 pharos-numeric text-muted-foreground">
                  {card.supplyWeightedImpact == null ? "—" : card.supplyWeightedImpact.toFixed(2)}
                </TableCell>
                <TableCell className="px-3 py-3">
                  <StatusChip tone={card.review.status === "pending" ? "warning" : "success"}>
                    {card.review.disposition
                      ? titleCaseSafetyScoreV9Token(card.review.disposition)
                      : titleCaseSafetyScoreV9Token(card.review.status)}
                  </StatusChip>
                </TableCell>
              </TableRow>
              {record ? (
                <TableRow rowIntent="static">
                  <TableCell colSpan={5} className="whitespace-normal px-3 pb-3 text-xs text-muted-foreground">
                    <div className="border-t border-border/60 pt-2">
                      <span className="font-medium text-foreground">{record.reviewerId}</span>: {record.rationale}
                    </div>
                  </TableCell>
                </TableRow>
              ) : card.review.status === "pending" ? (
                <TableRow rowIntent="static">
                  <TableCell colSpan={5} className="whitespace-normal px-3 pb-3">
                    <ReviewClassificationForm
                      card={card}
                      sourceDiffReportDigest={sourceDiffReportDigest}
                      onRecorded={onRecorded}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

function HistoryTable({ model }: { model: SafetyScoreV9WorkspaceModel }) {
  return (
    <TableFrame tableId="safety-score-v9-shadow-history" tableClassName="min-w-[42rem] text-left text-xs">
      <TableCaption className="sr-only">Recent Safety Score V9 shadow days</TableCaption>
      <TableHeader className="bg-[var(--table-header-bg)] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead scope="col" className="px-3 py-2.5">
            UTC day
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Qualification
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Run counts
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Replay evidence
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Blockers / latest error
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/60">
        {model.history.map((day) => {
          const selected = day.selectedRun;
          const qualifies = selected?.qualification.qualifies === true;
          const evidence = selected?.archiveSelectionReasons.length
            ? `${selected.archiveSelectionReasons.map(titleCaseSafetyScoreV9Token).join(" · ")} · ${selected.artifactKeys.length} artifacts`
            : "Routine summary only";
          const blockers = selected?.qualification.blockers.map(titleCaseSafetyScoreV9Token).join(" · ") || "None";
          const latestError = day.latestError
            ? `${titleCaseSafetyScoreV9Token(day.latestError.stage)}: ${day.latestError.message}`
            : null;
          return (
            <TableRow key={day.utcDay} rowIntent="scan" className="hover:bg-[var(--table-row-hover)]">
              <TableHead scope="row" className="h-auto px-3 py-3 font-mono font-semibold text-foreground">
                {day.utcDay}
              </TableHead>
              <TableCell className="px-3 py-3">
                <StatusChip tone={qualifies ? "success" : "danger"}>
                  {qualifies ? "Qualifies" : selected ? "Does not qualify" : "No successful run"}
                </StatusChip>
              </TableCell>
              <TableCell className="px-3 py-3 pharos-numeric text-foreground">
                {day.attemptCounts.successful} succeeded · {day.attemptCounts.failed} failed
              </TableCell>
              <TableCell className="whitespace-normal px-3 py-3 text-muted-foreground">{evidence}</TableCell>
              <TableCell className="whitespace-normal px-3 py-3 text-muted-foreground">
                {latestError ?? blockers}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

function CandidateWorkspace({
  response,
  onReviewRecorded,
}: {
  response: AvailableResponse;
  onReviewRecorded: (review: SafetyScoreV9MovementReviewRecord) => Promise<void>;
}) {
  const model = useMemo(() => buildSafetyScoreV9WorkspaceModel(response), [response]);
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState<V9Grade | "all">("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const visibleRows = useMemo(
    () => filterSafetyScoreV9AssetRows(model.assetRows, { query, grade, reviewOnly }),
    [grade, model.assetRows, query, reviewOnly],
  );
  const diff = response.diff.summary;
  const movementReviewsByKey = useMemo(
    () => new Map(response.movementReviews.map((review) => [review.reviewKey, review] as const)),
    [response.movementReviews],
  );

  return (
    <div className="space-y-8">
      <section aria-labelledby="v9-candidate-title" className="min-w-0">
        <div className="flex flex-col gap-4 border-b border-border/70 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="pharos-kicker">Shadow evaluation</p>
            <h1 id="v9-candidate-title" className="mt-1 text-2xl font-bold leading-tight text-foreground">
              Safety Score V9 candidate
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Internal inspection of the weakest-path candidate, its replay evidence, and its movement from the active
              V8 model. This surface does not publish or activate V9.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusChip tone="danger">
              <ShieldAlert className="mr-1.5 size-3.5" aria-hidden="true" />
              No-go for activation
            </StatusChip>
            <StatusChip tone="neutral">V8 remains active</StatusChip>
          </div>
        </div>

        <div
          className="mt-4 flex items-start gap-3 border-y border-red-500/30 bg-red-500/5 px-4 py-3 text-red-900 dark:text-red-200"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">This candidate cannot be promoted from this workspace.</p>
            <p className="mt-0.5 text-xs leading-relaxed opacity-90">
              {model.blockers.length > 0
                ? `${model.blockers.length} release blockers or unresolved reviews are visible below.`
                : "The response contract is candidate-only and activation remains independently gated."}
            </p>
          </div>
        </div>

        <dl className="grid border-b border-border/70 sm:grid-cols-2 lg:grid-cols-6">
          <Metric
            label="Rated"
            value={String(model.candidate.completeness.ratedCount)}
            detail={`of ${model.candidate.completeness.expectedCount}`}
          />
          <Metric label="Not rated" value={String(model.candidate.completeness.notRatedCount)} />
          <Metric
            label="Review queue"
            value={String(model.pendingReviewCount)}
            detail={`${diff.requiresReviewCount} total flagged`}
          />
          <Metric
            label="Mean |Δ|"
            value={diff.supplyWeightedMeanAbsoluteDelta?.toFixed(2) ?? "—"}
            detail="Supply weighted"
          />
          <Metric
            label="Qualifying days"
            value={String(model.qualifyingDayCount)}
            detail={`${model.history.length} retained`}
          />
          <Metric
            label="Shadow run"
            value={
              model.currentDay?.selectedRun
                ? model.currentDay.selectedRun.qualification.qualifies
                  ? "qualifying"
                  : "blocked"
                : "missing"
            }
            detail={model.currentDay?.utcDay}
          />
        </dl>

        <div className="flex flex-col gap-2 border-b border-border/70 py-3 sm:flex-row sm:items-center">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Grade distribution</span>
          <div className="flex flex-wrap gap-2">
            {model.gradeCounts.map(({ grade: value, count }) => (
              <span key={value} className="inline-flex items-center gap-1.5">
                <SafetyGradeBadge grade={value} showScore={false} size="xs" />
                <span className="pharos-numeric text-xs text-muted-foreground">{count}</span>
              </span>
            ))}
          </div>
        </div>

        <dl className="mt-4 grid gap-x-6 border-y border-border/60 sm:grid-cols-2 lg:grid-cols-4">
          <IdentityValue label="Candidate ID" value={model.candidate.candidateId} />
          <IdentityValue
            label="Policy"
            value={`${model.candidate.policyVersion} · ${model.candidate.policy.semanticDigest}`}
          />
          <IdentityValue label="Publication generation" value={model.candidate.publicationGenerationId} />
          <IdentityValue label="Evaluation build" value={model.candidate.evaluationBuildDigest} />
          <IdentityValue label="Base input" value={model.candidate.baseInputGenerationId} />
          <IdentityValue label="Fact set" value={model.candidate.factSetDigest} />
          <IdentityValue label="Published" value={formatSafetyScoreV9Timestamp(model.candidate.publishedAtSec)} />
          <IdentityValue label="Evidence as of" value={formatSafetyScoreV9Timestamp(model.candidate.asOfSec)} />
        </dl>
      </section>

      <section aria-labelledby="v9-blockers-title">
        <SectionHeading
          id="v9-blockers-title"
          title="Qualification and coverage"
          description="Release floors, unresolved evidence, and blockers recorded against the exact shadow generation."
          trailing={
            <StatusChip tone={model.blockers.length > 0 ? "danger" : "success"}>
              {model.blockers.length} blockers
            </StatusChip>
          }
        />
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Activation blockers</h3>
            {model.blockers.length > 0 ? (
              <ul className="mt-2 divide-y divide-border/60 border-y border-border/60">
                {model.blockers.map((blocker) => (
                  <li key={blocker} className="flex gap-2 py-2.5 text-sm text-muted-foreground">
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0 text-red-700 dark:text-red-400"
                      aria-hidden="true"
                    />
                    <span>{blocker}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 border-y border-border/60 py-4 text-sm text-muted-foreground">
                No generation-level blocker is recorded. Candidate-only lifecycle gating still applies.
              </p>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Coverage floors</h3>
            <ul className="mt-2 divide-y divide-border/60 border-y border-border/60">
              {response.envelope.coverage.coverageFloors.map((floor) => (
                <li key={floor.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{titleCaseSafetyScoreV9Token(floor.id)}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {floor.detail} · required {floor.required}
                    </div>
                  </div>
                  <StatusChip tone={floor.status === "pass" ? "success" : "danger"}>{floor.status}</StatusChip>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="v9-assets-title">
        <SectionHeading
          id="v9-assets-title"
          title="Candidate asset cards"
          description="Three-pillar scores, critical-path constraints, access posture, and direct V8 comparison for every candidate result."
          trailing={
            <span className="pharos-numeric text-xs text-muted-foreground">
              {visibleRows.length} / {model.assetRows.length} assets
            </span>
          }
        />
        <div className="mt-4 flex flex-col gap-3 border-y border-border/60 bg-[var(--panel-header-bg)] p-3 lg:flex-row lg:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Filter assets</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by asset ID or reason code"
              className="pharos-focus-ring min-h-11 w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
            <span>Grade</span>
            <select
              value={grade}
              onChange={(event) => setGrade(event.target.value as V9Grade | "all")}
              className="pharos-focus-ring min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="all">All grades</option>
              {model.gradeCounts.map(({ grade: value, count }) => (
                <option key={value} value={value}>
                  {value} ({count})
                </option>
              ))}
            </select>
          </label>
          <label className="pharos-focus-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={reviewOnly}
              onChange={(event) => setReviewOnly(event.target.checked)}
              className="size-4 rounded border-border accent-foreground"
            />
            Review required
          </label>
        </div>
        <div className="mt-3">
          {visibleRows.length > 0 ? (
            <AssetTable rows={visibleRows} />
          ) : (
            <p className="border-y border-border/60 py-8 text-center text-sm text-muted-foreground">
              No candidate cards match these filters.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="v9-review-title">
        <SectionHeading
          id="v9-review-title"
          title="V8 to V9 review queue"
          description="Material score, grade, cap, and downstream-threshold movements that require classification before release."
          trailing={
            <StatusChip tone={model.pendingReviewCount > 0 ? "warning" : "success"}>
              {model.pendingReviewCount} pending
            </StatusChip>
          }
        />
        <div className="mt-4">
          <ReviewTable
            rows={model.reviewRows}
            recordsByKey={movementReviewsByKey}
            sourceDiffReportDigest={response.diff.reportDigest}
            onRecorded={onReviewRecorded}
          />
        </div>
      </section>

      <section aria-labelledby="v9-history-title">
        <SectionHeading
          id="v9-history-title"
          title="Recent shadow days"
          description="One compact summary per UTC day, including same-day retry counts, selected-run qualification, and deliberately archived replay evidence."
          trailing={
            <StatusChip tone={model.qualifyingDayCount === model.history.length ? "success" : "warning"}>
              <Clock3 className="mr-1.5 size-3.5" aria-hidden="true" />
              {model.qualifyingDayCount} qualifying
            </StatusChip>
          }
        />
        <div className="mt-4">
          <HistoryTable model={model} />
        </div>
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div role="status" aria-live="polite" className="space-y-5">
      <span className="sr-only">Loading Safety Score V9 candidate</span>
      <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      <div className="h-72 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
    </div>
  );
}

function UnavailableState({
  response,
  onRefresh,
  refreshing,
}: {
  response: Extract<SafetyScoreV9AdminResponse, { status: "unavailable" }>;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <section aria-labelledby="v9-unavailable-title" className="min-w-0">
      <p className="pharos-kicker">Shadow evaluation</p>
      <h1 id="v9-unavailable-title" className="mt-1 text-2xl font-bold text-foreground">
        Safety Score V9 candidate
      </h1>
      <div
        className="mt-5 flex items-start gap-3 border-y border-amber-500/35 bg-amber-500/5 px-4 py-5 text-amber-950 dark:text-amber-200"
        role="status"
      >
        <Database className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Candidate evidence is unavailable</h2>
          <p className="mt-1 text-sm leading-relaxed opacity-90">
            {titleCaseSafetyScoreV9Token(response.reason)}. V8 remains active and this absence cannot authorize a V9
            release.
          </p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="pharos-focus-ring mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-current/30 px-3 text-sm font-medium hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
              aria-hidden="true"
            />
            Refresh evidence
          </button>
        </div>
      </div>
    </section>
  );
}

export default function SafetyScoreV9Client() {
  const query = useSafetyScoreV9Admin();
  const refresh = () => {
    void query.refetch();
  };

  if (query.isLoading && !query.data) return <LoadingState />;
  if (query.error && !query.data) {
    return (
      <section aria-labelledby="v9-error-title">
        <p className="pharos-kicker">Shadow evaluation</p>
        <h1 id="v9-error-title" className="mt-1 text-2xl font-bold text-foreground">
          Safety Score V9 candidate
        </h1>
        <div className="mt-5 border-y border-red-500/35 bg-red-500/5 px-4 py-5" role="alert">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-red-700 dark:text-red-400" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Candidate inspection failed to load</h2>
              <p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p>
              <button
                type="button"
                onClick={refresh}
                disabled={query.isFetching}
                className="pharos-focus-ring mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted/50 disabled:opacity-60"
              >
                <RefreshCw
                  className={cn("size-4", query.isFetching && "animate-spin motion-reduce:animate-none")}
                  aria-hidden="true"
                />
                Retry
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (!query.data) return <LoadingState />;
  if (query.data.status === "unavailable")
    return <UnavailableState response={query.data} onRefresh={refresh} refreshing={query.isFetching} />;
  return (
    <CandidateWorkspace
      response={query.data}
      onReviewRecorded={async () => {
        await query.refetch();
      }}
    />
  );
}
