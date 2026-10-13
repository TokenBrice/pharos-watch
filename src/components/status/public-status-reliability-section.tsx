"use client";

import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import type { EndpointProbeResult, HealthResponse } from "@shared/types";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { LazyDetails } from "@/components/status/lazy-details";
import { SchedulerLivenessCard } from "@/components/status/scheduler-liveness";

interface PublicStatusReliabilitySectionProps {
  healthData: HealthResponse;
  probes: EndpointProbeResult[] | undefined;
  probesLoading: boolean;
  probesError: Error | null;
  /** Probe-vs-health disagreement, when there is one. */
  divergenceDetail: string | null;
}

/** "For integrators": the raw evidence behind the component verdicts, collapsed by default. */
export function PublicStatusReliabilitySection({
  healthData,
  probes,
  probesLoading,
  probesError,
  divergenceDetail,
}: PublicStatusReliabilitySectionProps) {
  const publicImpactCircuits = healthData.circuits == null ? null : Object.fromEntries(
    Object.entries(healthData.circuits).filter(([key]) => isPublicImpactCircuitKey(key)),
  );

  return (
    <section id="reliability" aria-labelledby="reliability-title" className="pharos-card-shell px-4 py-4 sm:px-5">
      <LazyDetails
        summary={
          <summary className="pharos-focus-ring cursor-pointer rounded-sm">
            <h2 id="reliability-title" className="inline text-2xl font-bold leading-tight text-foreground">For integrators</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Browser probes, upstream circuit breakers, cache ages, scheduled delivery and response headers.
            </p>
          </summary>
        }
      >
        <div className="mt-4 space-y-5">
          <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            <p>
              API responses carry their own freshness. <code>X-Data-Age</code> gives the seconds since the data was
              produced, a <code>Warning</code> header marks data past its freshness window, and <code>Retry-After</code>
              accompanies rate-limited responses. Where a response has a <code>_meta.status</code> field, that field is
              authoritative. Each endpoint&apos;s cache profile is listed in the API reference.
            </p>
          </div>
          {divergenceDetail ? (
            <p className="rounded-md border border-state-warn bg-state-warn-subtle px-3 py-2 text-sm text-state-warn">{divergenceDetail}</p>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <EndpointHealthGrid
              probes={probes}
              isLoading={probesLoading}
              error={probesError}
              groups={["public"]}
              description="Requests sent from this browser to public API routes. A freshness Warning header counts as a data-health signal; other 2xx responses are reachability checks."
              footnote="Admin and manual action routes are not probed from this page."
            />
            <CircuitBreakerTable circuits={publicImpactCircuits} unavailableReason={healthData.circuitsUnavailableReason} />
          </div>
          <CacheFreshnessTable caches={healthData.caches} />
          <SchedulerLivenessCard observation={healthData.schedulerLiveness} />
        </div>
      </LazyDetails>
    </section>
  );
}
