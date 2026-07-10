"use client";

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { StatusResponse } from "@shared/types";

interface WorkspaceStatusBoundaryProps {
  data: StatusResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRetry: () => void;
  children: (data: StatusResponse) => ReactNode;
}

export function WorkspaceStatusBoundary({ data, error, isLoading, onRetry, children }: WorkspaceStatusBoundaryProps) {
  if (!data && isLoading) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Loading workspace data...</div>;
  }

  if (!data && error) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 p-5 text-red-800 dark:text-red-200">
        <h2 className="text-base font-semibold">Status data failed to load</h2>
        <p className="mt-2 text-sm">{error.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="pharos-focus-ring mt-4 inline-flex min-h-10 items-center gap-2 rounded-md border border-current px-3 py-2 text-sm font-medium"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Status data is unavailable.</div>;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <span className="font-medium">Status refresh failed.</span> Showing the last successful response.{" "}
          {error.message}
        </div>
      ) : null}
      {children(data)}
    </div>
  );
}
