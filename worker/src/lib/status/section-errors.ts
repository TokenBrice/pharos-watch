import type { StatusResponse } from "@shared/types/status";

const STATUS_SECTION_MESSAGES: Partial<Record<keyof StatusResponse["sectionErrors"], string>> = {
  reserveComposition: "Reserve composition overview unavailable.",
  telegramBot: "Telegram bot diagnostics unavailable.",
};

export function getStatusSectionMessage(code: keyof StatusResponse["sectionErrors"]): string {
  return STATUS_SECTION_MESSAGES[code] ?? "Status section unavailable.";
}
