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

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

export function detailItemsFromParts(parts: readonly string[]): ReportCardDetailItem[] {
  return parts.map((part) => {
    const separator = part.indexOf(": ");
    if (separator === -1) return { label: "Detail", value: part, detail: part };
    return {
      label: part.slice(0, separator),
      value: part.slice(separator + 2),
      detail: part,
    };
  });
}
