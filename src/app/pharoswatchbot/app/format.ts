// Hoisted so render paths (StatusPanel) don't re-allocate the formatter on every render.
const HEALTH_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function formatSnoozePill(snoozeUntilTs: number): string {
  const date = new Date(snoozeUntilTs * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function formatTime(ts: number | null): string {
  if (ts == null) return "Not recorded";
  return HEALTH_TIME_FORMATTER.format(new Date(ts * 1000));
}

export function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "--";
  return `${String(hour).padStart(2, "0")}:00`;
}
