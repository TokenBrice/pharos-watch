import { formatLongDate } from "@shared/lib/format";

export function formatPublishedDate(iso: string): string {
  return formatLongDate(new Date(`${iso}T00:00:00Z`), { utc: true });
}
