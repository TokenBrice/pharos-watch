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
    expect(screen.getByText(/1\/2 healthy or reachable, 0 degraded, 1 stale or unreachable\./)).toBeTruthy();
  });

  it("renders a single status badge for an error response carrying semantics", () => {
    const probes = [probe(firstPublicPath!, { status: 503, semanticStatus: "degraded" })];

    render(<EndpointHealthGrid probes={probes} isLoading={false} groups={["public"]} />);

    expect(screen.getAllByText("degraded")).toHaveLength(1);
  });
});
