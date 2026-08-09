"use client";

import type { ComponentType } from "react";
import { useStatus } from "@/hooks/use-status";
import type { StatusResponse } from "@shared/types";
import { WorkspaceStatusBoundary } from "./workspace-status-boundary";

/**
 * Every admin workspace route is the same client: poll `/status`, hand the
 * response to `WorkspaceStatusBoundary`, render one section inside it. The
 * routes differ only by which section they mount, so the client is a factory.
 *
 * Sections needing derived props wrap themselves in a `{ data }` adapter (see
 * `crons/client.tsx`) rather than widening this signature.
 */
export function createStatusWorkspaceClient(
  Section: ComponentType<{ data: StatusResponse }>,
) {
  return function StatusWorkspaceClient() {
    const statusQuery = useStatus();
    const handleRefresh = () => {
      void statusQuery.refetch();
    };

    return (
      <WorkspaceStatusBoundary
        data={statusQuery.data}
        error={statusQuery.error instanceof Error ? statusQuery.error : null}
        isLoading={statusQuery.isLoading}
        onRetry={handleRefresh}
      >
        {(data) => <Section data={data} />}
      </WorkspaceStatusBoundary>
    );
  };
}
