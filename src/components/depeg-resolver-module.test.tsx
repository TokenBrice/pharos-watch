// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card";
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
