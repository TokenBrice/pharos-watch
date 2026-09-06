import type { ACTIVE_STABLECOINS, FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

export interface ReportCardRegistryRows {
  activeStablecoins: typeof ACTIVE_STABLECOINS;
  frozenStablecoins: typeof FROZEN_STABLECOINS;
  deadStablecoins: typeof DEAD_STABLECOINS;
}

export function fingerprintReportCardRegistryRows(rows: ReportCardRegistryRows): string {
  return sha256Hex(stableJsonStringifyV1({
    domain: "report-cards.fixed-input.registry.v1",
    activeStablecoins: [...rows.activeStablecoins].sort((a, b) => a.id.localeCompare(b.id)),
    frozenStablecoins: [...rows.frozenStablecoins].sort((a, b) => a.id.localeCompare(b.id)),
    deadStablecoins: [...rows.deadStablecoins].sort((a, b) => a.id.localeCompare(b.id)),
  }));
}
