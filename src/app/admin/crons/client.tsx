"use client";

import { useMemo } from "react";
import { buildDashboardCronGroups, countRunningDashboardCrons } from "@/lib/status-dashboard-model";
import type { StatusResponse } from "@shared/types";
import { CronsSection } from "../sections/crons-section";
import { createStatusWorkspaceClient } from "../status-workspace-client";

/** Adapter: `CronsSection` is the one workspace section with derived props. */
function CronsWorkspaceSection({ data }: { data: StatusResponse }) {
  const cronGroups = useMemo(() => buildDashboardCronGroups(data), [data]);
  return <CronsSection data={data} runningCrons={countRunningDashboardCrons(data)} cronGroups={cronGroups} />;
}

export default createStatusWorkspaceClient(CronsWorkspaceSection);
