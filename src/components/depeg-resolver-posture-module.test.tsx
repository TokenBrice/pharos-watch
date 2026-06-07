// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegResolverPostureModule } from "@/components/depeg-resolver-posture-module";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-resolver-version";
import type { DdrResolutionTier, DdrResponse, DdrRow } from "@shared/types";

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

function makeRow(overrides: Partial<DdrRow> & { stablecoinId: string; symbol: string; tier: DdrResolutionTier }): DdrRow {
  const { tier, ...rest } = overrides;
  return {
    name: overrides.symbol,
    pegCurrency: "USD",
    governance: "decentralized",
    status: null,
    eventId: 1,
    startedAt: 1,
    ageSec: 3600,
    direction: "below",
    peakDeviationBps: -500,
    currentDeviationBps: -200,
    resolution: { tier, factors: [] },
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
    ...rest,
  } as DdrRow;
}

function response(rows: DdrRow[]): DdrResponse {
  return {
    _meta: meta,
    rows: rows as DdrResponse["rows"],
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 1,
      isCurrent: true,
    },
  };
}

const THREE_ROWS: DdrRow[] = [
  makeRow({ stablecoinId: "a-coin", symbol: "ACOIN", tier: "recovery_likely" }),
  makeRow({ stablecoinId: "b-coin", symbol: "BCOIN", tier: "at_risk" }),
  makeRow({ stablecoinId: "c-coin", symbol: "CCOIN", tier: "recovery_unlikely" }),
];

describe("DepegResolverPostureModule", () => {
  it("stays hidden below the aggregate threshold so the per-event cards carry small books", () => {
    const { container } = render(<DepegResolverPostureModule data={response(THREE_ROWS.slice(0, 2))} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden while data loads", () => {
    const { container } = render(<DepegResolverPostureModule data={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden for hard-degraded snapshots", () => {
    const { container } = render(
      <DepegResolverPostureModule data={{ ...response(THREE_ROWS), _meta: { ...meta, degraded: true, degradedReason: "missing-cache" } }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("summarizes the book posture and groups every tier", () => {
    render(<DepegResolverPostureModule data={response(THREE_ROWS)} />);

    expect(screen.getByLabelText("Depeg outlook posture")).toBeTruthy();
    expect(screen.getByText(/1 likely to recover, 1 at risk, 1 unlikely to return/)).toBeTruthy();
    expect(screen.getByText("Recovery Likely")).toBeTruthy();
    expect(screen.getByText("Recovery Unlikely")).toBeTruthy();
  });

  it("flags an event whose live gap is wider than its recorded peak as deepening", () => {
    const rows = [
      ...THREE_ROWS,
      makeRow({
        stablecoinId: "d-coin",
        symbol: "DCOIN",
        tier: "at_risk",
        peakDeviationBps: -400,
        currentDeviationBps: -900,
      }),
    ];
    render(<DepegResolverPostureModule data={response(rows)} />);

    expect(screen.getByText("DCOIN is deepening past its worst.")).toBeTruthy();
    expect(screen.getByText("deepening")).toBeTruthy();
  });

  it("shows an expected-clearing band for benchmarked events", () => {
    const rows = [
      ...THREE_ROWS,
      makeRow({
        stablecoinId: "e-coin",
        symbol: "ECOIN",
        tier: "at_risk",
        duration: {
          suppressed: false,
          suppressedReason: null,
          stratum: "below · moderate · USD",
          medianSec: 86_400,
          iqrSec: [43_200, 172_800],
          ageStatus: "ordinary",
          horizons: [],
        },
      }),
    ];
    render(<DepegResolverPostureModule data={response(rows)} />);

    expect(screen.getByText("~1d")).toBeTruthy();
  });
});
