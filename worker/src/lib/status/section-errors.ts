import type { DataQuality, StatusResponse } from "@shared/types/status";

const STATUS_SECTION_MESSAGES: Partial<Record<keyof StatusResponse["sectionErrors"], string>> = {
  dependencyHealth: "Dependency health unavailable.",
  reserveComposition: "Reserve composition overview unavailable.",
  scheduledSlots: "Scheduled slot diagnostics unavailable.",
  telegramBot: "Telegram bot diagnostics unavailable.",
};

export function getStatusSectionMessage(code: keyof StatusResponse["sectionErrors"]): string {
  return STATUS_SECTION_MESSAGES[code] ?? "Status section unavailable.";
}

type DataQualitySourceKey = DataQuality["sourceFailures"][number]["source"];

const SOURCE_FAILURE_MESSAGES: Record<DataQualitySourceKey, string> = {
  "active-depegs": "Active depeg metrics unavailable.",
  "blacklist-gaps": "Blacklist gap metrics unavailable.",
  "onchain-supply": "Onchain supply diagnostics unavailable.",
  "stablecoins-cache": "Stablecoins cache unavailable.",
};

export function getSourceFailureMessage(source: DataQualitySourceKey): string {
  return SOURCE_FAILURE_MESSAGES[source];
}
