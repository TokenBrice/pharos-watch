"use client";

import type { ReactNode } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import type { StatusResponse } from "@shared/types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

interface WorkspaceStatusBoundaryProps {
  data: StatusResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRetry: () => void;
  children: (data: StatusResponse) => ReactNode;
}

export function WorkspaceStatusBoundary({ data, error, isLoading, onRetry, children }: WorkspaceStatusBoundaryProps) {
  if (!data && isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Loading workspace data"
        className="space-y-5 py-4 motion-safe:animate-pulse"
      >
        <span className="sr-only">Loading workspace data...</span>
        <div className="h-7 w-48 bg-muted" aria-hidden="true" />
        <div className="h-4 w-full max-w-2xl bg-muted/70" aria-hidden="true" />
        <div className="grid gap-3 sm:grid-cols-3" aria-hidden="true">
          <div className="h-24 border-y border-border/60 bg-muted/30" />
          <div className="h-24 border-y border-border/60 bg-muted/30" />
          <div className="h-24 border-y border-border/60 bg-muted/30" />
        </div>
      </div>
    );
  }

  if (!data && error) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className={cn("border p-5 text-red-800 dark:text-red-200", SEVERITY_TONE_CLASS.alert.banner)}
      >
        <h2 className="text-base font-semibold">Status data failed to load</h2>
        <p className="mt-2 text-sm">{error.message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-current px-3 py-2 text-sm font-medium"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Retry
          </button>
          <a
            href="/cdn-cgi/access/login"
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
          >
            <LogIn className="size-4" aria-hidden="true" />
            Reauthenticate
          </a>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="py-20 text-center text-sm text-muted-foreground"
      >
        Status data is unavailable.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn("border px-4 py-3 text-sm text-amber-900 dark:text-amber-200", SEVERITY_TONE_CLASS.watch.banner)}
        >
          <span className="font-medium">Status refresh failed.</span> Showing the last successful response.{" "}
          {error.message}
        </div>
      ) : null}
      {children(data)}
    </div>
  );
}
