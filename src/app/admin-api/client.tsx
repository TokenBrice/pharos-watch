"use client";

import { ApiKeysPanel } from "@/components/status/api-keys-panel";
import { ApiKeyRequestsPanel } from "@/components/status/api-key-requests-panel";
import { OpsHostGateShell } from "@/components/ops-host-gate-shell";

const ADMIN_API_SHELL_PROPS = {
  breadcrumbName: "API Management",
  path: "/admin-api/",
  title: "API Management",
  variant: "auth-gated" as const,
};

export default function AdminApiClient() {
  return (
    <OpsHostGateShell
      {...ADMIN_API_SHELL_PROPS}
      leadParagraphs={["Access-protected control surface for API key lifecycle work and self-serve request review."]}
      loadingLabel="Loading API management access..."
      publicLeadParagraph="This route exists, but API management only runs on the Access-protected ops host."
      publicTitle="API management is not available on the public host."
      publicDescription="API keys and requester details are managed behind the Access-protected ops host."
    >
      <div className="space-y-5">
        <ApiKeyRequestsPanel />
        <ApiKeysPanel />
      </div>
    </OpsHostGateShell>
  );
}
