"use client";

import dynamic from "next/dynamic";
import { ComplianceContentLoadingState } from "./loading";

const ComplianceWorkbench = dynamic(
  () => import("@/components/compliance/compliance-client").then((mod) => mod.ComplianceClient),
  { loading: () => <ComplianceContentLoadingState /> },
);

/** Client-to-client boundary: Next can split the filter and table workbench from the route entry chunk. */
export function ComplianceClient() {
  return <ComplianceWorkbench />;
}
