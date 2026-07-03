// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-resolver-version";
import type { DdrResponse, DdrRow } from "@shared/types";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));

afterEach(() => {
  cleanup();
});

const meta: DdrResponse["_meta"] = {
  dataAsOf: 1,
  modelAsOf: 1,
  computedAt: 1,
  expiresAt: 2,
  degraded: false,
  degradedReason: null,
  publicWarning: "",
  resolutionRubricVersion: "resolution-rubric-v1",
  durationModelVersion: "duration-landmark-v1",
  incidentGroupingVersion: "incident-group-v1",
  supportRulesVersion: "support-rules-v1",
  lineage: null,
};

const row: DdrRow = {
  stablecoinId: "lusd-liquity",
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  status: null,
  eventId: 1,
  startedAt: 1,
  ageSec: 3600,
  direction: "below",
  peakDeviationBps: -300,
  currentDeviationBps: -250,
  resolution: {
    tier: "at_risk",
    factors: [],
  },
  duration: {
    suppressed: true,
    suppressedReason: "insufficient_support",
    stratum: null,
    medianSec: null,
    iqrSec: null,
    ageStatus: null,
    horizons: [],
  },
  relatedContext: {},
};

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
    render(
      <DepegResolverModule
        data={response({
          rows: [
            {
              ...row,
              resolution: {
                tier: "recovery_unlikely",
                factors: [],
              },
              duration: {
                ...row.duration,
                suppressedReason: "verdict_terminal",
              },
            },
          ],
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
          rows: [
            {
              ...row,
              kind: "pending",
              eligibleAt: 86_401,
              prediction: { state: "pending_lock" },
            } as DdrRow,
          ],
        })}
      />,
    );

    expect(screen.getByText("Prediction lock pending")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();
    expect(screen.queryByText(/~resolve/)).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [
            {
              ...row,
              prediction: { state: "lock_deferred", deferralReason: "stablecoins cache stale" },
            } as DdrRow,
          ],
        })}
      />,
    );
    expect(screen.getByText("Health deferral")).toBeTruthy();
    expect(screen.getByText("Deferral reason: stablecoins cache stale")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [
            {
              ...row,
              prediction: { state: "publication_retry_pending", retryStatus: "Retrying next healthy publication run" },
            } as DdrRow,
          ],
        })}
      />,
    );
    expect(screen.getByText("Forecast publication delayed")).toBeTruthy();
    expect(screen.getByText("Retrying next healthy publication run")).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [
            {
              ...row,
              prediction: { state: "publication_failed" },
            } as DdrRow,
          ],
        })}
      />,
    );
    expect(screen.getByText("Publication failed before public exposure")).toBeTruthy();
    expect(screen.getByText(/operational coverage debt/)).toBeTruthy();
    expect(screen.queryByText("At Risk")).toBeNull();
  });

  it("shows frozen prediction lock metadata separately from live status", () => {
    const sourceRow: DdrRow = {
      ...row,
      ageSec: 86_400,
      currentDeviationBps: -250,
      duration: {
        ...row.duration,
        suppressed: false,
        medianSec: 7200,
        iqrSec: [3600, 10_800],
        horizons: [],
      },
    };
    render(
      <DepegResolverModule
        data={response({
          rows: [
            {
              stablecoinId: row.stablecoinId,
              symbol: row.symbol,
              name: row.name,
              pegCurrency: row.pegCurrency,
              governance: row.governance,
              status: row.status,
              eventId: row.eventId,
              incidentKey: "ddr2:test",
              startedAt: row.startedAt,
              direction: row.direction,
              kind: "prediction",
              prediction: {
                state: "frozen",
                publicPredictionId: 7,
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
                lockedAt: 86_401,
                publishedAt: 86_500,
                publicationSnapshotToken: "ddrpub:test",
                snapshotGeneration: 2,
                eventAgeAtLockSec: 86_400,
                lockTiming: "on_time",
                lockTrigger: "scheduled_24h",
                readiness: null,
                backstop: null,
                source: "public_prediction",
                deferralReason: null,
                deferralCount: null,
                rowHash: "a".repeat(64),
                lineage: null,
                modelAsOf: 86_401,
                latestErratum: null,
                errataCount: 0,
                errataHistory: [],
              },
              frozen: {
                resolution: sourceRow.resolution,
                duration: {
                  ...sourceRow.duration,
                  remainingAsOf: 86_401,
                  medianResolveAt: 93_601,
                  iqrResolveAt: [90_001, 97_201],
                  horizons: [],
                },
                relatedContext: sourceRow.relatedContext,
                sourceRow,
              },
              live: {
                currentEventId: row.eventId,
                ageSec: 90_000,
                peakDeviationBps: -320,
                currentDeviationBps: -180,
                eventState: "active",
                updatedAt: 90_000,
                stale: false,
                degradedReason: null,
              },
            } as DdrResponse["rows"][number],
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
          rows: [
            {
              ...row,
              kind: "no_call",
              prediction: { state: "no_call", lockedAt: 86_401, missingReasons: ["no usable live price"] },
            } as DdrRow,
          ],
        })}
      />,
    );

    expect(screen.getByText("No-call at lock")).toBeTruthy();
    expect(screen.getByText("no usable live price")).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [
            {
              ...row,
              kind: "invalidated_prediction",
              prediction: {
                state: "invalidated",
                originalOutcomeKind: "prediction",
                invalidationReason: "source event repaired",
              },
              latestErratum: { summary: "Source event repaired after publication", createdAt: 86_500 },
            } as DdrRow,
          ],
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
