// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  DdrV2ResponseRowSchema,
  type DdrPredictionMeta,
  type DdrResponse,
  type DdrRow,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "./depeg-resolver-test-support";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));

const meta = DDR_TEST_META;
const makeSourceRow = makeDdrSourceRow;

function predictionMeta(
  state: DdrPredictionMeta["state"],
  overrides: Partial<DdrPredictionMeta> = {},
): DdrPredictionMeta {
  return {
    state,
    publicPredictionId:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 7,
    incidentKey: "ddr2:test",
    predictionPolicyVersion: "sticky-24h-v1",
    predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
    predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    resolutionRubricVersion: "resolution-rubric-v1",
    durationModelVersion: "duration-landmark-v1",
    incidentGroupingVersion: "incident-group-v1",
    supportRulesVersion: "support-rules-v1",
    eligibleAt: 86_400,
    policyDelaySec: 86_400,
    lockedAt:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_401,
    publishedAt:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_500,
    publicationSnapshotToken:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
        ? null
        : "ddrpub:test",
    snapshotGeneration:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 2,
    eventAgeAtLockSec:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_400,
    lockTiming:
      state === "lock_deferred"
        ? "deferred"
        : state === "pending_lock" || state === "publication_retry_pending"
          ? null
          : "on_time",
    lockTrigger: "scheduled_24h",
    readiness: null,
    backstop: null,
    source:
      state === "invalidated"
        ? "erratum"
        : state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
          ? "pending"
          : "public_prediction",
    deferralReason: null,
    deferralCount: null,
    rowHash:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
        ? null
        : "a".repeat(64),
    lineage: null,
    modelAsOf: 86_401,
    latestErratum: null,
    errataCount: 0,
    errataHistory: [],
    ...overrides,
  };
}

function baseV2Row(source: DdrRow) {
  return {
    stablecoinId: source.stablecoinId,
    symbol: source.symbol,
    name: source.name,
    pegCurrency: source.pegCurrency,
    governance: source.governance,
    status: source.status,
    eventId: source.eventId,
    incidentKey: "ddr2:test",
    startedAt: source.startedAt,
    direction: source.direction,
  };
}

function liveOverlay(source: DdrRow, overrides: Record<string, unknown> = {}) {
  return {
    currentEventId: source.eventId,
    ageSec: source.ageSec,
    peakDeviationBps: source.peakDeviationBps,
    currentDeviationBps: source.currentDeviationBps,
    eventState: "active",
    updatedAt: source.startedAt + source.ageSec,
    stale: false,
    degradedReason: null,
    ...overrides,
  };
}

function makePredictionRow(source = makeSourceRow(), liveOverrides: Record<string, unknown> = {}): DdrV2ResponseRow {
  return makeFrozenDdrV2Row(source, { live: liveOverlay(source, liveOverrides) });
}

function makePendingRow(
  state: "pending_lock" | "lock_deferred" | "publication_retry_pending",
  overrides: Partial<DdrPredictionMeta> = {},
): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "pending",
    prediction: predictionMeta(state, overrides),
    frozen: null,
    live: liveOverlay(source),
  });
}

function makeNoCallRow(): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "no_call",
    prediction: predictionMeta("no_call"),
    noCall: {
      lockedAt: 86_401,
      eventAgeAtLockSec: 86_400,
      missingReasons: ["no usable live price"],
      relatedContext: makeSourceRow().relatedContext,
    },
    frozen: null,
    live: liveOverlay(source),
  });
}

function makeInvalidatedRow(): DdrV2ResponseRow {
  const source = makeSourceRow();
  const original = makePredictionRow(source);
  if (original.kind !== "prediction") throw new Error("Expected prediction fixture");
  const erratum = {
    id: 1,
    state: "invalidated" as const,
    publicPredictionId: 7,
    incidentKey: "ddr2:test",
    eventId: 1,
    assessmentId: 1,
    reason: "event_identity_error" as const,
    createdAt: 86_500,
    operatorNote: "Source event repaired after publication",
    rowHashBefore: "a".repeat(64),
    replacementAssessmentId: null,
    replacementRowHash: null,
    createdBy: "test",
  };
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "invalidated_prediction",
    prediction: predictionMeta("invalidated", {
      latestErratum: erratum,
      errataCount: 1,
      errataHistory: [erratum],
    }),
    originalKind: "prediction",
    originalOutcome: original.frozen,
    frozen: null,
    noCall: null,
    live: liveOverlay(source, { eventState: "event_invalidated" }),
  });
}

const row = makePredictionRow();

function response(overrides: Partial<DdrResponse> = {}): DdrResponse {
  return {
    _meta: meta,
    rows: [],
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 1,
      isCurrent: true,
    },
    ...overrides,
  };
}

