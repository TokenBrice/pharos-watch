import type { ReportCardDetailItem } from "../types";

export function joinReportCardDetail(items: readonly ReportCardDetailItem[]): string {
  return items.map((item) => item.detail ?? `${item.label}: ${item.value}`).join(". ");
}
