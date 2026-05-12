import type { ReportCardDetailItem } from "../types";

function formatReportCardDetailItem(item: ReportCardDetailItem): string {
  if (!item.detail) return `${item.label}: ${item.value}`;
  if (item.detail === item.value || item.detail.startsWith(`${item.label}: `)) {
    return item.detail;
  }
  return `${item.label}: ${item.value} (${item.detail})`;
}

export function joinReportCardDetail(items: readonly ReportCardDetailItem[]): string {
  return items.map(formatReportCardDetailItem).join(". ");
}