describe("DepegResolverModule", () => {
  it("shows the DDR methodology version in the module header", () => {
    render(<DepegResolverModule data={response()} />);

    expect(screen.getByText(DDR_METHODOLOGY_VERSION_LABEL)).toBeTruthy();
  });

  it("does not claim there are no active depegs before data loads", () => {
    render(<DepegResolverModule data={undefined} />);

    expect(screen.getByText("Resolver data is loading.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs/)).toBeNull();
  });

  it("shows unavailable copy for degraded empty snapshots", () => {
    render(
      <DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason: "missing-cache" } })} />,
    );

    expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs/)).toBeNull();
  });

  it("maps suppressed duration reasons to public copy", () => {
    render(<DepegResolverModule data={response({ rows: [row] })} />);

    expect(screen.getByText("Insufficient comparable recoveries for a duration band.")).toBeTruthy();
    expect(screen.queryByText("insufficient_support")).toBeNull();
  });

  it("states the terminal recovery outlook clearly", () => {
    const terminalRow = makePredictionRow(
      makeSourceRow({
        resolution: {
          tier: "recovery_unlikely",
          factors: [],
        },
        duration: {
          suppressed: true,
          suppressedReason: "verdict_terminal",
          stratum: null,
          medianSec: null,
          iqrSec: null,
          ageStatus: null,
          horizons: [],
        },
      }),
    );
    render(
      <DepegResolverModule
        data={response({
          rows: [terminalRow],
        })}
      />,
    );

    expect(screen.getByText("DDR does not expect this depeg to recover.")).toBeTruthy();
    expect(
      screen.getByText("Comparable structural failures did not return to peg, so no duration estimate is shown."),
    ).toBeTruthy();
    expect(screen.queryByText(/Duration not estimated/)).toBeNull();
  });

  it("does not render verdict or duration for pending, deferred, and retry-pending v2 rows", () => {
    const { rerender } = render(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("pending_lock")],
        })}
      />,
    );

    expect(screen.getByText("Prediction lock pending")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();
    expect(screen.queryByText(/~resolve/)).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("lock_deferred", { deferralReason: "stablecoins cache stale" })],
        })}
      />,
    );
    expect(screen.getByText("Health deferral")).toBeTruthy();
    expect(screen.getByText("Deferral reason: stablecoins cache stale")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("publication_retry_pending")],
        })}
      />,
    );
    expect(screen.getByText("Forecast publication delayed")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();
  });

  it("shows frozen prediction lock metadata separately from live status", () => {
    const sourceRow = makeSourceRow({
      ageSec: 86_400,
      currentDeviationBps: -250,
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: "below · moderate · USD",
        medianSec: 7200,
        iqrSec: [3600, 10_800],
        ageStatus: "ordinary",
        horizons: [],
      },
    });
    render(
      <DepegResolverModule
        data={response({
          rows: [
            makePredictionRow(sourceRow, {
              ageSec: 90_000,
              peakDeviationBps: -320,
              currentDeviationBps: -180,
              updatedAt: 90_000,
            }),
          ],
        })}
      />,
    );

    // The chip renders twice (mobile Sheet trigger + desktop Popover trigger).
    expect(screen.getAllByText("Prediction frozen").length).toBeGreaterThan(0);
    expect(screen.getByText("anchored duration")).toBeTruthy();
    expect(screen.getByText("~2h (1h-3h)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /lock deviation -250 bps/i })).toBeTruthy();
    expect(screen.getByText("From lock")).toBeTruthy();
    expect(screen.getByText("$0.9820")).toBeTruthy();
    expect(screen.queryByText("$0.9750")).toBeNull();
    // Live overlay deviation (-180) renders in the Live incident strip, distinct from the frozen lock-side value.
    expect(screen.getByText("-180 bps")).toBeTruthy();
    expect(screen.queryByText("Projected")).toBeNull();
    expect(screen.getByText("Live incident")).toBeTruthy();
    expect(screen.getByText("on time")).toBeTruthy();
  });

  it("renders no-call and invalidated v2 rows as accountability states", () => {
    const { rerender } = render(
      <DepegResolverModule
        data={response({
          rows: [makeNoCallRow()],
        })}
      />,
    );

    expect(screen.getByText("No-call at lock")).toBeTruthy();
    expect(screen.getByText("no usable live price")).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makeInvalidatedRow()],
        })}
      />,
    );

    expect(screen.getByText("Prediction invalidated by erratum")).toBeTruthy();
    expect(screen.getByText("Erratum and original outcome")).toBeTruthy();
  });
});

describe("StablecoinDepegResolverRows", () => {
  it("renders only the DDR row for the current stablecoin", () => {
    render(<StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={response({ rows: [row] })} />);

    expect(screen.getByLabelText("Depeg Duration Resolver for LUSD")).toBeTruthy();
    expect(screen.getByText("At Risk")).toBeTruthy();
  });

  it("stays hidden when the DDR snapshot has no row for the current stablecoin", () => {
    render(<StablecoinDepegResolverRows stablecoinId="usdc-circle" data={response({ rows: [row] })} />);

    expect(screen.queryByText("At Risk")).toBeNull();
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();
  });

  it("renders matching rows when the resolver payload is missing metadata", () => {
    render(
      <StablecoinDepegResolverRows
        stablecoinId="lusd-liquity"
        data={{
          rows: [row],
        }}
      />,
    );

    expect(screen.getByLabelText("Depeg Duration Resolver for LUSD")).toBeTruthy();
    expect(screen.getByText("At Risk")).toBeTruthy();
  });

  it("keeps matching rows visible when the resolver snapshot is stale", () => {
    render(
      <StablecoinDepegResolverRows
        stablecoinId="lusd-liquity"
        data={response({
          _meta: { ...meta, degraded: true, degradedReason: "stale-cache" },
          rows: [row],
        })}
      />,
    );

    expect(
      screen.getByText("Resolver snapshot is stale; duration estimates are suppressed until the next refresh."),
    ).toBeTruthy();
    expect(screen.getByText("At Risk")).toBeTruthy();
  });
});
