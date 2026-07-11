"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ServerCrash } from "lucide-react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PageErrorEditorial } from "@/components/page-error-editorial";
import { buildRequestUrl } from "@/lib/api-url";
import { isHardReloadableRouteError } from "@/lib/route-error-recovery";
import { RequestSequence, isRequestCancellation, requestJson } from "@/lib/request";

type HealthState = "unknown" | "ok" | "degraded";

interface RootErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Root error boundary. W5-I shipped the editorial voice via PageErrorEditorial;
 * W7-A (E2 / IDEA-8) layers status-aware recovery on top:
 *  - render the static editorial fallback FIRST (a failed error page that
 *    fetches can double-fault), then probe the health endpoint on mount;
 *  - if the backend is degraded, surface a yellow callout linking to /status/;
 *  - classify chunk-load errors and adapt the recovery hint.
 */
export default function RootError({ error, reset }: RootErrorProps) {
  const [healthState, setHealthState] = useState<HealthState>("unknown");
  const shouldHardReload = isHardReloadableRouteError(error);

  useEffect(() => {
    const requests = new RequestSequence();
    requests
      .run((signal) =>
        requestJson<unknown>(buildRequestUrl(API_PATHS.health()), {
          signal,
          timeoutMs: 5_000,
          init: { headers: { Accept: "application/json" } },
        }),
      )
      .then((data: unknown) => {
        const status =
          data && typeof data === "object" && "status" in data ? (data as { status?: unknown }).status : null;
        setHealthState(status === "healthy" ? "ok" : "degraded");
      })
      .catch((requestError) => {
        if (!isRequestCancellation(requestError)) setHealthState("unknown");
      });
    return () => {
      requests.cancel();
    };
  }, []);

  const { kicker, title, body } = describeFailure({ shouldHardReload });

  return (
    <div className="space-y-4">
      <PageErrorEditorial kicker={kicker} title={title} body={body} error={error} reset={reset} />
      {healthState === "degraded" ? (
        <div
          role="status"
          className="mx-auto max-w-xl rounded-lg border border-[color:var(--severity-mild)]/50 bg-[color:var(--severity-mild)]/[0.08] px-4 py-3 text-sm"
        >
          <div className="flex items-start gap-2">
            <ServerCrash className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--severity-mild)]" aria-hidden="true" />
            <p className="text-foreground/90">
              The API is currently degraded.{" "}
              <Link
                href="/status/"
                className="pharos-focus-ring font-medium underline underline-offset-4 hover:text-foreground"
              >
                View the status page
              </Link>{" "}
              for what&apos;s affected.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface FailureCopy {
  kicker: string;
  title: string;
  body: string;
}

function describeFailure({ shouldHardReload }: { shouldHardReload: boolean }): FailureCopy {
  if (shouldHardReload) {
    // Chunk-load: usually a stale client after a deploy.
    return {
      kicker: "Lighthouse switched bulbs",
      title: "A newer version of the site is up.",
      body: "The page tried to load a chunk that has rotated out. Reloading usually fixes this — the watch resumes on the next pass.",
    };
  }
  return {
    kicker: "Lighthouse flickered",
    title: "The beam paused. The data is being re-aligned.",
    body: "A pipeline missed its sweep or a chunk failed to land. Try again — the watch usually resumes on the next pass.",
  };
}
