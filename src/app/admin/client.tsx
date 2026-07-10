"use client";

import { OpsHostGateShell } from "@/components/ops-host-gate-shell";
import { AdminActionExecutionProvider } from "@/components/status/admin-action-execution-provider";
import { StatusDashboard } from "./status-dashboard";

const ADMIN_SHELL_PROPS = {
  breadcrumbName: "Admin",
  path: "/admin/",
  title: "Operator Admin",
  variant: "auth-gated" as const,
  containerClassName: "mx-auto w-full max-w-[92rem] space-y-6",
};

export default function StatusClient() {
  const handleOpsSignOut = () => {
    window.location.assign("/cdn-cgi/access/logout");
  };

  return (
    <OpsHostGateShell
      {...ADMIN_SHELL_PROPS}
      leadParagraphs={[
        "Access-protected operator panel for monitoring pipeline health, endpoint reliability, incident state transitions, and manual recovery flows.",
      ]}
      loadingLabel="Loading status access..."
      publicLeadParagraph="This route exists, but the operator control plane only runs on the Access-protected ops host."
      publicTitle="Operator tooling is no longer available on the public host."
      publicDescription={
        <>
          Operator actions, credentials, messaging telemetry, and deep status evidence now run behind the
          Access-protected ops host. The public `/status/` page is read-only.
        </>
      }
    >
      <AdminActionExecutionProvider>
        <StatusDashboard onSignOut={handleOpsSignOut} />
      </AdminActionExecutionProvider>
    </OpsHostGateShell>
  );
}
