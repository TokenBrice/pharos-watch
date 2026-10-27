"use client";

import { PageErrorEditorial } from "@/components/page-error-editorial";
import { isHardReloadableRouteError } from "@/lib/route-error-recovery";

interface RootErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Root error boundary. Renders the static editorial fallback and adapts the
 * recovery hint for chunk-load errors. It issues no requests: a failed error
 * page must not fetch, and readers are not shown backend-health callouts
 * (ADR-42).
 */
export default function RootError({ error, reset }: RootErrorProps) {
  const { kicker, title, body } = describeFailure({ shouldHardReload: isHardReloadableRouteError(error) });

  return <PageErrorEditorial kicker={kicker} title={title} body={body} error={error} reset={reset} />;
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
