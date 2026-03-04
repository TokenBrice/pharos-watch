"use client";

import { PageError } from "@/components/page-error";

type RouteErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export function createPageError(title: string, displayName?: string) {
  function RouteError({ error, reset }: RouteErrorProps) {
    return <PageError title={title} error={error} reset={reset} />;
  }

  RouteError.displayName = displayName ?? "RouteError";
  return RouteError;
}
