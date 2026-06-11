import { ApiKeysPanel } from "@/components/status/api-keys-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";

export function CredentialsSection() {
  return (
    <StatusSection
      id="credentials"
      kicker="Access"
      title="Credentials"
      accentClassName="border-l-slate-500"
      summary={
        <>
          <SummaryBadge label="Inventory" value="API keys" />
          <SummaryBadge label="Lifecycle" value="Create / rotate" />
        </>
      }
    >
      <ApiKeysPanel />
    </StatusSection>
  );
}
