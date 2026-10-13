// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EndpointProbeResult } from "@shared/types";
import { EndpointHealthGrid } from "../endpoint-health-grid";
import { ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";

const [firstPublicPath, secondPublicPath] = ENDPOINT_GROUPS.public;

function probe(path: string, overrides: Partial<EndpointProbeResult>): EndpointProbeResult {
  return { path, status: 200, latencyMs: 12, ...overrides };
}

describe("EndpointHealthGrid", () => {
  it("counts a semantically degraded error response once", () => {
    const probes = [
      probe(firstPublicPath!, { status: 503, semanticStatus: "degraded" }),
      probe(secondPublicPath!, {}),
    ];

    render(<EndpointHealthGrid probes={probes} isLoading={false} groups={["public"]} />);

    // 1 healthy + 0 degraded + 1 stale must sum to the two samples: the probe
    // that is both HTTP-failing and semantically degraded is one sample.
    expect(screen.getByText(/1 of 2 passing, 1 failed or unreachable\./)).toBeTruthy();
  });

  it("renders a single status badge for an error response carrying semantics", () => {
    const probes = [probe(firstPublicPath!, { status: 503, semanticStatus: "degraded" })];

    render(<EndpointHealthGrid probes={probes} isLoading={false} groups={["public"]} />);

    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("labels a semantically degraded 2xx probe as slow data", () => {
    render(
      <EndpointHealthGrid probes={[probe(firstPublicPath!, { semanticStatus: "degraded" })]} isLoading={false} groups={["public"]} />,
    );

    expect(screen.getByText("Slow data")).toBeTruthy();
    expect(screen.getByText(/0 of 1 passing, 1 with slow data\./)).toBeTruthy();
  });

  it("prints the HTTP code once per probe row", () => {
    render(<EndpointHealthGrid probes={[probe(firstPublicPath!, {})]} isLoading={false} groups={["public"]} />);

    expect(screen.getAllByText(/HTTP 200/)).toHaveLength(1);
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("reports a failed probe run instead of an empty sample", () => {
    render(<EndpointHealthGrid probes={undefined} isLoading={false} error={new Error("blocked")} groups={["public"]} />);

    expect(screen.getByText("Browser probes could not run: blocked")).toBeTruthy();
    expect(screen.queryByText(/No browser probe samples yet/)).toBeNull();
  });
});
