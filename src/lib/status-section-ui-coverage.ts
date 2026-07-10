import type { StatusSectionKey } from "@shared/types";
import type { AdminWorkspaceId } from "@/lib/admin-workspaces";

export interface StatusSectionUiDisposition {
  workspace: AdminWorkspaceId;
  view: string;
  treatment: "primary" | "summary" | "detail" | "error-notice";
}

/**
 * Exhaustive ownership contract for best-effort `/api/status` supplements.
 * Adding a StatusSectionKey requires an explicit operator-UI disposition.
 */
export const STATUS_SECTION_UI_COVERAGE = {
  statusState: { workspace: "triage", view: "Diagnostics", treatment: "detail" },
  statusSnapshot: { workspace: "triage", view: "Evidence notices", treatment: "error-notice" },
  telegramBot: { workspace: "comms", view: "Delivery operations", treatment: "primary" },
  reserveComposition: { workspace: "pipeline", view: "Reserves", treatment: "primary" },
  d1Usage: { workspace: "pipeline", view: "Storage", treatment: "primary" },
  liquidityHealth: { workspace: "pipeline", view: "Markets", treatment: "primary" },
  yieldHealth: { workspace: "pipeline", view: "Yield", treatment: "primary" },
  publicationHealth: { workspace: "pipeline", view: "Integrity", treatment: "primary" },
  dependencyHealth: { workspace: "reliability", view: "Dependencies", treatment: "primary" },
  providerCircuitHealth: { workspace: "reliability", view: "Dependencies", treatment: "primary" },
  canaries: { workspace: "reliability", view: "Dependencies", treatment: "primary" },
  priceSourceHealth: { workspace: "pipeline", view: "Markets", treatment: "primary" },
  coingeckoPriceDiff: { workspace: "pipeline", view: "Markets", treatment: "primary" },
  discoveryCandidates: { workspace: "pipeline", view: "Discovery", treatment: "primary" },
  jobAttempts: { workspace: "crons", view: "Selected job", treatment: "detail" },
  scheduledSlots: { workspace: "crons", view: "Trigger groups", treatment: "summary" },
  mintBurnReconciliation: { workspace: "pipeline", view: "Reserves", treatment: "primary" },
  reserveDrift: { workspace: "pipeline", view: "Reserves", treatment: "primary" },
  classificationWarnings: { workspace: "pipeline", view: "Reserves", treatment: "primary" },
  producerHistory: { workspace: "history", view: "Incident history", treatment: "detail" },
} as const satisfies Record<StatusSectionKey, StatusSectionUiDisposition>;
